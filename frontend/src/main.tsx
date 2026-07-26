import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApolloProvider } from '@apollo/client/react'
import { ChakraProvider, defaultSystem } from '@chakra-ui/react'
import { AuthProvider } from 'react-oidc-context'
import App from './App.tsx'
import { apolloClient } from './lib/apollo.ts'
import { oidcConfig } from './lib/auth.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider {...oidcConfig}>
      <ApolloProvider client={apolloClient}>
        <ChakraProvider value={defaultSystem}>
          <App />
        </ChakraProvider>
      </ApolloProvider>
    </AuthProvider>
  </StrictMode>,
)
