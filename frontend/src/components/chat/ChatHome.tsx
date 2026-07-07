import { Button, Heading, HStack, Input, Text, VStack } from '@chakra-ui/react'
import { useState } from 'react'

/** チャット開始前のホーム画面（中央に検索欄を置くChatGPT風の空状態） */
export function ChatHome() {
  const [input, setInput] = useState('')

  const handleSubmit = () => {
    if (!input.trim()) return
    // TODO: 次のステップでGraphQL経由のRAG検索につなぐ
    console.log('検索:', input)
  }

  return (
    <VStack h="100%" justify="center" gap={6} px={4}>
      <Heading size="2xl">社内マニュアル検索</Heading>
      <Text color="gray.500">
        知りたいことを入力すると、AIが最適なマニュアルを案内します
      </Text>

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
        <Button size="lg" colorPalette="blue" onClick={handleSubmit}>
          検索
        </Button>
      </HStack>
    </VStack>
  )
}
