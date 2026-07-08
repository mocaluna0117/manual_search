import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react'
import {
  Box,
  Button,
  Card,
  Heading,
  HStack,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import {
  DELETE_MANUAL_MUTATION,
  MANUAL_DOWNLOAD_URL_QUERY,
  MANUALS_QUERY,
} from '../../graphql/manuals'

interface CategoryManualListProps {
  categoryId: string
  categoryName: string
}

/** バイト数を人間が読みやすい形式にする(例: 1536000 → "1.5 MB") */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function CategoryManualList({
  categoryId,
  categoryName,
}: CategoryManualListProps) {
  const { data, loading } = useQuery(MANUALS_QUERY, {
    variables: { categoryId },
  })

  // useLazyQuery: useQueryと違い「呼んだときだけ」実行される。ボタン起点の取得はこちら
  const [fetchDownloadUrl] = useLazyQuery(MANUAL_DOWNLOAD_URL_QUERY, {
    // 署名付きURLは期限があるので毎回サーバーから取り直す(キャッシュしない)
    fetchPolicy: 'no-cache',
  })

  const [deleteManual] = useMutation(DELETE_MANUAL_MUTATION, {
    // 削除後に一覧を取り直して画面を最新化する
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
                </Box>
                <HStack gap={2} flexShrink={0}>
                  <Button
                    size="sm"
                    colorPalette="blue"
                    variant="outline"
                    onClick={() => handleOpen(manual.id)}
                  >
                    開く
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="red"
                    variant="ghost"
                    onClick={() => handleDelete(manual.id, manual.title)}
                  >
                    削除
                  </Button>
                </HStack>
              </HStack>
            </Card.Body>
          </Card.Root>
        ))}
      </VStack>
    </Box>
  )
}
