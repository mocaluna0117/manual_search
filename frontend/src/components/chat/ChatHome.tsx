import { useMutation, useQuery } from '@apollo/client/react'
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
import {
  ASK_MUTATION,
  CONVERSATION_QUERY,
  type ChatMessage,
} from '../../graphql/chat'
import { useManualViewer } from '../manual/ManualViewerProvider'
import { MarkdownText } from './MarkdownText'

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
interface CitationGroup {
  manualId: string
  title: string
  topPage: number | null // 最も関連度が高いページ(タイトルクリック時に開く)
  pages: number[] // ページリンク一覧(昇順)
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
    if (citation.pageNumber != null && !group.pages.includes(citation.pageNumber)) {
      group.pages.push(citation.pageNumber)
    }
  }
  for (const group of groups) group.pages.sort((a, b) => a - b)
  return groups
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
  const [attachedImage, setAttachedImage] = useState<File | null>(null)
  // 選択肢の下に常設する「その他」インライン入力欄の内容
  const [otherText, setOtherText] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
  })
  useEffect(() => {
    if (conversationData) {
      justLoadedHistoryRef.current = true
      setMessages(conversationData.conversation.messages)
    }
  }, [conversationData])

  // 会話が見つからない(削除済み等)ならホームに戻してもらう
  useEffect(() => {
    if (conversationError && conversationId) {
      onConversationNotFound?.()
    }
  }, [conversationError, conversationId, onConversationNotFound])

  const [ask, { loading }] = useMutation(ASK_MUTATION, {
    // 新規会話ができたらサイドバーの履歴一覧を更新する
    refetchQueries: ['Conversations'],
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
  const send = async (question: string) => {
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
        imageUrl: image ? URL.createObjectURL(image) : undefined,
      },
    ])

    try {
      const { data } = await ask({
        variables: {
          question,
          conversationId: conversationId ?? undefined,
          imageBase64: image ? await fileToBase64(image) : undefined,
          imageFormat: image ? ALLOWED_IMAGE_TYPES[image.type] : undefined,
        },
      })
      if (!data) return
      setMessages((prev) => [...prev, data.askQuestion.message])
      // 新規チャットだった場合、できあがった会話IDをAppに知らせる
      if (!conversationId) {
        onConversationCreated(data.askQuestion.conversationId)
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'ASSISTANT',
          content: `エラーが発生しました: ${e instanceof Error ? e.message : '不明なエラー'}`,
          citations: [],
          options: [],
        },
      ])
    }
  }

  const handleSubmit = () => void send(input.trim())

  const searchInput = (
    <VStack w="100%" maxW="640px" gap={2} align="stretch">
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
          <Text fontSize="xs" color="gray.500">
            {attachedImage.name}
          </Text>
          <IconButton
            aria-label="添付を取り消す"
            size="xs"
            variant="ghost"
            onClick={() => setAttachedImage(null)}
          >
            ✕
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
        <IconButton
          aria-label="画像を添付"
          size="lg"
          variant="outline"
          borderRadius="full"
          fontSize="xl"
          color="gray.600"
          alignSelf="flex-end" // 入力欄が伸びても下端に揃える
          onClick={() => fileInputRef.current?.click()}
        >
          ＋
        </IconButton>
        <Textarea
          ref={textareaRef}
          size="lg"
          rows={1}
          autoresize // 入力量に応じて高さが自動で伸びる
          maxH="10em" // 伸びすぎ防止(超えたら内部スクロール)
          placeholder="例: 経費精算のやり方を教えて（Shift+Enterで改行）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter=送信 / Shift+Enter=改行 / 日本語変換の確定Enterは無視
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault() // 送信時に改行が入らないように
              handleSubmit()
            }
          }}
        />
        <Button
          size="lg"
          colorPalette="blue"
          onClick={handleSubmit}
          loading={loading}
          alignSelf="flex-end" // 入力欄が伸びてもボタンは下端に揃える
        >
          検索
        </Button>
      </HStack>
    </VStack>
  )

  // 質問前(新規チャット): 中央に大きく検索欄(ChatGPT風の空状態)
  if (messages.length === 0 && !loadingHistory) {
    return (
      <VStack h="100%" justify="center" gap={6} px={4}>
        <Heading size="2xl">社内マニュアル検索</Heading>
        <Text color="gray.500">
          知りたいことを入力すると、AIが最適なマニュアルを案内します
        </Text>
        {searchInput}
      </VStack>
    )
  }

  // スレッド表示 + 下部に入力欄
  return (
    <VStack h="100%" gap={0}>
      <Box flex="1" w="100%" overflowY="auto" px={4} py={6}>
        <VStack maxW="640px" mx="auto" gap={4} align="stretch">
          {loadingHistory && <Spinner alignSelf="center" />}

          {messages.map((message, index) => (
            <Box
              key={message.id}
              ref={index === messages.length - 1 ? lastMessageRef : undefined}
              style={{ scrollMarginTop: '12px' }} // 先頭に合わせた時に少し余白を残す
              alignSelf={message.role === 'USER' ? 'flex-end' : 'flex-start'}
              bg={message.role === 'USER' ? 'blue.500' : 'gray.100'}
              color={message.role === 'USER' ? 'white' : 'gray.900'}
              px={4}
              py={2}
              borderRadius="lg"
              maxW="85%"
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
                <Text whiteSpace="pre-wrap">{message.content}</Text>
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
                      bg="white"
                      justifyContent="flex-start"
                      whiteSpace="normal"
                      h="auto"
                      py={2}
                      disabled={loading}
                      onClick={() => void send(option)}
                    >
                      {option}
                    </Button>
                  ))}
                  {/* どれにも当てはまらない人向け: 常設のインライン入力欄
                      (最新のメッセージにだけ表示) */}
                  {index === messages.length - 1 && (
                    <HStack gap={2}>
                      <Input
                        size="sm"
                        bg="white"
                        placeholder="✏️ その他（自由に入力してEnterで送信）"
                        value={otherText}
                        onChange={(e) => setOtherText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            void send(otherText.trim())
                          }
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
                      bg="white"
                      borderRadius="md"
                      px={3}
                      py={2}
                    >
                      <Text
                        fontWeight="medium"
                        color="blue.600"
                        cursor="pointer"
                        _hover={{ textDecoration: 'underline' }}
                        onClick={() =>
                          openManual(group.manualId, group.title, group.topPage)
                        }
                      >
                        📄 {group.title} ↗
                      </Text>
                      {group.pages.length > 0 && (
                        <HStack mt={1} gap={1} flexWrap="wrap">
                          {group.pages.map((page) => (
                            <Button
                              key={page}
                              size="2xs"
                              variant="outline"
                              colorPalette="blue"
                              onClick={() =>
                                openManual(group.manualId, group.title, page)
                              }
                            >
                              p.{page}
                            </Button>
                          ))}
                        </HStack>
                      )}
                    </Box>
                  ))}
                </VStack>
              )}
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
