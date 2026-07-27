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
import {
  CATEGORIES_QUERY,
  CREATE_CATEGORY_MUTATION,
  DELETE_CATEGORY_MUTATION,
  UPDATE_CATEGORY_MUTATION,
  type Category,
} from '../../graphql/categories'
import { signOutRedirect } from '../../lib/auth'
import {
  CONVERSATIONS_QUERY,
  DELETE_CONVERSATION_MUTATION,
} from '../../graphql/chat'
import { ME_QUERY } from '../../graphql/me'
import { ConnectionStatus } from '../ConnectionStatus'
import { UploadManualDialog } from '../manual/UploadManualDialog'

interface SidebarProps {
  selectedCategoryId: string | null
  selectedConversationId: string | null
  onSelectCategory: (category: Category | null) => void
  onSelectConversation: (conversationId: string) => void
  onSelectUncategorized: () => void
  onSearch: (keyword: string) => void
}

export function Sidebar({
  selectedCategoryId,
  selectedConversationId,
  onSelectCategory,
  onSelectConversation,
  onSelectUncategorized,
  onSearch,
}: SidebarProps) {
  const auth = useAuth()
  const { data, loading } = useQuery(CATEGORIES_QUERY)
  const { data: chatData, loading: loadingChats } = useQuery(CONVERSATIONS_QUERY)
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const [uploadOpen, setUploadOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  const handleLogout = async () => {
    await auth.removeUser() // ブラウザ内のトークンを破棄
    signOutRedirect() // Cognito側のセッションも切ってログイン画面へ
  }

  const [deleteConversation] = useMutation(DELETE_CONVERSATION_MUTATION, {
    refetchQueries: ['Conversations'],
  })

  // カテゴリ管理(ADMINのみUIに出る。本命の防御はバックエンド)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [createCategory] = useMutation(CREATE_CATEGORY_MUTATION, {
    refetchQueries: ['ManualCategories'],
  })
  const [deleteCategory] = useMutation(DELETE_CATEGORY_MUTATION, {
    refetchQueries: ['ManualCategories'],
  })

  const handleCreateCategory = async () => {
    const name = newCategoryName.trim()
    if (!name) return
    try {
      await createCategory({ variables: { name } })
      setNewCategoryName('')
      setAddingCategory(false)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'カテゴリを作成できませんでした')
    }
  }

  const handleDeleteCategory = async (category: Category) => {
    if (!window.confirm(`カテゴリ「${category.name}」を削除しますか？`)) return
    try {
      await deleteCategory({ variables: { id: category.id } })
      if (category.id === selectedCategoryId) onSelectCategory(null)
    } catch (e) {
      // マニュアルが残っている場合はバックエンドが理由を返してくる
      window.alert(e instanceof Error ? e.message : '削除できませんでした')
    }
  }

  // カテゴリ名のインライン編集
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [editingName, setEditingName] = useState('')
  const [updateCategory] = useMutation(UPDATE_CATEGORY_MUTATION, {
    refetchQueries: ['ManualCategories'],
  })

  const handleRenameCategory = async () => {
    if (!editingCategory) return
    const name = editingName.trim()
    if (!name || name === editingCategory.name) {
      setEditingCategory(null)
      return
    }
    try {
      await updateCategory({ variables: { id: editingCategory.id, name } })
      // 開いているカテゴリを改名した場合は、メイン画面の見出しも更新する
      if (editingCategory.id === selectedCategoryId) {
        onSelectCategory({ id: editingCategory.id, name })
      }
      setEditingCategory(null)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '名前を変更できませんでした')
    }
  }

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
        <HStack justify="space-between" mb={2}>
          <Text fontSize="xs" color="gray.400">
            マニュアル（カテゴリ別）
          </Text>
          {isAdmin && (
            <IconButton
              aria-label="カテゴリを追加"
              size="2xs"
              variant="ghost"
              color="gray.400"
              _hover={{ color: 'gray.100', bg: 'gray.700' }}
              onClick={() => setAddingCategory((v) => !v)}
            >
              ＋
            </IconButton>
          )}
        </HStack>

        {/* カテゴリ追加フォーム(＋を押すと出る) */}
        {addingCategory && (
          <Input
            size="sm"
            mb={2}
            autoFocus
            placeholder="カテゴリ名を入力してEnter"
            bg="gray.800"
            borderColor="gray.600"
            _placeholder={{ color: 'gray.400' }}
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                void handleCreateCategory()
              if (e.key === 'Escape') setAddingCategory(false)
            }}
          />
        )}

        {loading && <Spinner size="sm" />}
        {data && data.manualCategories.length === 0 && (
          <Text fontSize="sm" color="gray.500">
            カテゴリはまだありません
          </Text>
        )}
        <VStack gap={1} align="stretch">
          {data?.manualCategories.map((category) =>
            editingCategory?.id === category.id ? (
              // 編集モード: その場で名前を書き換える
              <Input
                key={category.id}
                size="sm"
                autoFocus
                bg="gray.800"
                borderColor="gray.600"
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={() => setEditingCategory(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                    void handleRenameCategory()
                  if (e.key === 'Escape') setEditingCategory(null)
                }}
              />
            ) : (
              <HStack key={category.id} gap={0}>
                <Button
                  variant="ghost"
                  size="sm"
                  flex="1"
                  justifyContent="flex-start"
                  color="gray.100"
                  bg={category.id === selectedCategoryId ? 'gray.700' : undefined}
                  _hover={{ bg: 'gray.700' }}
                  onClick={() => onSelectCategory(category)}
                >
                  📁 {category.name}
                </Button>
                {isAdmin && (
                  <>
                    <IconButton
                      aria-label="カテゴリ名を変更"
                      size="xs"
                      variant="ghost"
                      color="gray.500"
                      _hover={{ color: 'gray.100', bg: 'gray.700' }}
                      onClick={() => {
                        setEditingCategory(category)
                        setEditingName(category.name)
                      }}
                    >
                      ✏️
                    </IconButton>
                    <IconButton
                      aria-label="カテゴリを削除"
                      size="xs"
                      variant="ghost"
                      color="gray.500"
                      _hover={{ color: 'red.400', bg: 'gray.700' }}
                      onClick={() => void handleDeleteCategory(category)}
                    >
                      🗑
                    </IconButton>
                  </>
                )}
              </HStack>
            ),
          )}
          {/* カテゴリ未設定のマニュアル置き場 */}
          <Button
            variant="ghost"
            size="sm"
            justifyContent="flex-start"
            color="gray.400"
            _hover={{ bg: 'gray.700' }}
            onClick={onSelectUncategorized}
          >
            📂 未分類
          </Button>
        </VStack>
      </Box>

      {/* マニュアル追加(管理者のみ。本命の防御はバックエンドの@Roles) */}
      {isAdmin && (
        <>
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
          <UploadManualDialog
            open={uploadOpen}
            onClose={() => setUploadOpen(false)}
          />
        </>
      )}

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
