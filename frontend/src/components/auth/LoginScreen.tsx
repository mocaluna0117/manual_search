import { Button, Heading, Text, VStack } from '@chakra-ui/react'
import { useAuth } from 'react-oidc-context'

/** 未ログイン時に表示する画面。ボタンでCognitoのログイン画面へ */
export function LoginScreen() {
  const auth = useAuth()

  return (
    <VStack h="100dvh" justify="center" gap={6} px={4}>
      <Heading size="2xl">Manualy</Heading>
      {/* 全角30文字あり、狭い画面では文の途中で折り返して読みにくい。
          スマホでは短い文にする(何をすればよいかは下のボタンで分かる)。
          表示の出し分けはCSSで行うので、開いた瞬間に文が入れ替わらない */}
      <Text color="fg.muted" whiteSpace="nowrap" hideBelow="md">
        このサイトは社内向けです。アカウントでサインインしてください
      </Text>
      <Text color="fg.muted" fontSize="sm" whiteSpace="nowrap" hideFrom="md">
        社内向けのサイトです
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
