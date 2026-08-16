import {
  useApolloClient,
  useLazyQuery,
  useMutation,
  useQuery,
} from '@apollo/client/react'
import {
  Box,
  Button,
  HStack,
  IconButton,
  Image,
  Input,
  Portal,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useEffect, useRef, useState } from 'react'
import { FcFolder, FcOpenedFolder } from 'react-icons/fc'
import {
  LuBot,
  LuChevronDown,
  LuChevronRight,
  LuCircleHelp,
  LuFolderTree,
  LuLogOut,
  LuMail,
  LuMenu,
  LuMessageSquarePlus,
  LuPanelLeft,
  LuPanelRight,
  LuPencil,
  LuPlus,
  LuRuler,
  LuSettings,
  LuTrash2,
  LuUpload,
  LuUser,
  LuChartNoAxesColumn,
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
  RENAME_CONVERSATION_MUTATION,
} from '../../graphql/chat'
import {
  DELETE_MANUALS_MUTATION,
  MANUALS_QUERY,
  MOVE_MANUAL_MUTATION,
  RECLASSIFY_COUNTS_QUERY,
  RECLASSIFY_STATUS_QUERY,
  START_RECLASSIFY_MUTATION,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
import { useManualViewer } from '../manual/ManualViewerProvider'
import { HelpDialog } from './HelpDialog'
import { UploadManualDialog } from '../manual/UploadManualDialog'
import { ClassificationRuleDialog } from './ClassificationRuleDialog'
import { InquiryDialog } from './InquiryDialog'
import { SettingsDialog } from './SettingsDialog'
import { AnalyticsDialog } from './AnalyticsDialog'
import { UserManagementDialog } from './UserManagementDialog'
import { Tooltip } from '../ui/Tooltip'
import { errorMessage, toastError, toastInfo, toastSuccess } from '../../lib/toast'
import { useCollapsedSections } from '../../lib/useCollapsedSections'
import { useIsTouchDevice } from '../../lib/useIsTouchDevice'
import { drawerWidth, useDrawerDrag } from '../../lib/useDrawerDrag'

/**
 * フォルダをドラッグしていることを示すデータ形式。
 * ドラッグ中は中身(getData)を読めないが、types なら判別できるため、
 * マニュアルのドラッグ(text/plain)と区別するのに使う
 */
export const FOLDER_MIME = 'application/x-manual-folder'

export interface SidebarProps {
  selectedCategoryId: string | null
  selectedConversationId: string | null
  onSelectCategory: (category: Category | null) => void
  onSelectConversation: (conversationId: string) => void
  onSelectUncategorized: () => void
  onSelectTrash: () => void
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

/**
 * 左上のアプリ名。押すと新しいチャット(=ホーム)へ戻る。
 * ChatGPTと同じで、ロゴがホームへの入口を兼ねる
 */
function AppBrand({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip label="新しいチャット(ホーム)">
      <Button
        variant="ghost"
        size="sm"
        px={2}
        gap={2}
        fontWeight="bold"
        color="fg"
        _hover={{ bg: 'bg.emphasized' }}
        onClick={onClick}
      >
        <Image src="/favicon.svg" alt="" boxSize="20px" />
        Manualy
      </Button>
    </Tooltip>
  )
}

/** サイドバーの中身。PC(常設)とスマホ(Drawer)の両方から使う */
export function SidebarContent({
  selectedCategoryId,
  selectedConversationId,
  onSelectCategory,
  onSelectConversation,
  onSelectUncategorized,
  onSelectTrash,
  onSelectManualsRoot,
  onSearch,
  onNavigate,
  sections = 'both',
  showFooter = true,
}: SidebarProps) {
  const showChat = sections === 'both' || sections === 'chat'
  const showManuals = sections === 'both' || sections === 'manuals'
  // 1つのパネルに両方を並べているときは、片方を畳めるようにする。
  // 左右に振り分けている設定では、そもそも並ばないので畳む必要がない。
  // 閉じたことは覚えておく(開くたびに畳み直す手間をなくす)
  const isTouch = useIsTouchDevice()
  const collapsible = sections === 'both'
  const [collapsed, setCollapsed] = useCollapsedSections()
  const chatOpen = !collapsible || !collapsed.chat
  const manualsOpen = !collapsible || !collapsed.manuals
  const toggle = (key: 'chat' | 'manuals') =>
    setCollapsed({ ...collapsed, [key]: !collapsed[key] })
  const auth = useAuth()
  const { data, loading } = useQuery(CATEGORIES_QUERY)
  const { data: chatData, loading: loadingChats } = useQuery(CONVERSATIONS_QUERY)
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const [uploadOpen, setUploadOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [inquiryOpen, setInquiryOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  const handleLogout = async () => {
    await auth.removeUser() // ブラウザ内のトークンを破棄
    signOutRedirect() // Cognito側のセッションも切ってログイン画面へ
  }

  const [deleteConversation] = useMutation(DELETE_CONVERSATION_MUTATION, {
    refetchQueries: ['Conversations'],
  })

  // チャット名のインライン編集(フォルダ名の変更と同じ操作感に揃える)
  const [editingChatId, setEditingChatId] = useState<string | null>(null)
  const [editingChatName, setEditingChatName] = useState('')
  const [renameConversation] = useMutation(RENAME_CONVERSATION_MUTATION, {
    refetchQueries: ['Conversations'],
  })
  const handleRenameConversation = async (id: string, original: string) => {
    const title = editingChatName.trim()
    setEditingChatId(null)
    if (!title || title === original) return
    try {
      await renameConversation({ variables: { id, title } })
    } catch (e) {
      toastError('名前を変更できませんでした', errorMessage(e, ''))
    }
  }

  // カテゴリ管理(ADMINのみUIに出る。本命の防御はバックエンド)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [createCategory] = useMutation(CREATE_CATEGORY_MUTATION, {
    refetchQueries: ['ManualCategories'],
  })
  const [deleteCategory] = useMutation(DELETE_CATEGORY_MUTATION, {
    refetchQueries: [
      'ManualCategories',
      'Manuals',
      'TrashedManuals',
      'TrashedCategories',
    ],
  })

  const handleCreateCategory = async () => {
    const name = newCategoryName.trim()
    if (!name) return
    try {
      await createCategory({ variables: { name } })
      setNewCategoryName('')
      setAddingCategory(false)
    } catch (e) {
      toastError('カテゴリを作成できませんでした', errorMessage(e, ''))
    }
  }

  const handleDeleteCategory = async (category: Category) => {
    const count = category.manualCount ?? 0
    if (
      !window.confirm(
        `フォルダ「${category.name}」をゴミ箱に移動しますか？` +
          (count > 0 ? `\n中のファイル${count}件も一緒に移動します。` : '') +
          '\nゴミ箱から元に戻せます。',
      )
    )
      return
    try {
      await deleteCategory({ variables: { id: category.id } })
      if (category.id === selectedCategoryId) onSelectCategory(null)
    } catch (e) {
      // マニュアルが残っている場合はバックエンドが理由を返してくる
      toastError('削除できませんでした', errorMessage(e, ''))
    }
  }

  // カテゴリ名のインライン編集
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [editingName, setEditingName] = useState('')

  // 全件再分類(サイドバーのボタン)。数分かかるので開始だけして進捗はポーリングで見る
  const client = useApolloClient()
  const [startReclassify] = useMutation(START_RECLASSIFY_MUTATION)
  const [reclassifying, setReclassifying] = useState(false)

  const { openManual } = useManualViewer()
  // 「使い方」はマニュアルとして登録済みのガイドPDFを開く
  // (docs/usage-guide/で生成・登録している。ファイル名を変えたらここも変える)
  const openUsageGuide = async () => {
    const find = async (fetchPolicy: 'cache-first' | 'network-only') => {
      const { data } = await client.query({
        query: MANUALS_QUERY,
        variables: {},
        fetchPolicy,
      })
      return data?.manuals.find(
        (m) => m.fileName === USAGE_GUIDE_FILE_NAME,
      )
    }
    // 登録直後などキャッシュに無いことがあるので、見つからなければ取り直す
    const guide = (await find('cache-first')) ?? (await find('network-only'))
    if (!guide) {
      alert(
        '使い方ガイドが見つかりませんでした。管理者に連絡してください(docs/usage-guide/の手順で再登録できます)',
      )
      return
    }
    openManual(guide.id, guide.title)
  }
  // 実行中は短い間隔で、それ以外も控えめに監視する。
  // チャットから始めた再分類もここで拾えるようにするため(一覧の自動更新用)
  const { data: statusData } = useQuery(RECLASSIFY_STATUS_QUERY, {
    skip: !isAdmin,
    pollInterval: reclassifying ? 3000 : 30000,
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

  // 実行中→完了に変わったら一覧を最新化する。
  // ダイアログでの通知は、このボタンから始めたときだけ(チャットから始めた
  // 場合は会話に完了メッセージが出るので、二重に知らせない)
  const wasRunningRef = useRef(false)
  const startedHereRef = useRef(false)
  useEffect(() => {
    if (wasRunningRef.current && !running) {
      const status = statusData?.reclassifyStatus
      setReclassifying(false)
      void client.refetchQueries({ include: ['ManualCategories', 'Manuals'] })
      if (status && startedHereRef.current) {
        if (status.error) {
          toastError('再分類に失敗しました', status.error)
        } else {
          toastSuccess(
            `再分類が完了しました（${status.movedCount}件を割り当て）`,
            status.createdCategories.length > 0
              ? `新しく作られたフォルダ: ${status.createdCategories.join('、')}`
              : undefined,
          )
        }
      }
      startedHereRef.current = false
    }
    wasRunningRef.current = running
  }, [running, statusData, client])

  const handleReclassify = async () => {
    const { data: counts } = await fetchCounts()
    const target = counts?.reclassifyCounts.target ?? 0
    const pinned = counts?.reclassifyCounts.pinned ?? 0
    if (target === 0) {
      toastInfo('再分類できるマニュアルがありません')
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
        toastInfo('再分類は既に実行中です', '完了までお待ちください')
        return
      }
      startedHereRef.current = true
      setReclassifying(true)
    } catch (e) {
      toastError('再分類を開始できませんでした', errorMessage(e, ''))
    }
  }

  // フォルダの並び替え(管理者のみ)。マニュアルのドラッグと区別するため
  // 専用のデータ形式を使う(dragover中でも types なら中身を見られる)
  // 使い方ガイドPDFのファイル名。docs/usage-guide/README.mdの登録手順と揃えること
const USAGE_GUIDE_FILE_NAME = '社内マニュアル検索_使い方ガイド.pdf'

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
      toastError('並び替えを保存できませんでした', errorMessage(e, ''))
      void client.refetchQueries({ include: ['ManualCategories'] })
    }
  }

  /** ゴミ箱にドロップされたものをゴミ箱へ移す(ファイル・フォルダ両対応) */
  const handleTrashDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropTargetId(null)
    try {
      const folderId = e.dataTransfer.getData(FOLDER_MIME)
      if (folderId) {
        const folder = data?.manualCategories.find((c) => c.id === folderId)
        const count = folder?.manualCount ?? 0
        // フォルダは中身ごと動くので、ファイル1件より影響が大きい。ここだけ確認する
        if (
          !window.confirm(
            `フォルダ「${folder?.name ?? ''}」をゴミ箱に移動しますか？` +
              (count > 0 ? `\n中のファイル${count}件も一緒に移動します。` : '') +
              '\nゴミ箱から元に戻せます。',
          )
        )
          return
        await deleteCategory({ variables: { id: folderId } })
        if (folderId === selectedCategoryId) onSelectCategory(null)
        return
      }
      // ファイルは元に戻せるので、いちいち確認しない(OSのゴミ箱と同じ感覚)
      const manualId = e.dataTransfer.getData('text/plain')
      if (manualId) await deleteManuals({ variables: { ids: [manualId] } })
    } catch (err) {
      toastError('ゴミ箱に移動できませんでした', errorMessage(err, ''))
    }
  }

  // エクスプローラーからマニュアルをドラッグしてフォルダへ移動できるようにする
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [moveManual] = useMutation(MOVE_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const [deleteManuals] = useMutation(DELETE_MANUALS_MUTATION, {
    refetchQueries: ['Manuals', 'ManualCategories', 'TrashedManuals'],
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
      toastError('移動できませんでした', errorMessage(err, ''))
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
      toastError('名前を変更できませんでした', errorMessage(e, ''))
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
        {collapsible ? (
          <Button
            variant="ghost"
            size="xs"
            w="100%"
            px={1}
            justifyContent="flex-start"
            color="fg.muted"
            fontWeight="normal"
            // 閉じているときは中身が無いので、下の余白も要らない
            mb={chatOpen ? 2 : 0}
            onClick={() => toggle('chat')}
          >
            {chatOpen ? <LuChevronDown /> : <LuChevronRight />} チャット履歴
          </Button>
        ) : (
          <Text fontSize="xs" color="fg.muted" mb={2}>
            チャット履歴
          </Text>
        )}
        {chatOpen && loadingChats && <Spinner size="sm" />}
        {chatOpen && chatData && chatData.conversations.length === 0 && (
          <Text fontSize="sm" color="fg.muted">
            履歴はまだありません
          </Text>
        )}
        <VStack gap={1} align="stretch" display={chatOpen ? 'flex' : 'none'}>
          {chatData?.conversations.map((conversation) =>
            editingChatId === conversation.id ? (
              // 編集モード: その場で名前を書き換える
              <Input
                key={conversation.id}
                size="sm"
                autoFocus
                bg="bg.panel"
                borderColor="border.emphasized"
                value={editingChatName}
                onChange={(e) => setEditingChatName(e.target.value)}
                onBlur={() =>
                  void handleRenameConversation(
                    conversation.id,
                    conversation.title,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                    void handleRenameConversation(
                      conversation.id,
                      conversation.title,
                    )
                  if (e.key === 'Escape') setEditingChatId(null)
                }}
              />
            ) : (
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
              <Tooltip label="チャット名を変更">
                <IconButton
                  aria-label="チャット名を変更"
                  size="xs"
                  variant="ghost"
                  color="fg.muted"
                  _hover={{ color: 'fg', bg: 'bg.emphasized' }}
                  onClick={() => {
                    setEditingChatId(conversation.id)
                    setEditingChatName(conversation.title)
                  }}
                >
                  <LuPencil />
                </IconButton>
              </Tooltip>
              <Tooltip label="会話を削除">
                <IconButton
                  aria-label="会話を削除"
                  size="xs"
                  variant="ghost"
                  color="fg.muted"
                  _hover={{ color: 'fg.error', bg: 'bg.emphasized' }}
                  onClick={() =>
                    handleDeleteConversation(
                      conversation.id,
                      conversation.title,
                    )
                  }
                >
                  <LuTrash2 />
                </IconButton>
              </Tooltip>
            </HStack>
            ),
          )}
        </VStack>
        </>
      )}

      {/* 区切り線は置かない。見出しがあれば境目は分かるので、線があると
          かえって窮屈に見える。間隔だけ空ける(折りたたみ時は詰める) */}
      {showChat && showManuals && (
        <Box h={collapsible && !chatOpen ? 1 : 3} />
      )}

      {showManuals && (
        <>
        {/* カテゴリ別マニュアル(DBから取得)。
            フォルダが増えても操作ボタンに届くよう、見出しはスクロールしても上端に残す */}
        <HStack
          justify="space-between"
          // 閉じているときは中身が無いので、下の余白も要らない
          mb={manualsOpen ? 2 : 0}
          position="sticky"
          top={0}
          zIndex={1}
          bg="bg.subtle"
          py={1}
        >
          <HStack gap={0} minW={0}>
            {/* 開閉は専用のボタンに分ける。「マニュアル」を押したときは
                エクスプローラーが開く動きを残したいため。
                指で押す端末では見出し全体でも開閉できるようにする */}
            {collapsible && (
              <IconButton
                aria-label={manualsOpen ? 'マニュアルを閉じる' : 'マニュアルを開く'}
                size="2xs"
                variant="ghost"
                color="fg.muted"
                _hover={{ color: 'fg', bg: 'bg.emphasized' }}
                onClick={() => toggle('manuals')}
              >
                {manualsOpen ? <LuChevronDown /> : <LuChevronRight />}
              </IconButton>
            )}
            <Button
              variant="ghost"
              size="xs"
              px={1}
              color="fg.muted"
              fontWeight="normal"
              _hover={{ color: 'fg', bg: 'bg.emphasized' }}
              onClick={() => {
                // 指で押す端末は、狭いシェブロンを狙わなくても畳めるようにする
                if (collapsible && isTouch) {
                  toggle('manuals')
                  return
                }
                onSelectManualsRoot()
                onNavigate?.()
              }}
            >
              {!collapsible && <LuFolderTree />} マニュアル
            </Button>
          </HStack>
          {isAdmin && (
            <HStack gap={0}>
              <Tooltip label="AIで全マニュアルを再分類">
                <IconButton
                  aria-label="AIで全マニュアルを再分類"
                  size="2xs"
                  variant="ghost"
                  color={reclassifying ? 'purple.fg' : 'fg.muted'}
                  _hover={{ color: 'purple.fg', bg: 'bg.emphasized' }}
                  loading={reclassifying}
                  onClick={() => void handleReclassify()}
                >
                  <LuBot />
                </IconButton>
              </Tooltip>
              <Tooltip label="分類ルール(AIの分類の決まりごと)">
                <IconButton
                  aria-label="分類ルール"
                  size="2xs"
                  variant="ghost"
                  color="fg.muted"
                  _hover={{ color: 'fg', bg: 'bg.emphasized' }}
                  onClick={() => setRulesOpen(true)}
                >
                  <LuRuler />
                </IconButton>
              </Tooltip>
              <Tooltip label="フォルダを追加">
                <IconButton
                  aria-label="フォルダを追加"
                  size="2xs"
                  variant="ghost"
                  color="fg.muted"
                  _hover={{ color: 'fg', bg: 'bg.emphasized' }}
                  // フォーカスを奪わない。奪うと入力欄のonBlurが先に閉じてしまい、
                  // このボタンで閉じられなくなる
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setAddingCategory((v) => !v)}
                >
                  <LuPlus />
                </IconButton>
              </Tooltip>
            </HStack>
          )}
        </HStack>

        {/* カテゴリ追加フォーム(+ボタンを押すと出る) */}
        {addingCategory && (
          <Input
            size="sm"
            mb={2}
            autoFocus
            placeholder="フォルダ名を入力してEnter"
            bg="bg.panel"
            borderColor="border.emphasized"
            _placeholder={{ color: 'fg.subtle' }}
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            // 作らずに他をクリックしたら閉じる(入力欄が出しっぱなしにならない)。
            // 名前の変更欄と同じ振る舞いに揃えている
            onBlur={() => {
              setAddingCategory(false)
              setNewCategoryName('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing)
                void handleCreateCategory()
              if (e.key === 'Escape') {
                setAddingCategory(false)
                setNewCategoryName('')
              }
            }}
          />
        )}

        {manualsOpen && loading && <Spinner size="sm" />}
        {manualsOpen && data && data.manualCategories.length === 0 && (
          <Text fontSize="sm" color="fg.muted">
            カテゴリはまだありません
          </Text>
        )}
        <VStack gap={1} align="stretch" display={manualsOpen ? 'flex' : 'none'}>
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
                  {/* 長いフォルダ名はサイドバーの幅で省略する */}
                  <Box flexShrink={0} display="inline-flex">
                    <FcFolder />
                  </Box>
                  <Text as="span" minW={0} truncate>
                    {category.name}
                  </Text>
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
          {/* ゴミ箱(管理者のみ)。毎日使うものではないので、一覧の最下段に置く。
              ファイル・フォルダをドラッグして放り込める */}
          {isAdmin && (
            <Button
              variant="ghost"
              size="sm"
              justifyContent="flex-start"
              color={dropTargetId === 'trash' ? 'fg.error' : 'fg.muted'}
              _hover={{ bg: 'bg.emphasized' }}
              borderWidth="1px"
              borderColor={
                dropTargetId === 'trash' ? 'fg.error' : 'transparent'
              }
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTargetId('trash')
              }}
              onDragLeave={() => setDropTargetId(null)}
              onDrop={(e) => void handleTrashDrop(e)}
              onClick={() => {
                onSelectTrash()
                onNavigate?.()
              }}
            >
              <LuTrash2 /> ゴミ箱
            </Button>
          )}

        </VStack>
        </>
      )}
      </Box>

      <ClassificationRuleDialog
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
      />

      {/* マニュアル追加(管理者のみ。本命の防御はバックエンドの@Roles)。
          ボタンは下部のアイコン列に置いてあるので、ここはダイアログだけ */}
      {isAdmin && showManuals && (
        <UploadManualDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
        />
      )}

      {/* 下部: ユーザー管理・ログインユーザー・設定・ログアウト。
          分割表示のときは片方のパネルにだけ出す */}
      {showFooter && (
      <Box>
        {/* ボタンは下のアイコン列にまとめてある。ここはダイアログだけ */}
        {isAdmin && (
          <>
            <AnalyticsDialog
              open={analyticsOpen}
              onClose={() => setAnalyticsOpen(false)}
            />
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
        <HStack justify="space-between" flexWrap="wrap" gap={0}>
          {/* 狭い画面では、幅いっぱいのボタン3つをここへ集める。
              縦に積むと画面の半分近くを占めてしまうため */}
          {isAdmin && (
            <>
              {showManuals && (
                <Tooltip label="マニュアルを追加">
                  <IconButton
                    aria-label="マニュアルを追加"
                    size="xs"
                    variant="ghost"
                    color="fg.muted"
                    _hover={{ bg: 'bg.emphasized' }}
                    onClick={() => setUploadOpen(true)}
                  >
                    <LuUpload />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip label="利用状況">
                <IconButton
                  aria-label="利用状況"
                  size="xs"
                  variant="ghost"
                  color="fg.muted"
                  _hover={{ bg: 'bg.emphasized' }}
                  onClick={() => setAnalyticsOpen(true)}
                >
                  <LuChartNoAxesColumn />
                </IconButton>
              </Tooltip>
              <Tooltip label="ユーザー管理">
                <IconButton
                  aria-label="ユーザー管理"
                  size="xs"
                  variant="ghost"
                  color="fg.muted"
                  _hover={{ bg: 'bg.emphasized' }}
                  onClick={() => setUsersOpen(true)}
                >
                  <LuUsers />
                </IconButton>
              </Tooltip>
            </>
          )}
          <Tooltip label="使い方">
            <IconButton
              aria-label="使い方"
              size="xs"
              variant="ghost"
              color="fg.muted"
              _hover={{ bg: 'bg.emphasized' }}
              onClick={() => setHelpOpen(true)}
            >
              <LuCircleHelp />
            </IconButton>
          </Tooltip>
          <Tooltip label="設定">
            <IconButton
              aria-label="設定"
              size="xs"
              variant="ghost"
              color="fg.muted"
              _hover={{ bg: 'bg.emphasized' }}
              onClick={() => setSettingsOpen(true)}
            >
              <LuSettings />
            </IconButton>
          </Tooltip>
          <Tooltip label="問い合わせ">
            <IconButton
              aria-label="問い合わせ"
              size="xs"
              variant="ghost"
              color="fg.muted"
              _hover={{ bg: 'bg.emphasized' }}
              onClick={() => setInquiryOpen(true)}
            >
              <LuMail />
            </IconButton>
          </Tooltip>
          <Tooltip label="ログアウト">
            <IconButton
              aria-label="ログアウト"
              size="xs"
              variant="ghost"
              color="fg.muted"
              _hover={{ bg: 'bg.emphasized' }}
              onClick={() => void handleLogout()}
            >
              <LuLogOut />
            </IconButton>
          </Tooltip>
        </HStack>
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
        <InquiryDialog
          open={inquiryOpen}
          onClose={() => setInquiryOpen(false)}
        />
        <HelpDialog
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          onOpenPdf={openUsageGuide}
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
  onToggleCollapse,
  ...props
}: SidebarProps & {
  side?: 'left' | 'right'
  /** パネルを閉じる(ChatGPT風の開閉ボタン) */
  onToggleCollapse?: () => void
}) {
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
      display={{ base: 'none', md: 'flex' }}
      flexDirection="column"
      position="relative"
    >
      {/* パネル上部。左パネルにはアプリ名(ホームへの入口)を置く */}
      {(onToggleCollapse || side === 'left') && (
        <HStack px={3} pt={3} flexShrink={0} gap={1}>
          {side === 'left' && (
            <AppBrand
              onClick={() => {
                props.onSelectCategory(null) // ホーム=新しいチャット
                props.onNavigate?.()
              }}
            />
          )}
          <Box flex="1" />
          {onToggleCollapse && (
            <Tooltip label="サイドバーを閉じる">
              <IconButton
                aria-label="サイドバーを閉じる"
                size="sm"
                variant="ghost"
                color="fg.muted"
                _hover={{ color: 'fg', bg: 'bg.emphasized' }}
                onClick={onToggleCollapse}
              >
                {side === 'left' ? <LuPanelLeft /> : <LuPanelRight />}
              </IconButton>
            </Tooltip>
          )}
        </HStack>
      )}
      <Box flex="1" minH={0}>
        <SidebarContent {...props} />
      </Box>
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
  const isTouch = useIsTouchDevice()
  // 指の位置に合わせてその場で動かす。0(閉)〜1(開)
  const { progress, isDragging } = useDrawerDrag(isTouch, open, setOpen)
  const width = typeof window === 'undefined' ? 320 : drawerWidth()

  // 指を離したあとだけ滑らせる。動かしている最中に効かせると指から遅れる
  const glide = isDragging
    ? 'none'
    : 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1), opacity 260ms'

  // Escで閉じる(タッチ端末以外でも、キーボードから抜けられるように)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

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

      <Portal>
        {/* 背景。開き具合に合わせて濃くする */}
        <Box
          position="fixed"
          inset={0}
          zIndex={1400}
          bg="black"
          display={{ base: 'block', md: 'none' }}
          opacity={progress * 0.5}
          pointerEvents={progress > 0 ? 'auto' : 'none'}
          transition={glide}
          onClick={() => setOpen(false)}
        />
        {/* 引き出し本体。指の位置に合わせて左右に動かす */}
        <Box
          position="fixed"
          top={0}
          left={0}
          bottom={0}
          zIndex={1401}
          width={`${width}px`}
          maxW="85vw"
          bg="bg.subtle"
          display={{ base: 'flex', md: 'none' }}
          flexDirection="column"
          boxShadow={progress > 0 ? 'lg' : 'none'}
          // translate3dにするとGPUで動き、指に付いてくる
          transform={`translate3d(${(progress - 1) * width}px, 0, 0)`}
          transition={glide}
          // 中身は開いているときだけ触れるようにする(閉じている間の誤タップを防ぐ)
          visibility={progress > 0 ? 'visible' : 'hidden'}
        >
          <HStack justify="space-between" px={2} pt={2} flexShrink={0}>
            <AppBrand
              onClick={() => {
                props.onSelectCategory(null)
                setOpen(false)
              }}
            />
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
          <Box flex="1" minH={0} overflow="hidden">
            {/* 項目を選んだら閉じる */}
            <SidebarContent
              {...props}
              sections="both"
              showFooter
              onNavigate={() => setOpen(false)}
            />
          </Box>
        </Box>
      </Portal>
    </>
  )
}
