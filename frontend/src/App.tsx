import { gql, type TypedDocumentNode } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { Badge, Box, Heading, Spinner, Text, VStack } from '@chakra-ui/react'

interface HealthData {
  health: string
  dbHealth: string
}

// バックエンドに投げるGraphQLクエリ（health: アプリ疎通 / dbHealth: DB疎通）
// TypedDocumentNode = クエリ自体に「返ってくる型」を紐付けるv4推奨の書き方
const HEALTH_QUERY: TypedDocumentNode<HealthData> = gql`
  query HealthCheck {
    health
    dbHealth
  }
`

function App() {
  const { data, loading, error } = useQuery(HEALTH_QUERY)

  return (
    <Box p={8}>
      <VStack gap={4} align="start">
        <Heading>社内マニュアル検索</Heading>

        {loading && <Spinner />}

        {error && (
          <Text color="red.500">バックエンドに接続できません: {error.message}</Text>
        )}

        {data && (
          <VStack gap={2} align="start">
            <Badge colorPalette="green">API: {data.health}</Badge>
            <Badge colorPalette="green">DB: {data.dbHealth}</Badge>
          </VStack>
        )}
      </VStack>
    </Box>
  )
}

export default App
