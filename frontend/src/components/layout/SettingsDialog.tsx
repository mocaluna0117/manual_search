import { Button, Dialog, Portal, Text, VStack } from '@chakra-ui/react'
import type { ReactNode } from 'react'
import { LuColumns2, LuMonitor, LuMoon, LuSun } from 'react-icons/lu'
import {
  setLayoutMode,
  setSendKey,
  setThemeMode,
  useLayoutMode,
  useSendKey,
  useThemeMode,
  type LayoutMode,
  type ThemeMode,
} from '../../lib/settings'

const LAYOUT_OPTIONS: { value: LayoutMode; label: string; hint: string }[] = [
  {
    value: 'single',
    label: '左に1枚（現状のまま）',
    hint: 'チャットとマニュアルを左サイドバーにまとめる',
  },
  {
    value: 'chat-left',
    label: 'チャット左・マニュアル右',
    hint: '2枚に分けて表示する',
  },
  {
    value: 'chat-right',
    label: 'マニュアル左・チャット右',
    hint: '2枚に分けて表示する',
  },
]

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
  const layoutMode = useLayoutMode()

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
                画面の並び（パソコン表示のみ）
              </Text>
              <VStack gap={2} align="stretch" mb={6}>
                {LAYOUT_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant={layoutMode === option.value ? 'solid' : 'outline'}
                    colorPalette="blue"
                    justifyContent="flex-start"
                    h="auto"
                    py={2}
                    onClick={() => setLayoutMode(option.value)}
                  >
                    <LuColumns2 />
                    <VStack gap={0} align="start">
                      <Text>{option.label}</Text>
                      <Text
                        fontSize="xs"
                        opacity={0.8}
                        fontWeight="normal"
                      >
                        {option.hint}
                      </Text>
                    </VStack>
                  </Button>
                ))}
              </VStack>

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
