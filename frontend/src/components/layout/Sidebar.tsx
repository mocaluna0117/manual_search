import { useQuery } from '@apollo/client/react'
import { Box, Button, Separator, Spinner, Text, VStack } from '@chakra-ui/react'
import { useState } from 'react'
import { CATEGORIES_QUERY } from '../../graphql/categories'
import { ConnectionStatus } from '../ConnectionStatus'
import { UploadManualDialog } from '../manual/UploadManualDialog'

// TODO: チャット履歴も後でGraphQLから取得する
const dummyChats = ['経費精算のやり方を教えて', 'VPNに接続できないときは']

export function Sidebar() {
  const { data, loading } = useQuery(CATEGORIES_QUERY)
  const [uploadOpen, setUploadOpen] = useState(false)

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

        {/* カテゴリ別マニュアル（DBから取得） */}
        <Text fontSize="xs" color="gray.400" mb={2}>
          マニュアル（カテゴリ別）
        </Text>
        {loading && <Spinner size="sm" />}
        {data && data.manualCategories.length === 0 && (
          <Text fontSize="sm" color="gray.500">
            カテゴリはまだありません
          </Text>
        )}
        <VStack gap={1} align="stretch">
          {data?.manualCategories.map((category) => (
            <Button
              key={category.id}
              variant="ghost"
              size="sm"
              justifyContent="flex-start"
              color="gray.100"
              _hover={{ bg: 'gray.700' }}
            >
              📁 {category.name}
            </Button>
          ))}
        </VStack>
      </Box>

      {/* マニュアル追加(後で管理者のみに制限する) */}
      <Button
        variant="outline"
        size="sm"
        color="gray.100"
        borderColor="gray.600"
        _hover={{ bg: 'gray.700' }}
        onClick={() => setUploadOpen(true)}
      >
        📄 マニュアルを追加
      </Button>
      <UploadManualDialog open={uploadOpen} onClose={() => setUploadOpen(false)} />

      {/* 下部: 開発用の疎通ステータス */}
      <Box>
        <ConnectionStatus />
      </Box>
    </VStack>
  )
}
