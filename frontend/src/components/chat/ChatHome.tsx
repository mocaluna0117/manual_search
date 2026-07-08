import { useLazyQuery } from '@apollo/client/react'
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
import { RAG_SEARCH_QUERY, type RagCitation } from '../../graphql/rag'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  citations?: RagCitation[]
}

/** AI検索のチャット画面。質問前は中央に検索欄、質問後はスレッド表示 */
export function ChatHome() {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  const [search, { loading }] = useLazyQuery(RAG_SEARCH_QUERY, {
    // 同じ質問でも毎回サーバーに聞き直す(会話なので)
    fetchPolicy: 'no-cache',
  })

  // メッセージが増えたら一番下まで自動スクロール
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const handleSubmit = async () => {
    const question = input.trim()
    if (!question || loading) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: question }])

    const { data, error } = await search({ variables: { question } })
    setMessages((prev) => [
      ...prev,
      data
        ? {
            role: 'assistant',
            content: data.ragSearch.answer,
            citations: data.ragSearch.citations,
          }
        : {
            role: 'assistant',
            content: `エラーが発生しました: ${error?.message ?? '不明なエラー'}`,
          },
    ])
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

  // 質問前: 中央に大きく検索欄(ChatGPT風の空状態)
  if (messages.length === 0) {
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

  // 質問後: スレッド表示 + 下部に入力欄
  return (
    <VStack h="100%" gap={0}>
      <Box flex="1" w="100%" overflowY="auto" px={4} py={6}>
        <VStack maxW="640px" mx="auto" gap={4} align="stretch">
          {messages.map((message, i) => (
            <Box
              key={i}
              alignSelf={message.role === 'user' ? 'flex-end' : 'flex-start'}
              bg={message.role === 'user' ? 'blue.500' : 'gray.100'}
              color={message.role === 'user' ? 'white' : 'gray.900'}
              px={4}
              py={2}
              borderRadius="lg"
              maxW="85%"
            >
              <Text whiteSpace="pre-wrap">{message.content}</Text>

              {/* 根拠マニュアル(引用)があれば下に並べる */}
              {message.citations && message.citations.length > 0 && (
                <VStack mt={2} gap={1} align="stretch">
                  {message.citations.map((citation) => (
                    <Box
                      key={citation.manualId}
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

      <Box w="100%" borderTopWidth="1px" p={4} display="flex" justifyContent="center">
        {searchInput}
      </Box>
    </VStack>
  )
}
