import { Button, Heading, Text, VStack } from '@chakra-ui/react'
import { useAuth } from 'react-oidc-context'

/** 未ログイン時に表示する画面。ボタンでCognitoのログイン画面へ */
export function LoginScreen() {
  const auth = useAuth()

  return (
    <VStack h="100dvh" justify="center" gap={6} px={4}>
      <Heading size="2xl">Manualy</Heading>
      <Text color="fg.muted">
        このサイトは社内向けです。アカウントでサインインしてください
      </Text>
      <Button
        size="lg"
        colorPalette="blue"
        onClick={() => void auth.signinRedirect()}
      >
        サインイン
      </Button>
      {auth.error && (
        <Text fontSize="sm" color="fg.error">
          サインインでエラーが発生しました: {auth.error.message}
        </Text>
      )}
    </VStack>
  )
}
