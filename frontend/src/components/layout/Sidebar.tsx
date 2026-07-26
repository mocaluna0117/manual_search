import { useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  HStack,
  IconButton,
  Input,
  Separator,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { CATEGORIES_QUERY, type Category } from '../../graphql/categories'
import { signOutRedirect } from '../../lib/auth'
import {
  CONVERSATIONS_QUERY,
  DELETE_CONVERSATION_MUTATION,
} from '../../graphql/chat'
import { ConnectionStatus } from '../ConnectionStatus'
import { UploadManualDialog } from '../manual/UploadManualDialog'

interface SidebarProps {
  selectedCategoryId: string | null
  selectedConversationId: string | null
  onSelectCategory: (category: Category | null) => void
  onSelectConversation: (conversationId: string) => void
  onSearch: (keyword: string) => void
}

export function Sidebar({
  selectedCategoryId,
  selectedConversationId,
  onSelectCategory,
  onSelectConversation,
  onSearch,
}: SidebarProps) {
  const auth = useAuth()
  const { data, loading } = useQuery(CATEGORIES_QUERY)
  const { data: chatData, loading: loadingChats } = useQuery(CONVERSATIONS_QUERY)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  const handleLogout = async () => {
    await auth.removeUser() // ブラウザ内のトークンを破棄
    signOutRedirect() // Cognito側のセッションも切ってログイン画面へ
  }

  const [deleteConversation] = useMutation(DELETE_CONVERSATION_MUTATION, {
    refetchQueries: ['Conversations'],
  })

  const handleSearch = () => {
    if (keyword.trim()) onSearch(keyword.trim())
  }

  const handleDeleteConversation = async (id: string, title: string) => {
    if (!window.confirm(`会話「${title}」を削除しますか？`)) return
    await deleteConversation({ variables: { id } })
    // 開いていた会話を消した場合はホームに戻す
    if (id === selectedConversationId) onSelectCategory(null)
  }

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
      <Button
        colorPalette="blue"
        variant="solid"
        size="sm"
        onClick={() => onSelectCategory(null)}
      >
        ＋ 新しいチャット
      </Button>

      {/* キーワード検索(AI検索と別の、従来型の検索) */}
      <Input
        size="sm"
        placeholder="🔍 マニュアル名・内容で検索"
        bg="gray.800"
        borderColor="gray.600"
        _placeholder={{ color: 'gray.400' }}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSearch()
        }}
      />

      {/* チャット履歴(DBから取得) */}
      <Box flex="1" overflowY="auto">
        <Text fontSize="xs" color="gray.400" mb={2}>
          チャット履歴
        </Text>
        {loadingChats && <Spinner size="sm" />}
        {chatData && chatData.conversations.length === 0 && (
          <Text fontSize="sm" color="gray.500">
            履歴はまだありません
          </Text>
        )}
        <VStack gap={1} align="stretch">
          {chatData?.conversations.map((conversation) => (
            <HStack key={conversation.id} gap={0} className="group">
              <Button
                variant="ghost"
                size="sm"
                flex="1"
                justifyContent="flex-start"
                color="gray.100"
                bg={
                  conversation.id === selectedConversationId
                    ? 'gray.700'
                    : undefined
                }
                _hover={{ bg: 'gray.700' }}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                display="block"
                textAlign="left"
                onClick={() => onSelectConversation(conversation.id)}
              >
                {conversation.title}
              </Button>
              <IconButton
                aria-label="会話を削除"
                size="xs"
                variant="ghost"
                color="gray.500"
                _hover={{ color: 'red.400', bg: 'gray.700' }}
                onClick={() =>
                  handleDeleteConversation(conversation.id, conversation.title)
                }
              >
                🗑
              </IconButton>
            </HStack>
          ))}
        </VStack>

        <Separator my={4} borderColor="gray.700" />

        {/* カテゴリ別マニュアル(DBから取得) */}
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
              bg={category.id === selectedCategoryId ? 'gray.700' : undefined}
              _hover={{ bg: 'gray.700' }}
              onClick={() => onSelectCategory(category)}
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

      {/* 下部: ログインユーザーと疎通ステータス */}
      <Box>
        <Text fontSize="xs" color="gray.400" mb={1} truncate>
          👤 {auth.user?.profile.email}
        </Text>
        <HStack justify="space-between">
          <ConnectionStatus />
          <Button
            size="xs"
            variant="ghost"
            color="gray.400"
            _hover={{ bg: 'gray.700' }}
            onClick={() => void handleLogout()}
          >
            ログアウト
          </Button>
        </HStack>
      </Box>
    </VStack>
  )
}
