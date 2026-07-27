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
import { useEffect } from 'react'
import {
  DELETE_MANUAL_MUTATION,
  INGEST_MANUAL_MUTATION,
  MANUALS_QUERY,
  MOVE_MANUAL_MUTATION,
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
        <Text color="gray.500">このカテゴリにはまだマニュアルがありません</Text>
      )}

      <VStack gap={3} align="stretch">
        {data?.manuals.map((manual) => (
          <Card.Root key={manual.id} size="sm">
            <Card.Body>
              <HStack justify="space-between" align="start">
                <Box>
                  <Card.Title>{manual.title}</Card.Title>
                  {manual.description && (
                    <Card.Description>{manual.description}</Card.Description>
                  )}
                  <Text fontSize="xs" color="gray.500" mt={1}>
                    {manual.fileName}（{formatSize(manual.size)}）
                  </Text>
                  <HStack mt={2} gap={2}>
                    <IngestStatusBadge
                      status={manual.ingestStatus}
                      chunkCount={manual.chunkCount}
                    />
                    {manual.ingestStatus === 'FAILED' && manual.ingestError && (
                      <Text fontSize="xs" color="red.500">
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
