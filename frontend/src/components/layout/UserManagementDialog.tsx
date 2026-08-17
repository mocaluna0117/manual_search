import { useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { LuSend, LuTrash2 } from 'react-icons/lu'
import { ME_QUERY, type UserRole } from '../../graphql/me'
import {
  DELETE_USER_MUTATION,
  INVITE_USERS_MUTATION,
  UPDATE_USER_ROLE_MUTATION,
  USERS_QUERY,
  type ManagedUser,
} from '../../graphql/users'
import { errorMessage, toastError, toastSuccess } from '../../lib/toast'

interface UserManagementDialogProps {
  open: boolean
  onClose: () => void
}

/** 一度に招待できる件数(サーバー側の上限と合わせる) */
const MAX_INVITE_AT_ONCE = 30

/**
 * 入力欄の文字列から宛先を取り出す。
 *
 * 貼り付け元がメールの宛先欄・表計算・チャットのどれでも通るように、
 * 改行・カンマ・全角カンマ・セミコロン・空白のどれでも区切りとして扱う。
 * 同じ宛先は1件にまとめる(大文字小文字の違いも同じ扱い)
 */
function parseEmails(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of text.split(/[\s,、;；]+/)) {
    const email = part.trim()
    if (!email) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(email)
  }
  return result
}

/**
 * ユーザー管理(ADMINのみ)。一覧・招待・権限変更・削除ができる。
 * 招待するとCognitoが仮パスワード付きのメールを本人へ送る
 */
export function UserManagementDialog({
  open,
  onClose,
}: UserManagementDialogProps) {
  // 複数行・カンマ区切りで受け取る。1件ずつ招待すると届く時刻が
  // 人によってばらけるので、まとめて送れるようにしている
  const [inviteText, setInviteText] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('MEMBER')
  // 送れなかった宛先とその理由(送れた分は一覧に出るので、ここには残さない)
  const [inviteFailed, setInviteFailed] = useState<
    { email: string; reason: string }[]
  >([])

  const { data: meData } = useQuery(ME_QUERY)
  const { data, loading, error } = useQuery(USERS_QUERY, {
    skip: !open, // ダイアログを開いたときだけ取得する
    fetchPolicy: 'cache-and-network',
  })

  const [inviteUsers, { loading: inviting }] = useMutation(
    INVITE_USERS_MUTATION,
    { refetchQueries: ['Users'] },
  )
  const [updateUserRole] = useMutation(UPDATE_USER_ROLE_MUTATION, {
    refetchQueries: ['Users'],
  })
  const [deleteUser] = useMutation(DELETE_USER_MUTATION, {
    refetchQueries: ['Users'],
  })

  const emails = parseEmails(inviteText)

  const handleInvite = async () => {
    if (emails.length === 0) return
    setInviteFailed([])
    try {
      const { data } = await inviteUsers({
        variables: { emails, role: inviteRole },
      })
      const result = data?.inviteUsers
      if (!result) return
      if (result.invited.length > 0) {
        toastSuccess(
          `${result.invited.length}件に招待を送りました`,
          '仮パスワード付きのメールが同時に届きます',
        )
      }
      // 送れた宛先だけを入力欄から消す。残った分は直してもう一度送れる
      setInviteFailed(result.failed)
      setInviteText(result.failed.map((f) => f.email).join('\n'))
      if (result.failed.length === 0) setInviteRole('MEMBER')
    } catch (e) {
      toastError('招待できませんでした', errorMessage(e, ''))
    }
  }

  const handleToggleRole = async (user: ManagedUser) => {
    const next: UserRole = user.role === 'ADMIN' ? 'MEMBER' : 'ADMIN'
    const label = next === 'ADMIN' ? '管理者(ADMIN)' : '一般(MEMBER)'
    if (!window.confirm(`${user.email ?? user.cognitoSub} を${label}に変更しますか？`))
      return
    try {
      await updateUserRole({
        variables: { cognitoSub: user.cognitoSub, role: next },
      })
    } catch (e) {
      toastError('変更できませんでした', errorMessage(e, ''))
    }
  }

  const handleDelete = async (user: ManagedUser) => {
    if (
      !window.confirm(
        `${user.email ?? user.cognitoSub} を削除しますか？\n(この人の会話履歴も一緒に消えます)`,
      )
    )
      return
    try {
      await deleteUser({ variables: { cognitoSub: user.cognitoSub } })
    } catch (e) {
      toastError('削除できませんでした', errorMessage(e, ''))
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="lg">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>ユーザー管理</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              {/* 招待フォーム */}
              <Text fontSize="sm" fontWeight="medium" mb={2}>
                新しいユーザーを招待
              </Text>
              <Textarea
                size="sm"
                rows={3}
                mb={2}
                placeholder={
                  '例:\ntanaka@example.co.jp\nsuzuki@example.co.jp\n\n改行・カンマ・スペース区切りでまとめて入力できます'
                }
                value={inviteText}
                onChange={(e) => setInviteText(e.target.value)}
              />
              <HStack gap={2} mb={1}>
                <Button
                  size="sm"
                  variant={inviteRole === 'MEMBER' ? 'solid' : 'outline'}
                  colorPalette="gray"
                  onClick={() => setInviteRole('MEMBER')}
                >
                  一般
                </Button>
                <Button
                  size="sm"
                  variant={inviteRole === 'ADMIN' ? 'solid' : 'outline'}
                  colorPalette="purple"
                  onClick={() => setInviteRole('ADMIN')}
                >
                  管理者
                </Button>
                <Box flex="1" />
                <Button
                  size="sm"
                  colorPalette="blue"
                  loading={inviting}
                  disabled={emails.length === 0}
                  onClick={() => void handleInvite()}
                >
                  <LuSend />
                  {emails.length > 1 ? `${emails.length}件をまとめて招待` : '招待'}
                </Button>
              </HStack>
              <Text fontSize="xs" color="fg.muted" mb={inviteFailed.length ? 2 : 4}>
                仮パスワード付きの招待メールが本人に届きます。
                {emails.length > 1 &&
                  `${emails.length}件へ同時に送るので、届く時刻がばらけません。`}
                {emails.length > MAX_INVITE_AT_ONCE &&
                  `一度に招待できるのは${MAX_INVITE_AT_ONCE}件までです。`}
              </Text>

              {/* 送れなかった宛先。入力欄には残してあるので直して送り直せる */}
              {inviteFailed.length > 0 && (
                <Box
                  mb={4}
                  p={2}
                  borderWidth="1px"
                  borderRadius="md"
                  borderColor="border.error"
                >
                  <Text fontSize="xs" color="fg.error" mb={1}>
                    次の{inviteFailed.length}件は招待できませんでした（他の宛先には送信済みです）
                  </Text>
                  <VStack gap={0} align="stretch">
                    {inviteFailed.map((f) => (
                      <Text key={f.email} fontSize="xs" color="fg.muted">
                        {f.email}: {f.reason}
                      </Text>
                    ))}
                  </VStack>
                </Box>
              )}

              {/* ユーザー一覧 */}
              {loading && !data && <Spinner size="sm" />}
              {error && (
                <Text fontSize="sm" color="red.fg">
                  一覧を取得できませんでした: {error.message}
                </Text>
              )}
              <VStack gap={1} align="stretch">
                {data?.users.map((user) => {
                  const isSelf = user.email != null && user.email === meData?.me.email
                  return (
                    <HStack
                      key={user.cognitoSub}
                      gap={2}
                      px={2}
                      py={1.5}
                      borderWidth="1px"
                      borderRadius="md"
                    >
                      <Text fontSize="sm" flex="1" truncate>
                        {user.email ?? '(メール未設定)'}
                        {isSelf && (
                          <Text as="span" color="fg.muted" ms={1}>
                            (自分)
                          </Text>
                        )}
                      </Text>
                      {user.passwordPending && (
                        <Badge colorPalette="orange">招待中</Badge>
                      )}
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette={user.role === 'ADMIN' ? 'purple' : 'gray'}
                        disabled={isSelf} // 自分の権限は変えられない(バックエンドでも防御)
                        title={isSelf ? '自分自身の権限は変更できません' : 'クリックで権限を切り替え'}
                        onClick={() => void handleToggleRole(user)}
                      >
                        {user.role === 'ADMIN' ? '管理者' : '一般'}
                      </Button>
                      <IconButton
                        aria-label="ユーザーを削除"
                        title={isSelf ? '自分自身は削除できません' : 'ユーザーを削除'}
                        size="xs"
                        variant="ghost"
                        color="fg.muted"
                        disabled={isSelf}
                        onClick={() => void handleDelete(user)}
                      >
                        <LuTrash2 />
                      </IconButton>
                    </HStack>
                  )
                })}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="outline" onClick={onClose}>
                閉じる
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
