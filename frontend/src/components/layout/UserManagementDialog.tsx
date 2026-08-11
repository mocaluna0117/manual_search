import { useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  Portal,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { LuTrash2 } from 'react-icons/lu'
import { ME_QUERY, type UserRole } from '../../graphql/me'
import {
  DELETE_USER_MUTATION,
  INVITE_USER_MUTATION,
  UPDATE_USER_ROLE_MUTATION,
  USERS_QUERY,
  type ManagedUser,
} from '../../graphql/users'

interface UserManagementDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * ユーザー管理(ADMINのみ)。一覧・招待・権限変更・削除ができる。
 * 招待するとCognitoが仮パスワード付きのメールを本人へ送る
 */
export function UserManagementDialog({
  open,
  onClose,
}: UserManagementDialogProps) {
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('MEMBER')

  const { data: meData } = useQuery(ME_QUERY)
  const { data, loading, error } = useQuery(USERS_QUERY, {
    skip: !open, // ダイアログを開いたときだけ取得する
    fetchPolicy: 'cache-and-network',
  })

  const [inviteUser, { loading: inviting }] = useMutation(
    INVITE_USER_MUTATION,
    { refetchQueries: ['Users'] },
  )
  const [updateUserRole] = useMutation(UPDATE_USER_ROLE_MUTATION, {
    refetchQueries: ['Users'],
  })
  const [deleteUser] = useMutation(DELETE_USER_MUTATION, {
    refetchQueries: ['Users'],
  })

  const handleInvite = async () => {
    const email = inviteEmail.trim()
    if (!email) return
    try {
      await inviteUser({ variables: { email, role: inviteRole } })
      setInviteEmail('')
      setInviteRole('MEMBER')
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '招待できませんでした')
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
      window.alert(e instanceof Error ? e.message : '変更できませんでした')
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
      window.alert(e instanceof Error ? e.message : '削除できませんでした')
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
              <HStack gap={2} mb={1}>
                <Input
                  size="sm"
                  type="email"
                  placeholder="メールアドレス"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
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
                <Button
                  size="sm"
                  colorPalette="blue"
                  loading={inviting}
                  disabled={!inviteEmail.trim()}
                  onClick={() => void handleInvite()}
                >
                  招待
                </Button>
              </HStack>
              <Text fontSize="xs" color="fg.muted" mb={4}>
                仮パスワード付きの招待メールが本人に届きます
              </Text>

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
