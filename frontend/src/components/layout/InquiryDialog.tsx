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
import { useEffect, useRef, useState } from 'react'
import { LuCircleCheck, LuImage, LuSend, LuX } from 'react-icons/lu'
import { SEND_INQUIRY_MUTATION } from '../../graphql/inquiry'
import { ALLOWED_IMAGE_TYPES, checkImage, fileToBase64 } from '../../lib/image'
import { errorMessage, toastError } from '../../lib/toast'
import { ImagePreview } from '../ui/ImagePreview'

interface InquiryDialogProps {
  open: boolean
  onClose: () => void
}

const MAX_LENGTH = 2000

/** 添付できる枚数(サーバー側と合わせる) */
const MAX_IMAGES = 5

/** 管理者への問い合わせフォーム。送信するとメールで届く */
export function InquiryDialog({ open, onClose }: InquiryDialogProps) {
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)
  // 添付する画面写真(任意・複数可)。プレビュー用のURLも一緒に持つ
  const [images, setImages] = useState<{ file: File; url: string }[]>([])
  // 拡大表示している画像。nullなら閉じている
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [sendInquiry, { loading }] = useMutation(SEND_INQUIRY_MUTATION)

  /** すべての添付を外す(プレビュー用に作ったURLは必ず開放する) */
  const clearImages = () => {
    images.forEach((i) => URL.revokeObjectURL(i.url))
    setImages([])
    setPreviewIndex(null)
  }

  /** 1枚だけ外す */
  const removeImage = (index: number) => {
    const target = images[index]
    if (target) URL.revokeObjectURL(target.url)
    setImages(images.filter((_, i) => i !== index))
    setPreviewIndex(null)
  }

  const close = () => {
    setMessage('')
    clearImages()
    setSent(false)
    onClose()
  }

  /** 選ばれた画像を添付に足す(使えないものは理由を伝えて飛ばす) */
  const addImages = (files: File[]) => {
    if (files.length === 0) return
    const room = MAX_IMAGES - images.length
    if (room <= 0) {
      toastError(`画像は${MAX_IMAGES}枚までです`)
      return
    }
    const rejected: string[] = []
    const accepted: { file: File; url: string }[] = []
    for (const file of files.slice(0, room)) {
      const problem = checkImage(file)
      if (problem) {
        rejected.push(`${file.name || '画像'}: ${problem}`)
        continue
      }
      accepted.push({ file, url: URL.createObjectURL(file) })
    }
    if (rejected.length > 0) {
      toastError('添付できない画像がありました', rejected.join('\n'))
    }
    if (files.length > room) {
      toastError(
        `画像は${MAX_IMAGES}枚までです`,
        `${files.length - room}枚は添付していません`,
      )
    }
    if (accepted.length > 0) setImages([...images, ...accepted])
  }

  /**
   * 貼り付けからも添付できるようにする。
   *
   * 画面を撮ってそのまま貼るのが一番早い。ファイルに保存させると手間が増え、
   * 「伝えるのが面倒だから報告しない」につながる。
   *
   * 入力欄に限らずダイアログを開いている間は拾う(どこを触っていても貼れる)。
   * 文字の貼り付けには手を出さないので、本文の入力は今まで通り
   */
  useEffect(() => {
    if (!open || sent) return
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null)
      if (files.length === 0) return
      e.preventDefault()
      addImages(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  const handleSend = async () => {
    if (!message.trim()) return
    try {
      await sendInquiry({
        variables: {
          message: message.trim(),
          images: await Promise.all(
            images.map(async (i) => ({
              base64: await fileToBase64(i.file),
              format: ALLOWED_IMAGE_TYPES[i.file.type],
            })),
          ),
        },
      })
      setSent(true)
      setMessage('')
      clearImages()
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
                  {images.length > 0 && (
                    <VStack gap={1} align="stretch">
                      {images.map((item, index) => (
                        <HStack
                          key={item.url}
                          gap={2}
                          p={2}
                          borderWidth="1px"
                          borderRadius="md"
                          align="center"
                        >
                          {/* 押すと大きく見られる。送る前に「これで合っているか」を
                              確かめられるようにする */}
                          <Image
                            src={item.url}
                            alt={`添付する画像${index + 1}(押すと拡大)`}
                            boxSize="48px"
                            objectFit="cover"
                            borderRadius="sm"
                            cursor="zoom-in"
                            _hover={{ opacity: 0.8 }}
                            onClick={() => setPreviewIndex(index)}
                          />
                          <Text
                            fontSize="xs"
                            flex="1"
                            truncate
                            cursor="zoom-in"
                            onClick={() => setPreviewIndex(index)}
                          >
                            {item.file.name || `画像${index + 1}`}
                          </Text>
                          <IconButton
                            aria-label="この添付を取り消す"
                            size="xs"
                            variant="ghost"
                            onClick={() => removeImage(index)}
                          >
                            <LuX />
                          </IconButton>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                  {images.length < MAX_IMAGES && (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        alignSelf="flex-start"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <LuImage />
                        {images.length === 0
                          ? '画面の写真を添える'
                          : 'さらに追加'}
                      </Button>
                      <Text fontSize="xs" color="fg.subtle">
                        貼り付け（Ctrl+V / ⌘V）でも添えられます。
                        {MAX_IMAGES}枚まで、1枚4MBまで
                      </Text>
                    </>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      addImages(Array.from(e.target.files ?? []))
                      e.target.value = '' // 同じ画像を選び直せるように
                    }}
                  />
                </VStack>
              )}
            </Dialog.Body>

            {/* 添付画像の拡大表示。問い合わせの入力内容は残したまま見られる */}
            <ImagePreview
              src={
                previewIndex !== null
                  ? (images[previewIndex]?.url ?? null)
                  : null
              }
              label={
                previewIndex !== null
                  ? images[previewIndex]?.file.name ||
                    `画像${previewIndex + 1}`
                  : undefined
              }
              onClose={() => setPreviewIndex(null)}
            />

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
