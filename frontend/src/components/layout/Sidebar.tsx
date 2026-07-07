import { Box, Button, Separator, Text, VStack } from '@chakra-ui/react'
import { ConnectionStatus } from '../ConnectionStatus'

// TODO: 後でGraphQLから取得する。今は見た目確認用のダミーデータ
const dummyChats = ['経費精算のやり方を教えて', 'VPNに接続できないときは']
const dummyCategories = ['総務', '経理', '情報システム', '人事']

export function Sidebar() {
  return (
    <VStack
      as="nav"
      w="260px"
      h="100vh"
      p={3}
      gap={4}
      align="stretch"
      bg="gray.900"
      color="gray.100"
      // スマホでは非表示、md(768px)以上で表示
      display={{ base: 'none', md: 'flex' }}
    >
      <Button colorPalette="blue" variant="solid" size="sm">
        ＋ 新しいチャット
      </Button>

      {/* チャット履歴 */}
      <Box flex="1" overflowY="auto">
        <Text fontSize="xs" color="gray.400" mb={2}>
          チャット履歴
        </Text>
        <VStack gap={1} align="stretch">
          {dummyChats.map((title) => (
            <Button
              key={title}
              variant="ghost"
              size="sm"
              justifyContent="flex-start"
              color="gray.100"
              _hover={{ bg: 'gray.700' }}
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              display="block"
              textAlign="left"
            >
              {title}
            </Button>
          ))}
        </VStack>

        <Separator my={4} borderColor="gray.700" />

        {/* カテゴリ別マニュアル */}
        <Text fontSize="xs" color="gray.400" mb={2}>
          マニュアル（カテゴリ別）
        </Text>
        <VStack gap={1} align="stretch">
          {dummyCategories.map((name) => (
            <Button
              key={name}
              variant="ghost"
              size="sm"
              justifyContent="flex-start"
              color="gray.100"
              _hover={{ bg: 'gray.700' }}
            >
              📁 {name}
            </Button>
          ))}
        </VStack>
      </Box>

      {/* 下部: 開発用の疎通ステータス */}
      <Box>
        <ConnectionStatus />
      </Box>
    </VStack>
  )
}
