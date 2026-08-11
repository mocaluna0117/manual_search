import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  HStack,
  IconButton,
  Portal,
  Spinner,
  Text,
} from '@chakra-ui/react'
import { useEffect, useState } from 'react'
import { FcFile, FcFolder, FcOpenedFolder } from 'react-icons/fc'
import {
  LuArrowLeft,
  LuBookOpen,
  LuBot,
  LuChevronDown,
  LuChevronUp,
  LuClock,
  LuFolderTree,
  LuLayoutGrid,
  LuList,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu'
import { CATEGORIES_QUERY, type Category } from '../../graphql/categories'
import {
  AUTO_ORGANIZE_MUTATION,
  DELETE_MANUAL_MUTATION,
  INGEST_MANUAL_MUTATION,
  MANUALS_QUERY,
  MOVE_MANUAL_MUTATION,
  type Manual,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
import { formatSize } from '../../lib/format'
import { useManualViewer } from './ManualViewerProvider'

/** 表示中の場所。null=ルート(全フォルダ+未分類のマニュアル) */
export type ExplorerFolder =
  | { id: string; name: string }
  | 'uncategorized'
  | null

interface ManualExplorerProps {
  folder: ExplorerFolder
  onNavigate: (folder: ExplorerFolder) => void
}

/** エクスプローラーの表示形式(Windowsの「詳細」と「中アイコン」に相当) */
type ViewMode = 'details' | 'icons'
const VIEW_MODE_KEY = 'manualSearch.explorerViewMode'

type SortKey = 'name' | 'updatedAt' | 'size'

/** 「2026/08/11 19:59」形式(Windowsの更新日時列と同じ見た目) */
function formatDateTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 取り込み状態の目印(色付きアイコン)。正常時は何も出さない */
function StatusIcon({ manual }: { manual: Manual }) {
  switch (manual.ingestStatus) {
    case 'PENDING':
    case 'PROCESSING':
      return (
        <Box color="orange.fg" title="取り込み中…" flexShrink={0}>
          <LuClock size={14} />
        </Box>
      )
    case 'FAILED':
      return (
        <Box
          color="fg.error"
          title={manual.ingestError ?? '取り込みに失敗しました'}
          flexShrink={0}
        >
          <LuTriangleAlert size={14} />
        </Box>
      )
    case 'COMPLETED':
      return null
  }
}

/**
 * Windowsのエクスプローラー風のマニュアル一覧。
 * - 既定は「詳細」表示(名前・更新日時・サイズの列)。アイコン表示にも切替可能
 * - シングルクリックで選択 / ダブルクリックで開く(フォルダ・マニュアル共通)
 * - 管理者はマニュアルをフォルダへドラッグ&ドロップで移動できる
 * - 右クリックでメニュー(開く・削除・再取り込み)
 */
export function ManualExplorer({ folder, onNavigate }: ManualExplorerProps) {
  const isRoot = folder === null
  const isUncategorized = folder === 'uncategorized'

  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const { openManual } = useManualViewer()

  // フォルダ一覧も開くたびに取り直す。チャット経由の再分類などで
  // 裏でフォルダが増えていても、古いキャッシュのまま表示しないため
  const { data: categoriesData } = useQuery(CATEGORIES_QUERY, {
    fetchPolicy: 'cache-and-network',
  })
  // ルートと未分類ビューは「カテゴリ未設定」のマニュアルを表示する
  const { data, loading, startPolling, stopPolling } = useQuery(MANUALS_QUERY, {
    variables:
      isRoot || isUncategorized
        ? { uncategorized: true }
        : { categoryId: folder.id },
    fetchPolicy: 'cache-and-network', // 別画面での変更(アップロード等)を開くたびに反映
  })

  // 取り込み中のものがある間だけ、3秒ごとに一覧を取り直して進行状況を反映する
  const client = useApolloClient()
  const hasInFlight = (data?.manuals ?? []).some(
    (m) => m.ingestStatus === 'PENDING' || m.ingestStatus === 'PROCESSING',
  )
  useEffect(() => {
    if (hasInFlight) {
      startPolling(3000)
      return () => {
        stopPolling()
        // 取り込み完了と同時に「AIにおまかせ」が新カテゴリを作っていることがある
        void client.refetchQueries({ include: ['ManualCategories'] })
      }
    }
    stopPolling()
  }, [hasInFlight, startPolling, stopPolling, client])

  // 表示形式(localStorageに保存して次回も同じ表示で開く)
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === 'icons' ? 'icons' : 'details'
    } catch {
      return 'details'
    }
  })
  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode)
    } catch {
      // 保存できない環境では今回だけ有効
    }
  }

  // 並べ替え(詳細表示のヘッダーをクリック。アイコン表示にも同じ順序を適用)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }
  const dir = sortAsc ? 1 : -1
  const manuals = [...(data?.manuals ?? [])].sort((a, b) => {
    if (sortKey === 'size') return (a.size - b.size) * dir
    if (sortKey === 'updatedAt')
      return a.updatedAt.localeCompare(b.updatedAt) * dir
    return a.title.localeCompare(b.title, 'ja') * dir
  })
  // フォルダは常にファイルより先(Windowsと同じ)。サイズ列では名前順を維持
  const categories = [...(categoriesData?.manualCategories ?? [])].sort(
    (a, b) => {
      if (sortKey === 'updatedAt')
        return (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '') * dir
      return a.name.localeCompare(b.name, 'ja') * (sortKey === 'size' ? 1 : dir)
    },
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    manual: Manual
  } | null>(null)

  // 右クリックメニューは画面のどこかをクリック/Escで閉じる(Windowsと同じ)
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  const [moveManual] = useMutation(MOVE_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const [deleteManual] = useMutation(DELETE_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const [ingestManual] = useMutation(INGEST_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const [autoOrganize, { loading: organizing }] = useMutation(
    AUTO_ORGANIZE_MUTATION,
    { refetchQueries: ['Manuals', 'ManualCategories'] },
  )

  const handleDrop = async (manualId: string, categoryId: string | null) => {
    setDragOverFolderId(null)
    const manual = manuals.find((m) => m.id === manualId)
    if (manual && manual.categoryId === categoryId) return // 同じ場所へは何もしない
    try {
      await moveManual({ variables: { id: manualId, categoryId } })
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '移動できませんでした')
    }
  }

  const handleDelete = async (manual: Manual) => {
    if (!window.confirm(`「${manual.title}」を削除しますか？元に戻せません。`))
      return
    try {
      await deleteManual({ variables: { id: manual.id } })
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '削除できませんでした')
    }
  }

  const handleAutoOrganize = async () => {
    if (
      !window.confirm(
        `未分類の${manuals.length}件をAIが内容から分類します（必要ならカテゴリも自動作成されます）。よろしいですか？`,
      )
    )
      return
    try {
      const { data: result } = await autoOrganize()
      if (result) {
        const { movedCount, createdCategories } = result.autoOrganizeManuals
        window.alert(
          `${movedCount}件を分類しました` +
            (createdCategories.length > 0
              ? `\n新しく作られたカテゴリ: ${createdCategories.join('、')}`
              : ''),
        )
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '自動分類に失敗しました')
    }
  }

  // ---- フォルダ/マニュアルそれぞれの共通ハンドラ(詳細・アイコン両表示で使う) ----

  const folderItemProps = (category: Category) => ({
    onClick: () => setSelectedId(category.id),
    onDoubleClick: () => onNavigate(category),
    onDragOver: (e: React.DragEvent) => {
      if (!isAdmin) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOverFolderId(category.id)
    },
    onDragLeave: () => setDragOverFolderId(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      const manualId = e.dataTransfer.getData('text/plain')
      if (manualId) void handleDrop(manualId, category.id)
    },
  })

  const manualItemProps = (manual: Manual) => ({
    draggable: isAdmin,
    onClick: () => setSelectedId(manual.id),
    onDoubleClick: () => openManual(manual.id, manual.title),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      setSelectedId(manual.id)
      setContextMenu({ x: e.clientX, y: e.clientY, manual })
    },
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/plain', manual.id)
      e.dataTransfer.effectAllowed = 'move'
    },
  })

  /** 選択・ドロップ先のハイライト(Windows風の青) */
  const highlight = (id: string, isDropTarget = false) => ({
    borderWidth: '2px',
    borderColor:
      dragOverFolderId === id && isDropTarget
        ? 'blue.solid'
        : selectedId === id
          ? 'blue.muted'
          : 'transparent',
    bg: selectedId === id ? 'blue.subtle' : undefined,
    _hover: { bg: selectedId === id ? 'blue.subtle' : 'bg.muted' },
    cursor: 'default',
    userSelect: 'none' as const,
  })

  const showFolders = isRoot // フォルダが並ぶのはルートだけ

  /** 詳細表示の列ヘッダー(クリックで並べ替え) */
  const sortHeader = (label: string, key: SortKey, w?: string) => (
    <HStack
      w={w}
      flex={w ? undefined : '1'}
      gap={1}
      cursor="pointer"
      _hover={{ color: 'fg' }}
      onClick={() => toggleSort(key)}
    >
      <Text>{label}</Text>
      {sortKey === key &&
        (sortAsc ? <LuChevronUp size={12} /> : <LuChevronDown size={12} />)}
    </HStack>
  )

  return (
    <Box
      p={{ base: 4, md: 6 }}
      pt={{ base: 14, md: 6 }}
      h="100%"
      overflowY="auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedId(null)
      }}
    >
      {/* ツールバー: パンくず + 操作 + 表示切替 */}
      <HStack mb={4} gap={2} flexWrap="wrap">
        {!isRoot && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onNavigate(null)}
            title="ひとつ上へ"
          >
            <LuArrowLeft />
          </Button>
        )}
        <Button
          size="xs"
          variant={isRoot ? 'subtle' : 'ghost'}
          fontWeight="bold"
          onClick={() => onNavigate(null)}
        >
          <LuFolderTree /> マニュアル
        </Button>
        {!isRoot && (
          <HStack gap={1} fontSize="sm" color="fg.muted">
            <Text>{'>'}</Text>
            {isUncategorized ? <FcOpenedFolder /> : <FcFolder />}
            <Text>{isUncategorized ? '未分類' : folder.name}</Text>
          </HStack>
        )}
        <Box flex="1" />
        {isAdmin && (isRoot || isUncategorized) && manuals.length > 0 && (
          <Button
            size="xs"
            colorPalette="purple"
            variant="outline"
            loading={organizing}
            onClick={() => void handleAutoOrganize()}
          >
            <LuBot /> 未分類をAIで自動分類
          </Button>
        )}
        {/* 表示切替(Windowsの「詳細」「中アイコン」) */}
        <HStack gap={0} borderWidth="1px" borderRadius="md" overflow="hidden">
          <IconButton
            aria-label="詳細表示"
            title="詳細"
            size="xs"
            borderRadius={0}
            variant={viewMode === 'details' ? 'subtle' : 'ghost'}
            onClick={() => changeViewMode('details')}
          >
            <LuList />
          </IconButton>
          <IconButton
            aria-label="アイコン表示"
            title="中アイコン"
            size="xs"
            borderRadius={0}
            variant={viewMode === 'icons' ? 'subtle' : 'ghost'}
            onClick={() => changeViewMode('icons')}
          >
            <LuLayoutGrid />
          </IconButton>
        </HStack>
      </HStack>

      {loading && !data && <Spinner />}

      {/* ===== 詳細表示(既定) ===== */}
      {viewMode === 'details' && (
        <Box>
          <HStack
            px={2}
            py={1}
            gap={2}
            borderBottomWidth="1px"
            color="fg.muted"
            fontSize="xs"
          >
            {sortHeader('名前', 'name')}
            {sortHeader('更新日時', 'updatedAt', '140px')}
            {sortHeader('サイズ', 'size', '80px')}
          </HStack>

          {showFolders &&
            categories.map((category) => (
              <HStack
                key={category.id}
                px={2}
                py={1}
                gap={2}
                borderRadius="sm"
                {...highlight(category.id, true)}
                {...folderItemProps(category)}
              >
                <HStack flex="1" gap={2} minW={0}>
                  <Box flexShrink={0}>
                    <FcFolder size={18} />
                  </Box>
                  <Text fontSize="sm" truncate>
                    {category.name}
                  </Text>
                </HStack>
                <Text w="140px" fontSize="sm" color="fg.muted" flexShrink={0}>
                  {formatDateTime(category.updatedAt)}
                </Text>
                <Text w="80px" fontSize="sm" color="fg.muted" flexShrink={0} />
              </HStack>
            ))}

          {manuals.map((manual) => (
            <HStack
              key={manual.id}
              px={2}
              py={1}
              gap={2}
              borderRadius="sm"
              {...highlight(manual.id)}
              {...manualItemProps(manual)}
              title={manual.title}
            >
              <HStack flex="1" gap={2} minW={0}>
                <Box flexShrink={0}>
                  <FcFile size={18} />
                </Box>
                <Text fontSize="sm" truncate>
                  {manual.title}
                </Text>
                <StatusIcon manual={manual} />
              </HStack>
              <Text w="140px" fontSize="sm" color="fg.muted" flexShrink={0}>
                {formatDateTime(manual.updatedAt)}
              </Text>
              <Text w="80px" fontSize="sm" color="fg.muted" flexShrink={0}>
                {formatSize(manual.size)}
              </Text>
            </HStack>
          ))}
        </Box>
      )}

      {/* ===== アイコン表示 ===== */}
      {viewMode === 'icons' && (
        <Box
          display="grid"
          gridTemplateColumns="repeat(auto-fill, minmax(112px, 1fr))"
          gap={1}
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedId(null)
          }}
        >
          {showFolders &&
            categories.map((category) => (
              <Box
                key={category.id}
                w="112px"
                px={1}
                py={2}
                borderRadius="md"
                textAlign="center"
                {...highlight(category.id, true)}
                {...folderItemProps(category)}
              >
                <Box display="flex" justifyContent="center">
                  <FcFolder size={48} />
                </Box>
                <Text fontSize="xs" mt={1} lineClamp={2} wordBreak="break-all">
                  {category.name}
                </Text>
              </Box>
            ))}

          {manuals.map((manual) => (
            <Box
              key={manual.id}
              w="112px"
              px={1}
              py={2}
              borderRadius="md"
              textAlign="center"
              position="relative"
              {...highlight(manual.id)}
              {...manualItemProps(manual)}
              title={manual.title}
            >
              <Box display="flex" justifyContent="center">
                <FcFile size={48} />
              </Box>
              <Box position="absolute" top="1" right="4">
                <StatusIcon manual={manual} />
              </Box>
              <Text fontSize="xs" mt={1} lineClamp={2} wordBreak="break-all">
                {manual.title}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {!loading && manuals.length === 0 && (isUncategorized || !isRoot) && (
        <Text mt={6} color="fg.muted" fontSize="sm">
          このフォルダは空です
        </Text>
      )}
      {isRoot && !loading && categories.length === 0 && manuals.length === 0 && (
        <Text mt={6} color="fg.muted" fontSize="sm">
          まだフォルダもマニュアルもありません
        </Text>
      )}

      {isAdmin && (
        <Text mt={6} fontSize="xs" color="fg.subtle">
          ダブルクリックで開く / ドラッグでフォルダへ移動 /
          右クリックでメニュー(サイドバーのフォルダにもドロップできます)
        </Text>
      )}

      {/* 右クリックメニュー(Windows風) */}
      {contextMenu && (
        <Portal>
          <Box
            position="fixed"
            left={`${contextMenu.x}px`}
            top={`${contextMenu.y}px`}
            zIndex={2000}
            bg="bg.panel"
            borderWidth="1px"
            borderRadius="md"
            boxShadow="lg"
            py={1}
            minW="180px"
          >
            <Button
              size="sm"
              variant="ghost"
              w="100%"
              justifyContent="flex-start"
              onClick={() =>
                openManual(contextMenu.manual.id, contextMenu.manual.title)
              }
            >
              <LuBookOpen /> 開く
            </Button>
            {isAdmin && contextMenu.manual.ingestStatus === 'FAILED' && (
              <Button
                size="sm"
                variant="ghost"
                w="100%"
                justifyContent="flex-start"
                onClick={() =>
                  void ingestManual({
                    variables: { id: contextMenu.manual.id },
                  })
                }
              >
                <LuRefreshCw /> 再取り込み
              </Button>
            )}
            {isAdmin && (
              <Button
                size="sm"
                variant="ghost"
                w="100%"
                justifyContent="flex-start"
                color="fg.error"
                onClick={() => void handleDelete(contextMenu.manual)}
              >
                <LuTrash2 /> 削除
              </Button>
            )}
          </Box>
        </Portal>
      )}
    </Box>
  )
}
