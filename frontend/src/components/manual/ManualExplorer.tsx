import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import { Box, Button, HStack, Portal, Spinner, Text } from '@chakra-ui/react'
import { useEffect, useState } from 'react'
import { FcFile, FcFolder, FcOpenedFolder } from 'react-icons/fc'
import {
  LuArrowLeft,
  LuBookOpen,
  LuBot,
  LuClock,
  LuFolderTree,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu'
import { CATEGORIES_QUERY } from '../../graphql/categories'
import {
  AUTO_ORGANIZE_MUTATION,
  DELETE_MANUAL_MUTATION,
  INGEST_MANUAL_MUTATION,
  MANUALS_QUERY,
  MOVE_MANUAL_MUTATION,
  type Manual,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
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

/** アイコンの右上に出す取り込み状態の目印 */
function StatusMark({ manual }: { manual: Manual }) {
  switch (manual.ingestStatus) {
    case 'PENDING':
    case 'PROCESSING':
      return (
        <Box position="absolute" top="1" right="4" color="orange.fg" title="取り込み中…">
          <LuClock size={14} />
        </Box>
      )
    case 'FAILED':
      return (
        <Box
          position="absolute"
          top="1"
          right="4"
          color="fg.error"
          title={manual.ingestError ?? '取り込みに失敗しました'}
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

  const { data: categoriesData } = useQuery(CATEGORIES_QUERY)
  // ルートと未分類ビューは「カテゴリ未設定」のマニュアルを表示する
  const { data, loading, startPolling, stopPolling } = useQuery(MANUALS_QUERY, {
    variables:
      isRoot || isUncategorized
        ? { uncategorized: true }
        : { categoryId: folder.id },
    fetchPolicy: 'cache-and-network', // 別画面での変更(アップロード等)を開くたびに反映
  })
  const manuals = data?.manuals ?? []
  const categories = categoriesData?.manualCategories ?? []

  // 取り込み中のものがある間だけ、3秒ごとに一覧を取り直して進行状況を反映する
  const client = useApolloClient()
  const hasInFlight = manuals.some(
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

  /** アイコン1つぶんの共通の見た目(Windows風: 選択で青くなる) */
  const itemStyle = (id: string, isDropTarget = false) => ({
    w: '112px',
    px: 1,
    py: 2,
    borderRadius: 'md',
    borderWidth: '2px',
    borderColor:
      dragOverFolderId === id && isDropTarget
        ? 'blue.solid' // ドロップ先のハイライト
        : selectedId === id
          ? 'blue.muted'
          : 'transparent',
    bg: selectedId === id ? 'blue.subtle' : undefined,
    _hover: { bg: selectedId === id ? 'blue.subtle' : 'bg.muted' },
    cursor: 'default',
    userSelect: 'none' as const,
    textAlign: 'center' as const,
  })

  const label = (text: string) => (
    <Text
      fontSize="xs"
      mt={1}
      lineClamp={2}
      wordBreak="break-all"
      lineHeight="1.25"
    >
      {text}
    </Text>
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
      {/* ツールバー: パンくず + 操作 */}
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
      </HStack>

      {loading && !data && <Spinner />}

      {/* アイコングリッド: ルートはフォルダ+未分類ファイル、フォルダ内はファイルのみ */}
      <Box
        display="grid"
        gridTemplateColumns="repeat(auto-fill, minmax(112px, 1fr))"
        gap={1}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelectedId(null)
        }}
      >
        {isRoot &&
          categories.map((category) => (
            <Box
              key={category.id}
              {...itemStyle(category.id, true)}
              onClick={() => setSelectedId(category.id)}
              onDoubleClick={() => onNavigate(category)}
              onDragOver={(e) => {
                if (!isAdmin) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOverFolderId(category.id)
              }}
              onDragLeave={() => setDragOverFolderId(null)}
              onDrop={(e) => {
                e.preventDefault()
                const manualId = e.dataTransfer.getData('text/plain')
                if (manualId) void handleDrop(manualId, category.id)
              }}
            >
              <Box display="flex" justifyContent="center">
                <FcFolder size={48} />
              </Box>
              {label(category.name)}
            </Box>
          ))}

        {manuals.map((manual) => {
          return (
            <Box
              key={manual.id}
              {...itemStyle(manual.id)}
              position="relative"
              draggable={isAdmin}
              onClick={() => setSelectedId(manual.id)}
              onDoubleClick={() => openManual(manual.id, manual.title)}
              onContextMenu={(e) => {
                e.preventDefault()
                setSelectedId(manual.id)
                setContextMenu({ x: e.clientX, y: e.clientY, manual })
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', manual.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              title={manual.title}
            >
              <Box display="flex" justifyContent="center">
                <FcFile size={48} />
              </Box>
              <StatusMark manual={manual} />
              {label(manual.title)}
            </Box>
          )
        })}
      </Box>

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
