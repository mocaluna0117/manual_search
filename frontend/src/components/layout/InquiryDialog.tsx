import { useMutation } from '@apollo/client/react'
import {
  Button,
  Dialog,
  Portal,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { LuCircleCheck, LuSend } from 'react-icons/lu'
import { SEND_INQUIRY_MUTATION } from '../../graphql/inquiry'
import { errorMessage, toastError } from '../../lib/toast'

interface InquiryDialogProps {
  open: boolean
  onClose: () => void
}

const MAX_LENGTH = 2000

/** 管理者への問い合わせフォーム。送信するとメールで届く */
export function InquiryDialog({ open, onClose }: InquiryDialogProps) {
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)
  const [sendInquiry, { loading }] = useMutation(SEND_INQUIRY_MUTATION)

  const close = () => {
    setMessage('')
    setSent(false)
    onClose()
  }

  const handleSend = async () => {
    if (!message.trim()) return
    try {
      await sendInquiry({ variables: { message: message.trim() } })
      setSent(true)
      setMessage('')
    } catch (e) {
      toastError('送信できませんでした', errorMessage(e, ''))
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} size="md">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>お問い合わせ</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              {sent ? (
                <VStack gap={3} py={4}>
                  <Text color="green.fg" fontSize="2xl">
                    <LuCircleCheck />
                  </Text>
                  <Text>送信しました。ありがとうございます。</Text>
                  <Text fontSize="sm" color="fg.muted" textAlign="center">
                    内容を確認のうえ、必要に応じてご登録のメールアドレスへ返信します。
                  </Text>
                </VStack>
              ) : (
                <VStack gap={2} align="stretch">
                  <Text fontSize="sm" color="fg.muted">
                    不具合の報告・使い方の質問・追加してほしいマニュアルなど、
                    お気軽にどうぞ。ログイン中のメールアドレスも一緒に送られます。
                  </Text>
                  <Textarea
                    autoFocus
                    rows={7}
                    maxLength={MAX_LENGTH}
                    placeholder="例: 〇〇のマニュアルを探しても出てきません"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <Text fontSize="xs" color="fg.subtle" textAlign="right">
                    {message.length} / {MAX_LENGTH}
                  </Text>
                </VStack>
              )}
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="outline" onClick={close}>
                {sent ? '閉じる' : 'キャンセル'}
              </Button>
              {!sent && (
                <Button
                  colorPalette="blue"
                  loading={loading}
                  disabled={!message.trim()}
                  onClick={() => void handleSend()}
                >
                  <LuSend /> 送信
                </Button>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
