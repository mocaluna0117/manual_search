import { Button, Dialog, Portal, Text, VStack } from '@chakra-ui/react'
import { setSendKey, useSendKey } from '../../lib/settings'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

/** アプリの設定ダイアログ。今はチャットの送信キー切り替えのみ */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const sendKey = useSendKey()

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} size="sm">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>設定</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <Text fontSize="sm" fontWeight="medium" mb={2}>
                メッセージの送信キー
              </Text>
              <VStack gap={2} align="stretch">
                <Button
                  variant={sendKey === 'enter' ? 'solid' : 'outline'}
                  colorPalette="blue"
                  justifyContent="flex-start"
                  onClick={() => setSendKey('enter')}
                >
                  Enter で送信（Shift+Enter で改行）
                </Button>
                <Button
                  variant={sendKey === 'shift-enter' ? 'solid' : 'outline'}
                  colorPalette="blue"
                  justifyContent="flex-start"
                  onClick={() => setSendKey('shift-enter')}
                >
                  Enter で改行（Shift+Enter で送信）
                </Button>
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
