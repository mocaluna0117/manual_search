import { Button, Dialog, Portal, Text, VStack } from '@chakra-ui/react'
import type { ReactNode } from 'react'
import { LuMonitor, LuMoon, LuSun } from 'react-icons/lu'
import {
  setSendKey,
  setThemeMode,
  useSendKey,
  useThemeMode,
  type ThemeMode,
} from '../../lib/settings'

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: ReactNode }[] = [
  { value: 'system', label: '端末の設定に合わせる', icon: <LuMonitor /> },
  { value: 'light', label: 'ライト（明るい）', icon: <LuSun /> },
  { value: 'dark', label: 'ダーク（暗い）', icon: <LuMoon /> },
]

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

/** アプリの設定ダイアログ(配色・チャットの送信キー) */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const sendKey = useSendKey()
  const themeMode = useThemeMode()

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
                配色（テーマ）
              </Text>
              <VStack gap={2} align="stretch" mb={6}>
                {THEME_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant={themeMode === option.value ? 'solid' : 'outline'}
                    colorPalette="blue"
                    justifyContent="flex-start"
                    onClick={() => setThemeMode(option.value)}
                  >
                    {option.icon} {option.label}
                  </Button>
                ))}
              </VStack>

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
