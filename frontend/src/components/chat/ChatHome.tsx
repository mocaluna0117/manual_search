import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  Heading,
  HStack,
  IconButton,
  Image,
  Input,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useEffect, useRef, useState } from 'react'
import {
  ASK_MUTATION,
  CONVERSATION_QUERY,
  type ChatMessage,
} from '../../graphql/chat'
import { MANUAL_DOWNLOAD_URL_QUERY } from '../../graphql/manuals'

interface ChatHomeProps {
  /** nullなら新規チャット。IDがあれば既存の会話を読み込んで続きから */
  conversationId: string | null
  /** 新規チャットの最初の回答が返り、会話がDBにできたときに呼ばれる */
  onConversationCreated: (id: string) => void
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
}: ChatHomeProps) {
  const [input, setInput] = useState('')
  // サーバーに保存済みのメッセージ + 送信中の楽観的な表示をまとめて持つ
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [attachedImage, setAttachedImage] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 既存の会話を開いた場合は履歴をDBから読み込む
  const { data: conversationData, loading: loadingHistory } = useQuery(
    CONVERSATION_QUERY,
    {
      variables: { id: conversationId ?? '' },
      skip: !conversationId,
      fetchPolicy: 'cache-and-network',
    },
  )
  useEffect(() => {
    if (conversationData) {
      setMessages(conversationData.conversation.messages)
    }
  }, [conversationData])

  const [ask, { loading }] = useMutation(ASK_MUTATION, {
    // 新規会話ができたらサイドバーの履歴一覧を更新する
    refetchQueries: ['Conversations'],
  })

  // 引用カードからPDFを開く(署名付きURLは期限があるので毎回取り直す)
  const [fetchDownloadUrl] = useLazyQuery(MANUAL_DOWNLOAD_URL_QUERY, {
    fetchPolicy: 'no-cache',
  })

  const handleOpenManual = async (manualId: string) => {
    const { data, error } = await fetchDownloadUrl({ variables: { id: manualId } })
    if (data) {
      window.open(data.manualDownloadUrl, '_blank')
    } else if (error) {
      // 引用は回答時点のスナップショットなので、その後削除されていることがある
      window.alert('このマニュアルは削除された可能性があり、開けませんでした')
    }
  }

  // メッセージが増えたら一番下まで自動スクロール
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
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

  const handleSubmit = async () => {
    const question = input.trim()
    if (!question || loading) return
    const image = attachedImage
    setInput('')
    setAttachedImage(null)

    // まず自分の発言を即表示(楽観的更新)。IDは仮でよい
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: 'USER',
        content: question,
        citations: [],
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
        },
      ])
    }
  }

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
          onClick={() => fileInputRef.current?.click()}
        >
          📷
        </IconButton>
        <Input
          size="lg"
          placeholder="例: 経費精算のやり方を教えて"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 日本語変換の確定Enterでは送信しない
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSubmit()
          }}
        />
        <Button
          size="lg"
          colorPalette="blue"
          onClick={handleSubmit}
          loading={loading}
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

          {messages.map((message) => (
            <Box
              key={message.id}
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
              <Text whiteSpace="pre-wrap">{message.content}</Text>

              {/* 根拠マニュアル(引用)。クリックでPDFが開く */}
              {message.citations.length > 0 && (
                <VStack mt={2} gap={1} align="stretch">
                  {message.citations.map((citation, i) => (
                    <Box
                      key={`${citation.manualId}-${i}`}
                      fontSize="sm"
                      bg="white"
                      borderRadius="md"
                      px={3}
                      py={2}
                      cursor="pointer"
                      _hover={{ bg: 'blue.50' }}
                      onClick={() => void handleOpenManual(citation.manualId)}
                    >
                      <Text fontWeight="medium" color="blue.600">
                        📄 {citation.title} ↗
                      </Text>
                      <Text color="gray.500" lineClamp={2}>
                        {citation.snippet}
                      </Text>
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
