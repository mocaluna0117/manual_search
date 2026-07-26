import { useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  Heading,
  HStack,
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

interface ChatHomeProps {
  /** nullなら新規チャット。IDがあれば既存の会話を読み込んで続きから */
  conversationId: string | null
  /** 新規チャットの最初の回答が返り、会話がDBにできたときに呼ばれる */
  onConversationCreated: (id: string) => void
}

/** AI検索のチャット画面。質問前は中央に検索欄、質問後はスレッド表示 */
export function ChatHome({
  conversationId,
  onConversationCreated,
}: ChatHomeProps) {
  const [input, setInput] = useState('')
  // サーバーに保存済みのメッセージ + 送信中の楽観的な表示をまとめて持つ
  const [messages, setMessages] = useState<ChatMessage[]>([])
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

  // メッセージが増えたら一番下まで自動スクロール
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const handleSubmit = async () => {
    const question = input.trim()
    if (!question || loading) return
    setInput('')
    // まず自分の発言を即表示(楽観的更新)。IDは仮でよい
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'USER', content: question, citations: [] },
    ])

    try {
      const { data } = await ask({
        variables: { question, conversationId: conversationId ?? undefined },
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
    <HStack w="100%" maxW="640px" gap={2}>
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
              <Text whiteSpace="pre-wrap">{message.content}</Text>

              {/* 根拠マニュアル(引用)があれば下に並べる */}
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
                    >
                      📄 {citation.title}
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
