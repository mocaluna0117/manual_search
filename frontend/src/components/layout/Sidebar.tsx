import { useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  Drawer,
  HStack,
  IconButton,
  Input,
  Portal,
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
import { MOVE_MANUAL_MUTATION } from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
import { UploadManualDialog } from '../manual/UploadManualDialog'
import { SettingsDialog } from './SettingsDialog'
import { UserManagementDialog } from './UserManagementDialog'

export interface SidebarProps {
  selectedCategoryId: string | null
  selectedConversationId: string | null
  onSelectCategory: (category: Category | null) => void
  onSelectConversation: (conversationId: string) => void
  onSelectUncategorized: () => void
  onSelectManualsRoot: () => void // エクスプローラーのルート(全フォルダ)を開く
  onSearch: (keyword: string) => void
  /** 項目を選んだ後に呼ばれる(スマホではDrawerを閉じるために使う) */
  onNavigate?: () => void
}

/** サイドバーの中身。PC(常設)とスマホ(Drawer)の両方から使う */
export function SidebarContent({
  selectedCategoryId,
  selectedConversationId,
  onSelectCategory,
  onSelectConversation,
  onSelectUncategorized,
  onSelectManualsRoot,
  onSearch,
  onNavigate,
}: SidebarProps) {
  const auth = useAuth()
  const { data, loading } = useQuery(CATEGORIES_QUERY)
  const { data: chatData, loading: loadingChats } = useQuery(CONVERSATIONS_QUERY)
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const [uploadOpen, setUploadOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
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

  // エクスプローラーからマニュアルをドラッグしてフォルダへ移動できるようにする
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [moveManual] = useMutation(MOVE_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const handleManualDrop = async (
    e: React.DragEvent,
    categoryId: string | null,
  ) => {
    e.preventDefault()
    setDropTargetId(null)
    const manualId = e.dataTransfer.getData('text/plain')
    if (!manualId) return
    try {
      await moveManual({ variables: { id: manualId, categoryId } })
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '移動できませんでした')
    }
  }
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
    if (!keyword.trim()) return
    onSearch(keyword.trim())
    onNavigate?.()
  }

  const handleDeleteConversation = async (id: string, title: string) => {
    if (!window.confirm(`会話「${title}」を削除しますか？`)) return
    await deleteConversation({ variables: { id } })
    // 開いていた会話を消した場合はホームに戻す
    if (id === selectedConversationId) onSelectCategory(null)
  }

  return (
    <VStack as="nav" h="100%" p={3} gap={4} align="stretch" color="fg">
      {/* 目立たせすぎず、下部の「マニュアルを追加」と同じ枠線スタイルに揃える */}
      <Button
        variant="outline"
        size="sm"
        color="fg"
        borderColor="border.emphasized"
        _hover={{ bg: 'bg.emphasized' }}
        onClick={() => {
          onSelectCategory(null)
          onNavigate?.()
        }}
      >
        ＋ 新しいチャット
      </Button>

      {/* キーワード検索(AI検索と別の、従来型の検索) */}
      <Input
        size="sm"
        placeholder="🔍 マニュアル名・内容で検索"
        bg="bg.panel"
        borderColor="border.emphasized"
        _placeholder={{ color: 'fg.subtle' }}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSearch()
        }}
      />

      {/* チャット履歴(DBから取得) */}
      <Box flex="1" overflowY="auto">
        <Text fontSize="xs" color="fg.muted" mb={2}>
          チャット履歴
        </Text>
        {loadingChats && <Spinner size="sm" />}
        {chatData && chatData.conversations.length === 0 && (
          <Text fontSize="sm" color="fg.muted">
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
                color="fg"
                bg={
                  conversation.id === selectedConversationId
                    ? 'bg.emphasized'
                    : undefined
                }
                _hover={{ bg: 'bg.emphasized' }}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                display="block"
                textAlign="left"
                onClick={() => {
                  onSelectConversation(conversation.id)
                  onNavigate?.()
                }}
              >
                {conversation.title}
              </Button>
              <IconButton
                aria-label="会話を削除"
                size="xs"
                variant="ghost"
                color="fg.muted"
                _hover={{ color: 'fg.error', bg: 'bg.emphasized' }}
                onClick={() =>
                  handleDeleteConversation(conversation.id, conversation.title)
                }
              >
                🗑
              </IconButton>
            </HStack>
          ))}
        </VStack>

        <Separator my={4} borderColor="border" />

        {/* カテゴリ別マニュアル(DBから取得) */}
        <HStack justify="space-between" mb={2}>
          {/* クリックでエクスプローラーのルート(全フォルダのアイコン表示)を開く */}
          <Button
            variant="ghost"
            size="xs"
            px={1}
            color="fg.muted"
            fontWeight="normal"
            _hover={{ color: 'fg', bg: 'bg.emphasized' }}
            onClick={() => {
              onSelectManualsRoot()
              onNavigate?.()
            }}
          >
            🗂 マニュアル
          </Button>
          {isAdmin && (
            <IconButton
              aria-label="カテゴリを追加"
              size="2xs"
              variant="ghost"
              color="fg.muted"
              _hover={{ color: 'fg', bg: 'bg.emphasized' }}
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
            bg="bg.panel"
            borderColor="border.emphasized"
            _placeholder={{ color: 'fg.subtle' }}
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
          <Text fontSize="sm" color="fg.muted">
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
                bg="bg.panel"
                borderColor="border.emphasized"
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
                  color="fg"
                  bg={category.id === selectedCategoryId ? 'bg.emphasized' : undefined}
                  _hover={{ bg: 'bg.emphasized' }}
                  // エクスプローラーからのドロップ先(マニュアルの移動)
                  borderWidth="1px"
                  borderColor={
                    dropTargetId === category.id ? 'blue.solid' : 'transparent'
                  }
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setDropTargetId(category.id)
                  }}
                  onDragLeave={() => setDropTargetId(null)}
                  onDrop={(e) => void handleManualDrop(e, category.id)}
                  onClick={() => {
                    onSelectCategory(category)
                    onNavigate?.()
                  }}
                >
                  📁 {category.name}
                </Button>
                {isAdmin && (
                  <>
                    <IconButton
                      aria-label="カテゴリ名を変更"
                      size="xs"
                      variant="ghost"
                      color="fg.muted"
                      _hover={{ color: 'fg', bg: 'bg.emphasized' }}
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
                      color="fg.muted"
                      _hover={{ color: 'fg.error', bg: 'bg.emphasized' }}
                      onClick={() => void handleDeleteCategory(category)}
                    >
                      🗑
                    </IconButton>
                  </>
                )}
              </HStack>
            ),
          )}
          {/* カテゴリ未設定のマニュアル置き場(ドロップで未分類へ戻せる) */}
          <Button
            variant="ghost"
            size="sm"
            justifyContent="flex-start"
            color="fg.muted"
            _hover={{ bg: 'bg.emphasized' }}
            borderWidth="1px"
            borderColor={
              dropTargetId === 'uncategorized' ? 'blue.solid' : 'transparent'
            }
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropTargetId('uncategorized')
            }}
            onDragLeave={() => setDropTargetId(null)}
            onDrop={(e) => void handleManualDrop(e, null)}
            onClick={() => {
              onSelectUncategorized()
              onNavigate?.()
            }}
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
            color="fg"
            borderColor="border.emphasized"
            _hover={{ bg: 'bg.emphasized' }}
            onClick={() => setUploadOpen(true)}
          >
            📄 マニュアルを追加
          </Button>
          <Button
            variant="outline"
            size="sm"
            color="fg"
            borderColor="border.emphasized"
            _hover={{ bg: 'bg.emphasized' }}
            onClick={() => setUsersOpen(true)}
          >
            👥 ユーザー管理
          </Button>
          <UploadManualDialog
            open={uploadOpen}
            onClose={() => setUploadOpen(false)}
          />
          <UserManagementDialog
            open={usersOpen}
            onClose={() => setUsersOpen(false)}
          />
        </>
      )}

      {/* 下部: ログインユーザーとログアウト */}
      <Box>
        <Text fontSize="xs" color="fg.muted" mb={1} truncate>
          👤 {auth.user?.profile.email}
        </Text>
        <HStack justify="space-between">
          <Button
            size="xs"
            variant="ghost"
            color="fg.muted"
            _hover={{ bg: 'bg.emphasized' }}
            onClick={() => setSettingsOpen(true)}
          >
            ⚙️ 設定
          </Button>
          <Button
            size="xs"
            variant="ghost"
            color="fg.muted"
            _hover={{ bg: 'bg.emphasized' }}
            onClick={() => void handleLogout()}
          >
            ログアウト
          </Button>
        </HStack>
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </Box>
    </VStack>
  )
}

/**
 * サイドバーのガワ。
 * - md以上: 画面左に常設
 * - md未満: ハンバーガーボタン + Drawer(中身は同じSidebarContent)
 *   スマホでもチャット履歴・キーワード検索・カテゴリ・ログアウトに到達できるようにする
 */
export function Sidebar(props: SidebarProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* PC: 常設サイドバー */}
      <Box
        w="260px"
        flexShrink={0}
        h="100%"
        bg="bg.subtle"
        borderRightWidth="1px"
        borderColor="border"
        display={{ base: 'none', md: 'block' }}
      >
        <SidebarContent {...props} />
      </Box>

      {/* スマホ: 画面左上のハンバーガーボタン */}
      <IconButton
        aria-label="メニューを開く"
        variant="ghost"
        size="md"
        position="fixed"
        top={2}
        left={2}
        zIndex={10}
        display={{ base: 'flex', md: 'none' }}
        onClick={() => setOpen(true)}
      >
        ☰
      </IconButton>

      <Drawer.Root
        open={open}
        onOpenChange={(e) => setOpen(e.open)}
        placement="start"
        size="xs"
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content bg="bg.subtle">
              {/* 閉じるボタンは専用の行に置く。
                  Drawer.CloseTriggerはChakraのレシピで絶対配置になり中身と重なるため、
                  通常のボタンで自前に閉じる */}
              <HStack justify="flex-end" px={2} pt={2} flexShrink={0}>
                <IconButton
                  aria-label="メニューを閉じる"
                  variant="ghost"
                  size="sm"
                  color="fg.muted"
                  onClick={() => setOpen(false)}
                >
                  ✕
                </IconButton>
              </HStack>
              <Drawer.Body p={0} overflow="hidden">
                {/* 項目を選んだらDrawerを閉じる */}
                <SidebarContent {...props} onNavigate={() => setOpen(false)} />
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </>
  )
}
