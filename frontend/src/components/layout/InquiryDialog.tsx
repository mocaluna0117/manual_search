import { useMutation } from '@apollo/client/react'
import {
  Button,
  Dialog,
  HStack,
  IconButton,
  Image,
  Portal,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useRef, useState } from 'react'
import { LuCircleCheck, LuImage, LuSend, LuX } from 'react-icons/lu'
import { SEND_INQUIRY_MUTATION } from '../../graphql/inquiry'
import {
  ALLOWED_IMAGE_TYPES,
  checkImage,
  fileToBase64,
} from '../../lib/image'
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
  // 添付する画面写真(任意)。プレビュー用のURLも一緒に持つ
  const [image, setImage] = useState<{ file: File; url: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [sendInquiry, { loading }] = useMutation(SEND_INQUIRY_MUTATION)

  const clearImage = () => {
    // プレビュー用に作ったURLは、使い終わったら開放する
    if (image) URL.revokeObjectURL(image.url)
    setImage(null)
  }

  const close = () => {
    setMessage('')
    clearImage()
    setSent(false)
    onClose()
  }

  const pickImage = (file: File | undefined) => {
    if (!file) return
    const problem = checkImage(file)
    if (problem) {
      toastError('この画像は使えません', problem)
      return
    }
    clearImage()
    setImage({ file, url: URL.createObjectURL(file) })
  }

  const handleSend = async () => {
    if (!message.trim()) return
    try {
      await sendInquiry({
        variables: {
          message: message.trim(),
          imageBase64: image ? await fileToBase64(image.file) : undefined,
          imageFormat: image
            ? ALLOWED_IMAGE_TYPES[image.file.type]
            : undefined,
        },
      })
      setSent(true)
      setMessage('')
      clearImage()
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

                  {/* 画面写真の添付。言葉で説明しにくい不具合を伝えやすくする */}
                  {image ? (
                    <HStack
                      gap={2}
                      p={2}
                      borderWidth="1px"
                      borderRadius="md"
                      align="center"
                    >
                      <Image
                        src={image.url}
                        alt="添付する画像"
                        boxSize="48px"
                        objectFit="cover"
                        borderRadius="sm"
                      />
                      <Text fontSize="xs" flex="1" truncate>
                        {image.file.name}
                      </Text>
                      <IconButton
                        aria-label="添付を取り消す"
                        size="xs"
                        variant="ghost"
                        onClick={clearImage}
                      >
                        <LuX />
                      </IconButton>
                    </HStack>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      alignSelf="flex-start"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <LuImage /> 画面の写真を添える
                    </Button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      pickImage(e.target.files?.[0])
                      e.target.value = '' // 同じ画像を選び直せるように
                    }}
                  />
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
