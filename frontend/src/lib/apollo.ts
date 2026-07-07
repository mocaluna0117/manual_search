import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client'

// GraphQLサーバーの場所。本番(AWS)ではVITE_GRAPHQL_URLで差し替える
const uri = import.meta.env.VITE_GRAPHQL_URL ?? 'http://localhost:3000/graphql'

export const apolloClient = new ApolloClient({
  link: new HttpLink({ uri }),
  cache: new InMemoryCache(),
})
