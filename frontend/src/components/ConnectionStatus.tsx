import { gql, type TypedDocumentNode } from '@apollo/client'
import { useQuery } from '@apollo/client/react'
import { Badge, HStack, Spinner } from '@chakra-ui/react'

interface HealthData {
  health: string
  dbHealth: string
}

const HEALTH_QUERY: TypedDocumentNode<HealthData> = gql`
  query HealthCheck {
    health
    dbHealth
  }
`

/** API/DBとの疎通状態を小さく表示する（開発用の目印） */
export function ConnectionStatus() {
  const { data, loading, error } = useQuery(HEALTH_QUERY)

  if (loading) return <Spinner size="xs" />

  if (error) {
    return <Badge colorPalette="red">API未接続</Badge>
  }

  return (
    <HStack gap={2}>
      <Badge colorPalette="green">API: {data?.health}</Badge>
      <Badge colorPalette="green">DB: {data?.dbHealth}</Badge>
    </HStack>
  )
}
