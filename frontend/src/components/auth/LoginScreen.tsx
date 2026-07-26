import { Button, Heading, Text, VStack } from '@chakra-ui/react'
import { useAuth } from 'react-oidc-context'

/** 未ログイン時に表示する画面。ボタンでCognitoのログイン画面へ */
export function LoginScreen() {
  const auth = useAuth()

  return (
    <VStack h="100vh" justify="center" gap={6} px={4}>
      <Heading size="2xl">社内マニュアル検索</Heading>
      <Text color="gray.500">
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
        <Text fontSize="sm" color="red.500">
          サインインでエラーが発生しました: {auth.error.message}
        </Text>
      )}
    </VStack>
  )
}
