import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Card,
  Heading,
  HStack,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useEffect } from 'react'
import {
  DELETE_MANUAL_MUTATION,
  INGEST_MANUAL_MUTATION,
  MANUAL_DOWNLOAD_URL_QUERY,
  MANUALS_QUERY,
  type IngestStatus,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'

import { formatSize } from '../../lib/format'

interface CategoryManualListProps {
  categoryId: string
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
  categoryName,
}: CategoryManualListProps) {
  const { data, loading, startPolling, stopPolling } = useQuery(MANUALS_QUERY, {
    variables: { categoryId },
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

  // useLazyQuery: useQueryと違い「呼んだときだけ」実行される。ボタン起点の取得はこちら
  const [fetchDownloadUrl] = useLazyQuery(MANUAL_DOWNLOAD_URL_QUERY, {
    // 署名付きURLは期限があるので毎回サーバーから取り直す(キャッシュしない)
    fetchPolicy: 'no-cache',
  })

  const [deleteManual] = useMutation(DELETE_MANUAL_MUTATION, {
    // 削除後に一覧を取り直して画面を最新化する
    refetchQueries: ['Manuals'],
  })

  const [ingestManual] = useMutation(INGEST_MANUAL_MUTATION, {
    refetchQueries: ['Manuals'],
  })

  const handleOpen = async (id: string) => {
    const { data: urlData } = await fetchDownloadUrl({ variables: { id } })
    if (urlData) {
      window.open(urlData.manualDownloadUrl, '_blank')
    }
  }

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
                    onClick={() => handleOpen(manual.id)}
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
