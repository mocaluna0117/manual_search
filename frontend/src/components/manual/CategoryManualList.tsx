import { useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Card,
  Heading,
  HStack,
  NativeSelect,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useEffect, useState } from 'react'
import {
  AUTO_ORGANIZE_MUTATION,
  DELETE_MANUAL_MUTATION,
  INGEST_MANUAL_MUTATION,
  MANUALS_QUERY,
  MOVE_MANUAL_MUTATION,
  MOVE_MANUALS_MUTATION,
  type IngestStatus,
} from '../../graphql/manuals'
import { CATEGORIES_QUERY } from '../../graphql/categories'
import { ME_QUERY } from '../../graphql/me'
import { useManualViewer } from './ManualViewerProvider'

import { formatSize } from '../../lib/format'

interface CategoryManualListProps {
  categoryId?: string
  uncategorized?: boolean // trueなら「カテゴリ未設定」のマニュアルを表示
  categoryName: string
}

/** 取り込み状況をバッジで表示する */
function IngestStatusBadge({
  status,
  chunkCount,
}: {
  status: IngestStatus
  chunkCount: number | null
}) {
  switch (status) {
    case 'PENDING':
      return <Badge colorPalette="gray">取り込み待ち</Badge>
    case 'PROCESSING':
      return <Badge colorPalette="orange">取り込み中…</Badge>
    case 'COMPLETED':
      return (
        <Badge colorPalette="green">
          AI検索対象{chunkCount != null ? `（${chunkCount}チャンク）` : ''}
        </Badge>
      )
    case 'FAILED':
      return <Badge colorPalette="red">取り込み失敗</Badge>
  }
}

export function CategoryManualList({
  categoryId,
  uncategorized,
  categoryName,
}: CategoryManualListProps) {
  const { data, loading, startPolling, stopPolling } = useQuery(MANUALS_QUERY, {
    variables: { categoryId, uncategorized },
  })
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'

  // 取り込み中のものがある間だけ、3秒ごとに一覧を取り直して進行状況を反映する
  const hasInFlight = data?.manuals.some(
    (m) => m.ingestStatus === 'PENDING' || m.ingestStatus === 'PROCESSING',
  )
  useEffect(() => {
    if (hasInFlight) {
      startPolling(3000)
      return () => stopPolling()
    }
    stopPolling()
  }, [hasInFlight, startPolling, stopPolling])

  // アプリ内のPDFビューアを開く(共通のモーダル)
  const { openManual } = useManualViewer()

  // 移動先の選択肢用(Apolloがキャッシュ済みなので追加の通信はほぼ無し)
  const { data: categoriesData } = useQuery(CATEGORIES_QUERY)
  const [moveManual] = useMutation(MOVE_MANUAL_MUTATION, {
    // 移動後に一覧を取り直す(このカテゴリの一覧からカードが消える)
    refetchQueries: ['Manuals'],
  })

  const handleMove = async (id: string, newCategoryId: string) => {
    try {
      await moveManual({
        variables: { id, categoryId: newCategoryId || null },
      })
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '移動できませんでした')
    }
  }

  // まとめて移動: チェック選択と一括操作バー
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkDest, setBulkDest] = useState('__unset') // '__unset'=未選択 / ''=未分類
  const [moveManuals, { loading: bulkMoving }] = useMutation(
    MOVE_MANUALS_MUTATION,
    { refetchQueries: ['Manuals'] },
  )

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected =
    (data?.manuals.length ?? 0) > 0 && selected.size === data?.manuals.length

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(data?.manuals.map((m) => m.id) ?? []))
  }

  const handleBulkMove = async () => {
    if (bulkDest === '__unset' || selected.size === 0) return
    try {
      await moveManuals({
        variables: { ids: [...selected], categoryId: bulkDest || null },
      })
      setSelected(new Set())
      setBulkDest('__unset')
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '移動できませんでした')
    }
  }

  // AIによる一括自動分類(未分類ビュー専用)
  const [autoOrganize, { loading: organizing }] = useMutation(
    AUTO_ORGANIZE_MUTATION,
    { refetchQueries: ['Manuals', 'ManualCategories'] },
  )

  const handleAutoOrganize = async () => {
    const count = data?.manuals.length ?? 0
    if (
      !window.confirm(
        `未分類の${count}件をAIが内容から分類します（必要ならカテゴリも自動作成されます）。よろしいですか？`,
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

  const [deleteManual] = useMutation(DELETE_MANUAL_MUTATION, {
    // 削除後に一覧を取り直して画面を最新化する
    refetchQueries: ['Manuals'],
  })

  const [ingestManual] = useMutation(INGEST_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`「${title}」を削除しますか？元に戻せません。`)) return
    await deleteManual({ variables: { id } })
  }

  return (
    <Box p={8} maxW="800px" mx="auto">
      <Heading size="lg" mb={6}>
        📁 {categoryName}
      </Heading>

      {loading && <Spinner />}

      {data && data.manuals.length === 0 && (
        <Text color="fg.muted">このカテゴリにはまだマニュアルがありません</Text>
      )}

      {/* まとめて移動の操作バー(管理者のみ) */}
      {isAdmin && (data?.manuals.length ?? 0) > 0 && (
        <HStack mb={4} gap={3}>
          {/* 未分類ビューにだけ出る: AIによる一括自動分類 */}
          {uncategorized && (
            <Button
              size="sm"
              colorPalette="purple"
              variant="outline"
              loading={organizing}
              onClick={() => void handleAutoOrganize()}
            >
              🤖 AIで自動分類
            </Button>
          )}
          <HStack as="label" gap={2} cursor="pointer" fontSize="sm">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <Text>すべて選択</Text>
          </HStack>
          {selected.size > 0 && (
            <>
              <Text fontSize="sm" color="blue.fg" fontWeight="medium">
                {selected.size}件選択中
              </Text>
              <NativeSelect.Root size="sm" w="170px">
                <NativeSelect.Field
                  value={bulkDest}
                  onChange={(e) => setBulkDest(e.target.value)}
                >
                  <option value="__unset">移動先を選択…</option>
                  <option value="">📂 未分類</option>
                  {categoriesData?.manualCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      📁 {c.name}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              <Button
                size="sm"
                colorPalette="blue"
                loading={bulkMoving}
                disabled={bulkDest === '__unset'}
                onClick={() => void handleBulkMove()}
              >
                移動
              </Button>
            </>
          )}
        </HStack>
      )}

      <VStack gap={3} align="stretch">
        {data?.manuals.map((manual) => (
          <Card.Root key={manual.id} size="sm">
            <Card.Body>
              <HStack justify="space-between" align="start">
                {/* まとめて移動用のチェックボックス */}
                {isAdmin && (
                  <input
                    type="checkbox"
                    checked={selected.has(manual.id)}
                    onChange={() => toggleSelect(manual.id)}
                    style={{
                      width: 16,
                      height: 16,
                      marginTop: 6,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  />
                )}
                <Box flex="1">
                  <Card.Title>{manual.title}</Card.Title>
                  <Text fontSize="xs" color="fg.muted" mt={1}>
                    {manual.fileName}（{formatSize(manual.size)}）
                  </Text>
                  <HStack mt={2} gap={2}>
                    <IngestStatusBadge
                      status={manual.ingestStatus}
                      chunkCount={manual.chunkCount}
                    />
                    {manual.ingestStatus === 'FAILED' && manual.ingestError && (
                      <Text fontSize="xs" color="fg.error">
                        {manual.ingestError}
                      </Text>
                    )}
                  </HStack>
                </Box>
                <HStack gap={2} flexShrink={0}>
                  {/* 移動先カテゴリの選択(選んだ瞬間に移動) */}
                  {isAdmin && (
                    <NativeSelect.Root size="sm" w="140px">
                      <NativeSelect.Field
                        value={manual.categoryId ?? ''}
                        onChange={(e) => void handleMove(manual.id, e.target.value)}
                      >
                        <option value="">📂 未分類</option>
                        {categoriesData?.manualCategories.map((c) => (
                          <option key={c.id} value={c.id}>
                            📁 {c.name}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                  )}
                  {isAdmin && manual.ingestStatus === 'FAILED' && (
                    <Button
                      size="sm"
                      colorPalette="orange"
                      variant="outline"
                      onClick={() => ingestManual({ variables: { id: manual.id } })}
                    >
                      再取り込み
                    </Button>
                  )}
                  <Button
                    size="sm"
                    colorPalette="blue"
                    variant="outline"
                    onClick={() => openManual(manual.id, manual.title)}
                  >
                    開く
                  </Button>
                  {isAdmin && (
                    <Button
                      size="sm"
                      colorPalette="red"
                      variant="ghost"
                      onClick={() => handleDelete(manual.id, manual.title)}
                    >
                      削除
                    </Button>
                  )}
                </HStack>
              </HStack>
            </Card.Body>
          </Card.Root>
        ))}
      </VStack>
    </Box>
  )
}
