import {
  useApolloClient,
  useLazyQuery,
  useMutation,
  useQuery,
} from '@apollo/client/react'
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
import { useEffect, useRef, useState } from 'react'
import { FcFolder, FcOpenedFolder } from 'react-icons/fc'
import {
  LuBot,
  LuFolderTree,
  LuLogOut,
  LuMenu,
  LuMessageSquarePlus,
  LuPencil,
  LuPlus,
  LuSettings,
  LuTrash2,
  LuUpload,
  LuUser,
  LuUsers,
  LuX,
} from 'react-icons/lu'
import { useAuth } from 'react-oidc-context'
import {
  CATEGORIES_QUERY,
  CREATE_CATEGORY_MUTATION,
  DELETE_CATEGORY_MUTATION,
  REORDER_CATEGORIES_MUTATION,
  UPDATE_CATEGORY_MUTATION,
  type Category,
} from '../../graphql/categories'
import { signOutRedirect } from '../../lib/auth'
import {
  CONVERSATIONS_QUERY,
  DELETE_CONVERSATION_MUTATION,
} from '../../graphql/chat'
import {
  MOVE_MANUAL_MUTATION,
  RECLASSIFY_COUNTS_QUERY,
  RECLASSIFY_STATUS_QUERY,
  START_RECLASSIFY_MUTATION,
} from '../../graphql/manuals'
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
  /** このパネルに表示する内容(レイアウト設定で左右に振り分ける) */
  sections?: SidebarSections
  /** アカウント欄(設定・ログアウト)を出すか。分割時は片方だけに出す */
  showFooter?: boolean
}

/** サイドバーに出す内容の範囲 */
export type SidebarSections = 'both' | 'chat' | 'manuals'

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
  sections = 'both',
  showFooter = true,
}: SidebarProps) {
  const showChat = sections === 'both' || sections === 'chat'
  const showManuals = sections === 'both' || sections === 'manuals'
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

  // 全件再分類(サイドバーのボタン)。数分かかるので開始だけして進捗はポーリングで見る
  const client = useApolloClient()
  const [startReclassify] = useMutation(START_RECLASSIFY_MUTATION)
  const [reclassifying, setReclassifying] = useState(false)
  const { data: statusData } = useQuery(RECLASSIFY_STATUS_QUERY, {
    skip: !isAdmin,
    pollInterval: reclassifying ? 3000 : 0,
    fetchPolicy: 'network-only',
  })
  const [fetchCounts] = useLazyQuery(RECLASSIFY_COUNTS_QUERY, {
    fetchPolicy: 'network-only',
  })

  // 再読み込みしても実行中なら進捗表示を復元する
  const running = statusData?.reclassifyStatus.running ?? false
  useEffect(() => {
    if (running) setReclassifying(true)
  }, [running])

  // 実行中→完了に変わったら結果を知らせ、一覧を最新化する
  const wasRunningRef = useRef(false)
  useEffect(() => {
    if (wasRunningRef.current && !running) {
      const status = statusData?.reclassifyStatus
      setReclassifying(false)
      void client.refetchQueries({ include: ['ManualCategories', 'Manuals'] })
      if (status) {
        window.alert(
          status.error
            ? `再分類に失敗しました: ${status.error}`
            : `再分類が完了しました（${status.movedCount}件を割り当て）` +
                (status.createdCategories.length > 0
                  ? `\n新しく作られたフォルダ: ${status.createdCategories.join('、')}`
                  : ''),
        )
      }
    }
    wasRunningRef.current = running
  }, [running, statusData, client])

  const handleReclassify = async () => {
    const { data: counts } = await fetchCounts()
    const target = counts?.reclassifyCounts.target ?? 0
    const pinned = counts?.reclassifyCounts.pinned ?? 0
    if (target === 0) {
      window.alert('再分類できるマニュアルがありません。')
      return
    }
    if (
      !window.confirm(
        `全${target}件のマニュアルを、AIが工種・業務分野ごとのフォルダへ再分類します（足りないフォルダは新しく作られます）。\n` +
          (pinned > 0 ? `ピン留めされた${pinned}件は動かしません。\n` : '') +
          '今の分類は上書きされます。実行しますか？',
      )
    )
      return
    try {
      const { data } = await startReclassify()
      if (data?.startReclassifyAll === false) {
        window.alert('再分類は既に実行中です。完了までお待ちください。')
        return
      }
      setReclassifying(true)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '再分類を開始できませんでした')
    }
  }

  // フォルダの並び替え(管理者のみ)。マニュアルのドラッグと区別するため
  // 専用のデータ形式を使う(dragover中でも types なら中身を見られる)
  const FOLDER_MIME = 'application/x-manual-folder'
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  // 挿入位置の線を出す場所(どのフォルダの上/下か)
  const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(
    null,
  )
  const [reorderCategories] = useMutation(REORDER_CATEGORIES_MUTATION, {
    refetchQueries: ['ManualCategories'],
  })

  const handleFolderReorder = async (targetId: string, before: boolean) => {
    const list = data?.manualCategories ?? []
    const dragged = draggingFolderId
    setDraggingFolderId(null)
    setDropAt(null)
    if (!dragged || dragged === targetId) return

    const next = list.filter((c) => c.id !== dragged)
    const draggedItem = list.find((c) => c.id === dragged)
    if (!draggedItem) return
    const targetIndex = next.findIndex((c) => c.id === targetId)
    if (targetIndex < 0) return
    next.splice(before ? targetIndex : targetIndex + 1, 0, draggedItem)

    // 先に画面へ反映してから保存する(ドラッグ後に一瞬元へ戻るのを防ぐ)
    client.writeQuery({
      query: CATEGORIES_QUERY,
      data: { manualCategories: next },
    })
    try {
      await reorderCategories({ variables: { ids: next.map((c) => c.id) } })
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '並び替えを保存できませんでした')
      void client.refetchQueries({ include: ['ManualCategories'] })
    }
  }

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
      {showChat && (
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
          <LuMessageSquarePlus /> 新しいチャット
        </Button>
      )}

      {/* キーワード検索(AI検索と別の、従来型の検索) */}
      {showManuals && (
        <Input
          size="sm"
          placeholder="マニュアル名・内容で検索"
          bg="bg.panel"
          borderColor="border.emphasized"
          _placeholder={{ color: 'fg.subtle' }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSearch()
          }}
        />
      )}

      {/* チャット履歴(DBから取得) */}
      <Box flex="1" overflowY="auto">
      {showChat && (
        <>
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
                <LuTrash2 />
              </IconButton>
            </HStack>
          ))}
        </VStack>
        </>
      )}

      {showChat && showManuals && <Separator my={4} borderColor="border" />}

      {showManuals && (
        <>
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
            <LuFolderTree /> マニュアル
          </Button>
          {isAdmin && (
            <HStack gap={0}>
              <IconButton
                aria-label="AIで全マニュアルを再分類"
                title="AIで全マニュアルを再分類"
                size="2xs"
                variant="ghost"
                color={reclassifying ? 'purple.fg' : 'fg.muted'}
                _hover={{ color: 'purple.fg', bg: 'bg.emphasized' }}
                loading={reclassifying}
                onClick={() => void handleReclassify()}
              >
                <LuBot />
              </IconButton>
              <IconButton
                aria-label="フォルダを追加"
                title="フォルダを追加"
                size="2xs"
                variant="ghost"
                color="fg.muted"
                _hover={{ color: 'fg', bg: 'bg.emphasized' }}
                onClick={() => setAddingCategory((v) => !v)}
              >
                <LuPlus />
              </IconButton>
            </HStack>
          )}
        </HStack>

        {/* カテゴリ追加フォーム(+ボタンを押すと出る) */}
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
              <HStack
                key={category.id}
                gap={0}
                // 並び替え時の挿入位置を線で示す
                borderTopWidth="2px"
                borderBottomWidth="2px"
                borderTopColor={
                  dropAt?.id === category.id && dropAt.before
                    ? 'blue.solid'
                    : 'transparent'
                }
                borderBottomColor={
                  dropAt?.id === category.id && !dropAt.before
                    ? 'blue.solid'
                    : 'transparent'
                }
                opacity={draggingFolderId === category.id ? 0.4 : 1}
              >
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
                  // 管理者はフォルダ自体をドラッグして並び替えられる
                  draggable={isAdmin}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FOLDER_MIME, category.id)
                    e.dataTransfer.effectAllowed = 'move'
                    setDraggingFolderId(category.id)
                  }}
                  onDragEnd={() => {
                    setDraggingFolderId(null)
                    setDropAt(null)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    // フォルダを運んでいるときは並び替え、マニュアルなら移動先
                    if (e.dataTransfer.types.includes(FOLDER_MIME)) {
                      const rect = e.currentTarget.getBoundingClientRect()
                      setDropAt({
                        id: category.id,
                        before: e.clientY < rect.top + rect.height / 2,
                      })
                      setDropTargetId(null)
                    } else {
                      setDropTargetId(category.id)
                    }
                  }}
                  onDragLeave={() => {
                    setDropTargetId(null)
                    setDropAt((prev) =>
                      prev?.id === category.id ? null : prev,
                    )
                  }}
                  onDrop={(e) => {
                    if (e.dataTransfer.types.includes(FOLDER_MIME)) {
                      e.preventDefault()
                      const before = dropAt?.before ?? true
                      void handleFolderReorder(category.id, before)
                      return
                    }
                    void handleManualDrop(e, category.id)
                  }}
                  onClick={() => {
                    onSelectCategory(category)
                    onNavigate?.()
                  }}
                >
                  <FcFolder /> {category.name}
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
                      <LuPencil />
                    </IconButton>
                    <IconButton
                      aria-label="カテゴリを削除"
                      size="xs"
                      variant="ghost"
                      color="fg.muted"
                      _hover={{ color: 'fg.error', bg: 'bg.emphasized' }}
                      onClick={() => void handleDeleteCategory(category)}
                    >
                      <LuTrash2 />
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
            {/* 未分類は「色のついていない置き場」としてグレーのフォルダにする */}
            <FcOpenedFolder style={{ filter: 'grayscale(1)', opacity: 0.85 }} />{' '}
            未分類
          </Button>
        </VStack>
        </>
      )}
      </Box>

      {/* マニュアル追加(管理者のみ。本命の防御はバックエンドの@Roles) */}
      {isAdmin && showManuals && (
        <>
          <Button
            variant="outline"
            size="sm"
            color="fg"
            borderColor="border.emphasized"
            _hover={{ bg: 'bg.emphasized' }}
            onClick={() => setUploadOpen(true)}
          >
            <LuUpload /> マニュアルを追加
          </Button>
          <UploadManualDialog
            open={uploadOpen}
            onClose={() => setUploadOpen(false)}
          />
        </>
      )}

      {/* 下部: ユーザー管理・ログインユーザー・設定・ログアウト。
          分割表示のときは片方のパネルにだけ出す */}
      {showFooter && (
      <Box>
        {isAdmin && (
          <>
            <Button
              variant="outline"
              size="sm"
              w="100%"
              mb={2}
              color="fg"
              borderColor="border.emphasized"
              _hover={{ bg: 'bg.emphasized' }}
              onClick={() => setUsersOpen(true)}
            >
              <LuUsers /> ユーザー管理
            </Button>
            <UserManagementDialog
              open={usersOpen}
              onClose={() => setUsersOpen(false)}
            />
          </>
        )}
        <HStack gap={1} mb={1} color="fg.muted">
          <LuUser size={12} />
          <Text fontSize="xs" truncate>
            {auth.user?.profile.email}
          </Text>
        </HStack>
        <HStack justify="space-between">
          <Button
            size="xs"
            variant="ghost"
            color="fg.muted"
            _hover={{ bg: 'bg.emphasized' }}
            onClick={() => setSettingsOpen(true)}
          >
            <LuSettings /> 設定
          </Button>
          <Button
            size="xs"
            variant="ghost"
            color="fg.muted"
            _hover={{ bg: 'bg.emphasized' }}
            onClick={() => void handleLogout()}
          >
            <LuLogOut /> ログアウト
          </Button>
        </HStack>
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </Box>
      )}
    </VStack>
  )
}

const SIDEBAR_WIDTH_KEY = 'manualSearch.sidebarWidth'
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 480

/**
 * PC用の常設パネル(md以上)。レイアウト設定に応じて左右どちらにも置ける。
 * 幅はドラッグで調整でき、左右それぞれ別に記憶する
 */
export function SidebarPanel({
  side = 'left',
  ...props
}: SidebarProps & { side?: 'left' | 'right' }) {
  const storageKey = `${SIDEBAR_WIDTH_KEY}.${side}`
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey))
      if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) return saved
    } catch {
      // 読めなければ既定値
    }
    return 260
  })
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => {
      // 左パネルはマウスのX座標がそのまま幅。右パネルは画面幅からの引き算
      const next =
        side === 'left' ? ev.clientX : window.innerWidth - ev.clientX
      setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setWidth((w) => {
        try {
          localStorage.setItem(storageKey, String(w))
        } catch {
          // 保存できない環境では今回だけ有効
        }
        return w
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <Box
      w={`${width}px`}
      flexShrink={0}
      h="100%"
      bg="bg.subtle"
      borderRightWidth={side === 'left' ? '1px' : undefined}
      borderLeftWidth={side === 'right' ? '1px' : undefined}
      borderColor="border"
      display={{ base: 'none', md: 'block' }}
      position="relative"
    >
      <SidebarContent {...props} />
      {/* 幅調整のつまみ(メイン画面側の端。ホバーで見えるようになる) */}
      <Box
        position="absolute"
        top={0}
        bottom={0}
        {...(side === 'left' ? { right: '-2px' } : { left: '-2px' })}
        w="5px"
        cursor="col-resize"
        zIndex={5}
        _hover={{ bg: 'blue.muted' }}
        onPointerDown={startResize}
      />
    </Box>
  )
}

/**
 * スマホ用(md未満)のハンバーガーボタン + Drawer。
 * 画面が狭いので分割はせず、常に全項目を1枚にまとめて出す
 */
export function MobileSidebar(props: SidebarProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
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
        <LuMenu />
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
                  <LuX />
                </IconButton>
              </HStack>
              <Drawer.Body p={0} overflow="hidden">
                {/* 項目を選んだらDrawerを閉じる */}
                <SidebarContent
                  {...props}
                  sections="both"
                  showFooter
                  onNavigate={() => setOpen(false)}
                />
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </>
  )
}
