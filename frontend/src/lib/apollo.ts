import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from '@apollo/client'
import { getIdToken } from './auth'

// GraphQLサーバーの場所。本番(AWS)ではVITE_GRAPHQL_URLで差し替える
const uri = import.meta.env.VITE_GRAPHQL_URL ?? 'http://localhost:3000/graphql'

// 毎リクエストのAuthorizationヘッダにIDトークンを添付する
const authLink = new ApolloLink((operation, forward) => {
  const token = getIdToken()
  if (token) {
    operation.setContext(
      ({ headers = {} }: { headers?: Record<string, string> }) => ({
        headers: { ...headers, authorization: `Bearer ${token}` },
      }),
    )
  }
  return forward(operation)
})

export const apolloClient = new ApolloClient({
  link: ApolloLink.from([authLink, new HttpLink({ uri })]),
  cache: new InMemoryCache(),
})
