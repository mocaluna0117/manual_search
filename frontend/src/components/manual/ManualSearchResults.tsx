import { useQuery } from '@apollo/client/react'
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
import { Fragment } from 'react'
import { SEARCH_MANUALS_QUERY } from '../../graphql/manuals'
import { formatSize } from '../../lib/format'
import { useManualViewer } from './ManualViewerProvider'

interface ManualSearchResultsProps {
  keyword: string
}

/** 文中のキーワードをハイライトして表示する */
function HighlightedText({ text, keyword }: { text: string; keyword: string }) {
  // 正規表現の特殊文字をエスケープしてから、キーワード位置で分割する
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === keyword.toLowerCase() ? (
          <Text as="mark" key={i} bg="yellow.subtle" color="fg">
            {part}
          </Text>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  )
}

export function ManualSearchResults({ keyword }: ManualSearchResultsProps) {
  const { data, loading } = useQuery(SEARCH_MANUALS_QUERY, {
    variables: { keyword },
  })

  const { openManual } = useManualViewer()

  return (
    <Box p={8} maxW="800px" mx="auto">
      <Heading size="lg" mb={2}>
        🔍 「{keyword}」の検索結果
      </Heading>

      {loading && <Spinner mt={4} />}

      {data && (
        <Text color="fg.muted" mb={6}>
          {data.searchManuals.length}件見つかりました
        </Text>
      )}

      <VStack gap={3} align="stretch">
        {data?.searchManuals.map(({ manual, snippet }) => (
          <Card.Root key={manual.id} size="sm">
            <Card.Body>
              <HStack justify="space-between" align="start">
                <Box>
                  <Card.Title>
                    <HighlightedText text={manual.title} keyword={keyword} />
                  </Card.Title>
                  {/* 本文ヒット時の抜粋 */}
                  {snippet && (
                    <Text fontSize="sm" color="fg.muted" mt={2}>
                      <HighlightedText text={snippet} keyword={keyword} />
                    </Text>
                  )}
                  <Text fontSize="xs" color="fg.muted" mt={1}>
                    {manual.fileName}（{formatSize(manual.size)}）
                  </Text>
                </Box>
                <Button
                  size="sm"
                  colorPalette="blue"
                  variant="outline"
                  flexShrink={0}
                  onClick={() => openManual(manual.id, manual.title)}
                >
                  開く
                </Button>
              </HStack>
            </Card.Body>
          </Card.Root>
        ))}
      </VStack>
    </Box>
  )
}
