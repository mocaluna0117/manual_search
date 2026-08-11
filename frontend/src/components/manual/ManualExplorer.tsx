import { useApolloClient, useMutation, useQuery } from '@apollo/client/react'
import { Box, Button, HStack, Spinner, Text } from '@chakra-ui/react'
import { useEffect, useRef, useState } from 'react'
import { FcFolder, FcOpenedFolder } from 'react-icons/fc'
import { LuArrowLeft, LuBot, LuFolderTree } from 'react-icons/lu'
import { CATEGORIES_QUERY } from '../../graphql/categories'
import {
  AUTO_ORGANIZE_MUTATION,
  DELETE_MANUAL_MUTATION,
  INGEST_MANUAL_MUTATION,
  MANUALS_QUERY,
  MOVE_MANUAL_MUTATION,
  SET_MANUAL_PINNED_MUTATION,
  type Manual,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
import {
  ManualItemList,
  ViewModeSwitch,
  useViewMode,
  type SortKey,
} from './ManualItemList'
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

/**
 * Windowsのエクスプローラー風のマニュアル一覧。
 * 一覧の見た目と操作はManualItemList(検索結果と共通)に任せ、
 * ここはフォルダの移動・取得と、フォルダ特有の操作(自動分類など)を担当する
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
  const inFlight = (data?.manuals ?? []).filter(
    (m) => m.ingestStatus === 'PENDING' || m.ingestStatus === 'PROCESSING',
  )
  const hasInFlight = inFlight.length > 0

  // 取り込みが終わった瞬間に結果を知らせる(押しただけでは終わりが分からないため)
  const watchedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const manuals = data?.manuals ?? []
    const nowInFlight = new Set(
      manuals
        .filter(
          (m) => m.ingestStatus === 'PENDING' || m.ingestStatus === 'PROCESSING',
        )
        .map((m) => m.id),
    )
    for (const id of watchedRef.current) {
      if (nowInFlight.has(id)) continue
      const finished = manuals.find((m) => m.id === id)
      if (!finished) continue // 一覧から消えた(削除・移動)ときは何も言わない
      window.alert(
        finished.ingestStatus === 'COMPLETED'
          ? `「${finished.title}」の取り込みが完了しました（${finished.chunkCount ?? 0}件のチャンク）。AI検索で使えます。`
          : `「${finished.title}」の取り込みに失敗しました。\n${finished.ingestError ?? ''}`,
      )
    }
    watchedRef.current = nowInFlight
  }, [data])
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

  const [viewMode, changeViewMode] = useViewMode()

  // 並べ替え(詳細表示のヘッダーをクリック。アイコン表示にも同じ順序を適用)。
  // 未指定(null)のときは、フォルダはサイドバーで並び替えた順、マニュアルは名前順
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
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
    return a.title.localeCompare(b.title, 'ja') * (sortKey ? dir : 1)
  })
  // フォルダは常にファイルより先(Windowsと同じ)。
  // 列で並べ替えていないときは、サーバーから来た順(管理者が決めた並び)のまま
  const categories = sortKey
    ? [...(categoriesData?.manualCategories ?? [])].sort((a, b) => {
        if (sortKey === 'updatedAt')
          return (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '') * dir
        return (
          a.name.localeCompare(b.name, 'ja') * (sortKey === 'size' ? 1 : dir)
        )
      })
    : (categoriesData?.manualCategories ?? [])

  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [moveManual] = useMutation(MOVE_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const [deleteManual] = useMutation(DELETE_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const [ingestManual] = useMutation(INGEST_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const [setManualPinned] = useMutation(SET_MANUAL_PINNED_MUTATION, {
    refetchQueries: ['Manuals'],
  })
  const [autoOrganize, { loading: organizing }] = useMutation(
    AUTO_ORGANIZE_MUTATION,
    { refetchQueries: ['Manuals', 'ManualCategories'] },
  )

  const handleDrop = async (manualId: string, categoryId: string) => {
    const manual = manuals.find((m) => m.id === manualId)
    if (manual && manual.categoryId === categoryId) return // 同じ場所へは何もしない
    try {
      await moveManual({ variables: { id: manualId, categoryId } })
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '移動できませんでした')
    }
  }

  /** 再取り込みを開始する。完了は上のuseEffectが検知して知らせる */
  const handleIngest = async (manual: Manual) => {
    try {
      await ingestManual({ variables: { id: manual.id } })
    } catch (e) {
      window.alert(
        e instanceof Error ? e.message : '再取り込みを開始できませんでした',
      )
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
            {isUncategorized ? (
              // 未分類はグレーのフォルダ(サイドバーと同じ見た目)
              <FcOpenedFolder style={{ filter: 'grayscale(1)', opacity: 0.85 }} />
            ) : (
              <FcFolder />
            )}
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
        <ViewModeSwitch viewMode={viewMode} onChange={changeViewMode} />
      </HStack>

      {loading && !data && <Spinner />}

      {/* 取り込み中の件数を上部にも出す(アイコンの⏳だけだと気づきにくい) */}
      {hasInFlight && (
        <HStack
          mb={3}
          px={3}
          py={2}
          gap={2}
          borderWidth="1px"
          borderRadius="md"
          borderColor="orange.muted"
          bg="orange.subtle"
          fontSize="sm"
        >
          <Spinner size="xs" color="orange.fg" />
          <Text>
            {inFlight.length}件を取り込み中です（ページを離れても続きます。
            完了するとお知らせします）
          </Text>
        </HStack>
      )}

      <ManualItemList
        viewMode={viewMode}
        folders={isRoot ? categories : []} // フォルダが並ぶのはルートだけ
        manuals={manuals}
        isAdmin={isAdmin}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenManual={(manual) => openManual(manual.id, manual.title)}
        onOpenFolder={(f) => onNavigate(f)}
        onDropToFolder={(manualId, categoryId) =>
          void handleDrop(manualId, categoryId)
        }
        onDeleteManual={(manual) => void handleDelete(manual)}
        onIngestManual={(manual) => void handleIngest(manual)}
        onTogglePin={(manual) =>
          void setManualPinned({
            variables: { id: manual.id, pinned: !manual.categoryPinned },
          })
        }
        sortKey={sortKey ?? undefined}
        sortAsc={sortAsc}
        onSort={toggleSort}
      />

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
    </Box>
  )
}
