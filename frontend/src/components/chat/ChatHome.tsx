import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  Heading,
  HStack,
  IconButton,
  Input,
  Image,
  Spinner,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useEffect, useRef, useState } from 'react'
import { FcFile } from 'react-icons/fc'
import {
  LuCheck,
  LuCircleStop,
  LuCopy,
  LuExternalLink,
  LuImagePlus,
  LuMessageSquareText,
  LuPencil,
  LuX,
} from 'react-icons/lu'
import {
  ASK_MUTATION,
  CONVERSATION_QUERY,
  type ChatMessage,
} from '../../graphql/chat'
import { ME_QUERY } from '../../graphql/me'
import { useSendKey } from '../../lib/settings'
import { useManualViewer } from '../manual/ManualViewerProvider'
import { MarkdownText } from './MarkdownText'
import { splitLeadingIcon, withInlineIcons } from './MessageIcons'
import { PromptTemplateMenu } from './PromptTemplateMenu'

interface ChatHomeProps {
  /** nullなら新規チャット。IDがあれば既存の会話を読み込んで続きから */
  conversationId: string | null
  /** 新規チャットの最初の回答が返り、会話がDBにできたときに呼ばれる */
  onConversationCreated: (id: string) => void
  /** 会話が見つからなかった(削除済み・他ユーザーのもの)ときに呼ばれる */
  onConversationNotFound?: () => void
}

// 表示用: サーバーのメッセージ + 送信時だけ持つ画像プレビューURL
type LocalMessage = ChatMessage & { imageUrl?: string }

const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4MB
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// 引用をマニュアル単位にまとめる(同じマニュアルの複数ページを1カードに集約)
interface PageLink {
  page: number
  label: string // ページの見出し(チャンク先頭から推定した短いラベル)
  snippet: string // ホバー時のツールチップ用(もう少し長い抜粋)
}

interface CitationGroup {
  manualId: string
  title: string
  topPage: number | null // 最も関連度が高いページ(タイトルクリック時に開く)
  pages: PageLink[] // ページリンク一覧(昇順)
}

/** チャンク抜粋の先頭から「見出しらしき部分」を短く取り出す */
function pageLabel(snippet: string): string {
  const firstLine = snippet.split('\n')[0] ?? ''
  // 先頭の章番号や記号(「3 」「1.2 」「【」など)を落として本文の言葉から始める
  const cleaned = firstLine.replace(/^[\d\s.．)）\-【】#*]+/, '').trim()
  // 短すぎると「STEP5…」のように何の項目か分からないので、ある程度長めに見せる
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned
}

function groupCitations(
  citations: ChatMessage['citations'],
): CitationGroup[] {
  const groups: CitationGroup[] = []
  const byId = new Map<string, CitationGroup>()
  for (const citation of citations) {
    let group = byId.get(citation.manualId)
    if (!group) {
      group = {
        manualId: citation.manualId,
        title: citation.title,
        topPage: citation.pageNumber,
        pages: [],
      }
      byId.set(citation.manualId, group)
      groups.push(group)
    }
    if (
      citation.pageNumber != null &&
      !group.pages.some((p) => p.page === citation.pageNumber)
    ) {
      group.pages.push({
        page: citation.pageNumber,
        label: pageLabel(citation.snippet),
        snippet: citation.snippet,
      })
    }
  }
  for (const group of groups) group.pages.sort((a, b) => a.page - b.page)
  return groups
}

/** 発言時刻の表示。今日なら「14:32」、それ以外は「8/12 14:32」 */
function formatChatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

/** File → base64文字列(data:プレフィックスを除いた本体) */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',', 2)[1] ?? '')
    }
    reader.onerror = () => reject(new Error('画像を読み込めませんでした'))
    reader.readAsDataURL(file)
  })
}

/** AI検索のチャット画面。質問前は中央に検索欄、質問後はスレッド表示 */
export function ChatHome({
  conversationId,
  onConversationCreated,
  onConversationNotFound,
}: ChatHomeProps) {
  // 入力途中の内容を会話ごとの「下書き」として保存し、リロード後も復元する
  const draftKey = `manualSearch.draft.${conversationId ?? 'new'}`
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    try {
      if (input) localStorage.setItem(draftKey, input)
      else localStorage.removeItem(draftKey) // 送信・クリアしたら下書きも消す
    } catch {
      // ストレージが使えない環境では黙って諦める(機能自体は動く)
    }
  }, [input, draftKey])
  // サーバーに保存済みのメッセージ + 送信中の楽観的な表示をまとめて持つ
  const [messages, setMessages] = useState<LocalMessage[]>([])
  // 「〜を開始しました」で終わっている=裏で処理が走っていて、
  // 完了メッセージが後から届く状態(その間だけ会話を取り直す)
  const lastMessage = messages[messages.length - 1]
  const waitingForBackgroundJob =
    lastMessage?.role === 'ASSISTANT' &&
    lastMessage.content.includes('再分類を開始しました')
  const [attachedImage, setAttachedImage] = useState<File | null>(null)
  // 選択肢の下に常設する「その他」インライン入力欄の内容
  const [otherText, setOtherText] = useState('')
  // コピー直後のフィードバック表示(✓)に使う。対象メッセージのIDを持つ
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 送信中のリクエストを「停止」ボタンから中断するためのコントローラ
  const abortRef = useRef<AbortController | null>(null)
  // 設定: Enterで送信(既定) / Shift+Enterで送信
  const sendKey = useSendKey()
  const sendOnPlainEnter = sendKey === 'enter'
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastMessageRef = useRef<HTMLDivElement>(null)
  // 履歴を開いた直後かどうか(そのときだけ一番下へ即時ジャンプする)
  const justLoadedHistoryRef = useRef(false)

  // 既存の会話を開いた場合は履歴をDBから読み込む
  const {
    data: conversationData,
    loading: loadingHistory,
    error: conversationError,
  } = useQuery(CONVERSATION_QUERY, {
    variables: { id: conversationId ?? '' },
    skip: !conversationId,
    fetchPolicy: 'cache-and-network',
    // 再分類のような裏で走る処理は、完了メッセージが後から会話に書き込まれる。
    // 待っている間だけ会話を取り直して、開いたままでも結果が出るようにする
    pollInterval: waitingForBackgroundJob ? 5000 : 0,
  })
  const apolloClient = useApolloClient()
  useEffect(() => {
    if (conversationData) {
      justLoadedHistoryRef.current = true
      const messages = conversationData.conversation.messages
      setMessages(messages)
      // バックグラウンドの再分類が完了していたら、フォルダ/マニュアル一覧の
      // キャッシュを取り直す(完了メッセージは会話を開いたときに届くため)
      const last = messages[messages.length - 1]
      if (last?.role === 'ASSISTANT' && last.content.includes('再分類が完了')) {
        void apolloClient.refetchQueries({
          include: ['ManualCategories', 'Manuals'],
        })
      }
    }
  }, [conversationData, apolloClient])

  // 会話が見つからない(削除済み等)ならホームに戻してもらう
  useEffect(() => {
    if (conversationError && conversationId) {
      onConversationNotFound?.()
    }
  }, [conversationError, conversationId, onConversationNotFound])

  // 管理者はチャットからフォルダ作成・再分類ができるため、その結果を
  // カテゴリ一覧・マニュアル一覧(表示中のもの)にも反映する。一般ユーザーは
  // カテゴリが変わることがないので余計な再取得をしない
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const [ask, { loading }] = useMutation(ASK_MUTATION, {
    refetchQueries: isAdmin
      ? ['Conversations', 'ManualCategories', 'Manuals']
      : ['Conversations'],
  })

  // 引用カードからアプリ内ビューアでPDFを開く
  const { openManual } = useManualViewer()

  // スクロール制御:
  // - 履歴を開いた直後: 一番下へ即時ジャンプ(続きから読む位置)
  // - AIの回答が届いた: 回答の「先頭」に合わせる(長い回答を頭から読めるように)
  // - それ以外(自分の送信・考え中): 一番下へ
  useEffect(() => {
    if (justLoadedHistoryRef.current) {
      justLoadedHistoryRef.current = false
      bottomRef.current?.scrollIntoView() // 履歴表示はアニメ無しで一気に
      return
    }
    const last = messages[messages.length - 1]
    if (!loading && last?.role === 'ASSISTANT') {
      lastMessageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, loading])

  const handleAttach = (file: File | null) => {
    if (!file) return
    if (!(file.type in ALLOWED_IMAGE_TYPES)) {
      window.alert('PNG / JPEG / WebP / GIF の画像を選択してください')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      window.alert('画像は4MB以下にしてください')
      return
    }
    setAttachedImage(file)
  }

  /** 質問を送る。入力欄からの送信・選択肢ボタン・その他入力のすべてから使う */
  const send = async (rawQuestion: string) => {
    // 画像だけでも送れるようにする(質問文が無いときは既定の問いかけを補う。
    // 履歴が空欄にならず、AIにも「画像について聞かれている」と伝わる)
    const question =
      rawQuestion || (attachedImage ? 'この画像について教えてください' : '')
    if (!question || loading) return
    const image = attachedImage
    setInput('')
    setAttachedImage(null)
    setOtherText('')

    // まず自分の発言を即表示(楽観的更新)。IDは仮でよい
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: 'USER',
        content: question,
        citations: [],
        options: [],
        createdAt: new Date().toISOString(),
        imageUrl: image ? URL.createObjectURL(image) : undefined,
      },
    ])

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const { data } = await ask({
        variables: {
          question,
          conversationId: conversationId ?? undefined,
          imageBase64: image ? await fileToBase64(image) : undefined,
          imageFormat: image ? ALLOWED_IMAGE_TYPES[image.type] : undefined,
        },
        // 「停止」ボタンでHTTPリクエストごと中断できるようにする
        context: { fetchOptions: { signal: controller.signal } },
      })
      if (!data) return
      setMessages((prev) => [...prev, data.askQuestion.message])
      // 新規チャットだった場合、できあがった会話IDをAppに知らせる
      if (!conversationId) {
        onConversationCreated(data.askQuestion.conversationId)
      }
    } catch (e) {
      // 停止ボタンによる中断はエラー扱いにしない。
      // なおサーバー側の生成は止まらないため、回答自体は会話に保存され、
      // 会話を開き直すと表示される(それを短い一文で案内する)
      if (controller.signal.aborted) {
        setMessages((prev) => [
          ...prev,
          {
            id: `local-stop-${Date.now()}`,
            role: 'ASSISTANT',
            content:
              '⏹ 回答を停止しました。この質問は保存されていません。質問の編集ボタン(鉛筆マーク)から編集して再送信できます。',
            citations: [],
            options: [],
            createdAt: new Date().toISOString(),
          },
        ])
        return
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'ASSISTANT',
          content: `エラーが発生しました: ${e instanceof Error ? e.message : '不明なエラー'}`,
          citations: [],
          options: [],
          createdAt: new Date().toISOString(),
        },
      ])
    } finally {
      abortRef.current = null
    }
  }

  const handleSubmit = () => void send(input.trim())

  /** メッセージ本文をクリップボードへ(ドラッグ選択せずにコピーできるように) */
  const copyMessage = async (message: LocalMessage) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedId(message.id)
      setTimeout(
        () => setCopiedId((prev) => (prev === message.id ? null : prev)),
        1500,
      )
    } catch {
      window.alert('コピーできませんでした')
    }
  }

  /**
   * テンプレートを入力欄に差し込む。
   * 「〇〇」が含まれていればそこを選択状態にして、すぐ書き換えられるようにする
   */
  const insertTemplate = (body: string) => {
    setInput(body)
    const placeholder = body.indexOf('〇〇')
    // stateの反映後にカーソルを動かす必要があるので次のフレームで実行する
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      if (placeholder >= 0) {
        textarea.setSelectionRange(placeholder, placeholder + 2)
      } else {
        textarea.setSelectionRange(body.length, body.length)
      }
    })
  }

  /** 送信済みの質問を入力欄へ戻す(編集して再送信するため) */
  const editMessage = (message: LocalMessage) => {
    // DB保存時に付く画像添付の目印は編集対象から外す
    setInput(message.content.replace(/\n\(📷 画像を添付\)$/, ''))
    textareaRef.current?.focus()
  }

  const searchInput = (
    <VStack w="100%" maxW="800px" gap={2} align="stretch">
      {/* 添付中の画像プレビュー */}
      {attachedImage && (
        <HStack
          alignSelf="flex-start"
          gap={2}
          p={1}
          borderWidth="1px"
          borderRadius="md"
        >
          <Image
            src={URL.createObjectURL(attachedImage)}
            alt="添付画像"
            h="48px"
            borderRadius="sm"
          />
          <Text fontSize="xs" color="fg.muted">
            {attachedImage.name}
          </Text>
          <IconButton
            aria-label="添付を取り消す"
            size="xs"
            variant="ghost"
            onClick={() => setAttachedImage(null)}
          >
            <LuX />
          </IconButton>
        </HStack>
      )}

      <HStack gap={2}>
        {/* 画像添付(スクリーンショットを添えて質問できる) */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          onChange={(e) => {
            handleAttach(e.target.files?.[0] ?? null)
            e.target.value = '' // 同じファイルを選び直せるように
          }}
        />
        {/* 定型文(テンプレート)。選ぶと入力欄に入り、〇〇が選択状態になる */}
        <PromptTemplateMenu onSelect={insertTemplate}>
          <IconButton
            aria-label="よく使う質問から選ぶ"
            title="よく使う質問から選ぶ"
            size="lg"
            variant="outline"
            borderRadius="full"
            color="fg.muted"
            alignSelf="flex-end"
          >
            <LuMessageSquareText />
          </IconButton>
        </PromptTemplateMenu>
        <IconButton
          aria-label="画像を添付"
          size="lg"
          variant="outline"
          borderRadius="full"
          fontSize="xl"
          color="fg.muted"
          alignSelf="flex-end" // 入力欄が伸びても下端に揃える
          onClick={() => fileInputRef.current?.click()}
        >
          <LuImagePlus />
        </IconButton>
        <Textarea
          ref={textareaRef}
          size="lg"
          rows={1}
          autoresize // 入力量に応じて高さが自動で伸びる
          maxH="10em" // 伸びすぎ防止(超えたら内部スクロール)
          placeholder={
            sendOnPlainEnter
              ? '例: クイックパーツマニュアルを見せて（Shift+Enterで改行）'
              : '例: クイックパーツマニュアルを見せて（Shift+Enterで送信）'
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 日本語変換の確定Enterは無視。送信キーは設定で切り替え可能
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            const shouldSend = sendOnPlainEnter ? !e.shiftKey : e.shiftKey
            if (shouldSend) {
              e.preventDefault() // 送信時に改行が入らないように
              handleSubmit()
            }
          }}
        />
        {loading ? (
          // 送信中は「停止」に切り替える(待たされ続けないための逃げ道)
          <Button
            size="lg"
            colorPalette="red"
            variant="outline"
            onClick={() => abortRef.current?.abort()}
            alignSelf="flex-end"
          >
            <LuCircleStop /> 停止
          </Button>
        ) : (
          <Button
            size="lg"
            colorPalette="blue"
            onClick={handleSubmit}
            // 文章が無くても画像が添付されていれば送れる
            disabled={!input.trim() && !attachedImage}
            alignSelf="flex-end" // 入力欄が伸びてもボタンは下端に揃える
          >
            検索
          </Button>
        )}
      </HStack>
    </VStack>
  )

  // 質問前(新規チャット): 中央に大きく検索欄(ChatGPT風の空状態)
  if (messages.length === 0 && !loadingHistory) {
    return (
      <VStack h="100%" justify="center" gap={6} px={4} pt={{ base: 12, md: 0 }}>
        <Heading size="2xl">社内マニュアル検索</Heading>
        <Text color="fg.muted">
          知りたいことを入力すると、AIが最適なマニュアルを案内します
        </Text>
        {searchInput}
      </VStack>
    )
  }

  // スレッド表示 + 下部に入力欄
  return (
    <VStack h="100%" gap={0}>
      <Box
        flex="1"
        w="100%"
        overflowY="auto"
        // 縦だけautoにすると横は自動でautoになり、はみ出した瞬間に
        // スレッド全体が横スクロールしてしまうので明示的に抑える
        overflowX="hidden"
        px={4}
        py={6}
        pt={{ base: 14, md: 6 }}
      >
        <VStack maxW="800px" mx="auto" gap={4} align="stretch">
          {loadingHistory && <Spinner alignSelf="center" />}

          {messages.map((message, index) => (
            <Box
              key={message.id}
              ref={index === messages.length - 1 ? lastMessageRef : undefined}
              style={{ scrollMarginTop: '12px' }} // 先頭に合わせた時に少し余白を残す
              alignSelf={message.role === 'USER' ? 'flex-end' : 'flex-start'}
              bg={message.role === 'USER' ? 'blue.solid' : 'bg.muted'}
              color={message.role === 'USER' ? 'blue.contrast' : 'fg'}
              px={4}
              py={2}
              borderRadius="lg"
              maxW="85%"
              minW={0}
              // 区切りの無い長文でも吹き出しの外へ出さない
              // (継承されるので中の本文・選択肢・引用にも効く)
              overflowWrap="anywhere"
            >
              {/* 送信時に添付した画像(このセッション中のみ表示) */}
              {message.imageUrl && (
                <Image
                  src={message.imageUrl}
                  alt="添付画像"
                  maxH="160px"
                  borderRadius="md"
                  mb={2}
                />
              )}
              {/* AIの回答はMarkdownを整形表示、ユーザーの発言はそのまま */}
              {message.role === 'ASSISTANT' ? (
                <MarkdownText>{message.content}</MarkdownText>
              ) : (
                <Text whiteSpace="pre-wrap" overflowWrap="anywhere">
                  {withInlineIcons(message.content)}
                </Text>
              )}

              {/* 絞り込み質問の選択肢。クリックがそのまま回答になる */}
              {message.options.length > 0 && (
                <VStack mt={3} gap={2} align="stretch">
                  {message.options.map((option, i) => (
                    <Button
                      key={i}
                      size="sm"
                      variant="outline"
                      colorPalette="blue"
                      bg="bg.panel"
                      justifyContent="flex-start"
                      whiteSpace="normal"
                      h="auto"
                      py={2}
                      disabled={loading}
                      onClick={() => void send(option)}
                    >
                      {/* 「✅ はい」のような先頭の絵文字はアイコンで見せる。
                          送信する値(option)は変えない(サーバー側が文字列で照合するため) */}
                      {(() => {
                        const split = splitLeadingIcon(option)
                        return split ? (
                          <>
                            {split.icon}
                            {split.rest}
                          </>
                        ) : (
                          option
                        )
                      })()}
                    </Button>
                  ))}
                  {/* どれにも当てはまらない人向け: 常設のインライン入力欄
                      (最新のメッセージにだけ表示) */}
                  {index === messages.length - 1 && (
                    <HStack gap={2}>
                      <Input
                        size="sm"
                        bg="bg.panel"
                        placeholder={
                          sendOnPlainEnter
                            ? 'その他（自由に入力してEnterで送信）'
                            : 'その他（自由に入力してShift+Enterで送信）'
                        }
                        value={otherText}
                        onChange={(e) => setOtherText(e.target.value)}
                        onKeyDown={(e) => {
                          // 一行入力だが、送信キーの操作感はメイン入力欄と揃える
                          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                          if (!sendOnPlainEnter && !e.shiftKey) return
                          void send(otherText.trim())
                        }}
                      />
                      <Button
                        size="sm"
                        colorPalette="blue"
                        variant="outline"
                        disabled={!otherText.trim() || loading}
                        onClick={() => void send(otherText.trim())}
                      >
                        送信
                      </Button>
                    </HStack>
                  )}
                </VStack>
              )}

              {/* 根拠マニュアル(引用)。マニュアル単位に1カード、ページはリンクで並べる */}
              {message.citations.length > 0 && (
                <VStack mt={2} gap={1} align="stretch">
                  {groupCitations(message.citations).map((group) => (
                    <Box
                      key={group.manualId}
                      fontSize="sm"
                      bg="bg.panel"
                      borderRadius="md"
                      px={3}
                      py={2}
                    >
                      <HStack
                        gap={1}
                        fontWeight="medium"
                        color="blue.fg"
                        cursor="pointer"
                        _hover={{ textDecoration: 'underline' }}
                        onClick={() =>
                          openManual(group.manualId, group.title, group.topPage)
                        }
                      >
                        {/* 長いマニュアル名でもカードからはみ出さないよう、
                            アイコンは縮めず名前側だけを折り返す */}
                        <Box flexShrink={0} display="inline-flex">
                          <FcFile />
                        </Box>
                        <Text minW={0} overflowWrap="anywhere">
                          {group.title}
                        </Text>
                        <Box flexShrink={0} display="inline-flex">
                          <LuExternalLink size={12} />
                        </Box>
                      </HStack>
                      {group.pages.length > 0 && (
                        <HStack mt={1} gap={1} flexWrap="wrap">
                          {group.pages.map(({ page, label, snippet }) => (
                            <Button
                              key={page}
                              size="2xs"
                              variant="outline"
                              colorPalette="blue"
                              title={snippet} // ホバーで抜粋の続きが見える
                              onClick={() =>
                                openManual(group.manualId, group.title, page)
                              }
                            >
                              p.{page}
                              {label && (
                                <Text as="span" fontWeight="normal" ms={1}>
                                  {label}
                                </Text>
                              )}
                            </Button>
                          ))}
                        </HStack>
                      )}
                    </Box>
                  ))}
                </VStack>
              )}

              {/* メッセージ操作: 発言時刻 + コピー / (質問のみ)編集して再送信 */}
              <HStack mt={1} gap={0} justify="flex-end" align="center">
                <Text
                  fontSize="2xs"
                  me="auto"
                  pe={3}
                  opacity={0.75}
                  color={message.role === 'USER' ? 'blue.contrast' : 'fg.muted'}
                >
                  {formatChatTime(message.createdAt)}
                </Text>
                <IconButton
                  aria-label="コピー"
                  title="コピー"
                  size="2xs"
                  variant="ghost"
                  color={
                    message.role === 'USER' ? 'blue.contrast' : 'fg.muted'
                  }
                  onClick={() => void copyMessage(message)}
                >
                  {copiedId === message.id ? <LuCheck /> : <LuCopy />}
                </IconButton>
                {message.role === 'USER' && (
                  <IconButton
                    aria-label="編集して再送信"
                    title="編集して再送信"
                    size="2xs"
                    variant="ghost"
                    color="blue.contrast"
                    onClick={() => editMessage(message)}
                  >
                    <LuPencil />
                  </IconButton>
                )}
              </HStack>
            </Box>
          ))}

          {loading && <Spinner alignSelf="flex-start" />}
          <div ref={bottomRef} />
        </VStack>
      </Box>

      <Box
        w="100%"
        borderTopWidth="1px"
        p={4}
        display="flex"
        justifyContent="center"
      >
        {searchInput}
      </Box>
    </VStack>
  )
}
