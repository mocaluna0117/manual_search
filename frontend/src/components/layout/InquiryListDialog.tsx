import { useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Image,
  Portal,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { LuCheck, LuInbox, LuRotateCcw } from 'react-icons/lu'
import { ImagePreview } from '../ui/ImagePreview'
import { errorMessage, toastError } from '../../lib/toast'
import {
  INQUIRIES_QUERY,
  INQUIRY_COUNTS_QUERY,
  SET_INQUIRY_HANDLED_MUTATION,
  type InquiryItem,
} from '../../graphql/inquiryAdmin'

interface InquiryListDialogProps {
  open: boolean
  onClose: () => void
}

/** 表示する期間のプリセット。0は全件 */
const PERIODS = [
  { label: '過去30日', days: 30 },
  { label: '過去90日', days: 90 },
  { label: '全件', days: 0 },
]

/** 日時を「8/15 14:03」の形にする */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 届いた問い合わせを画面で確認する(ADMIN専用)。
 *
 * これまで問い合わせを受け取る手段はメールだけで、迷惑メールに入ったり
 * 見落としたりすると気づけなかった。添付画像もメールにしか載せていなかったため、
 * 「うまくいかない画面」の写真ごと辿れなくなっていた。
 * ここで一覧として追えるようにし、対応済みの印も付けられるようにする。
 */
export function InquiryListDialog({ open, onClose }: InquiryListDialogProps) {
  const [days, setDays] = useState<number>(30)
  const [onlyUnhandled, setOnlyUnhandled] = useState(false)
  const [preview, setPreview] = useState<{ url: string; label?: string } | null>(
    null,
  )

  const { data, loading, error, refetch } = useQuery(INQUIRIES_QUERY, {
    variables: { days: days || null },
    skip: !open,
    // 開くたびに最新を取る(メールの代わりなので取りこぼしを避ける)
    fetchPolicy: 'cache-and-network',
  })
  const [setHandled] = useMutation(SET_INQUIRY_HANDLED_MUTATION, {
    // バッジの件数も一緒に更新する
    refetchQueries: [INQUIRY_COUNTS_QUERY],
  })

  const all = data?.inquiries ?? []
  const items = onlyUnhandled ? all.filter((i) => !i.handledAt) : all
  const unhandledCount = all.filter((i) => !i.handledAt).length

  const toggle = async (item: InquiryItem) => {
    try {
      await setHandled({
        variables: { id: item.id, handled: !item.handledAt },
      })
      await refetch()
    } catch (e) {
      toastError('切り替えられませんでした', errorMessage(e, ''))
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && onClose()}
      // 狭い画面では全画面にする(横がはみ出して読めなくなるため)
      size={{ base: 'full', md: 'xl' }}
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                <HStack gap={2}>
                  <LuInbox />
                  <Text>お問い合わせ</Text>
                  {unhandledCount > 0 && (
                    <Badge colorPalette="orange">未対応 {unhandledCount}</Badge>
                  )}
                </HStack>
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <HStack gap={2} mb={3} flexWrap="wrap">
                {PERIODS.map((p) => (
                  <Button
                    key={p.days}
                    size="xs"
                    variant={days === p.days ? 'solid' : 'outline'}
                    colorPalette="blue"
                    onClick={() => setDays(p.days)}
                  >
                    {p.label}
                  </Button>
                ))}
                <Button
                  size="xs"
                  variant={onlyUnhandled ? 'solid' : 'outline'}
                  colorPalette="orange"
                  onClick={() => setOnlyUnhandled((v) => !v)}
                >
                  未対応のみ
                </Button>
              </HStack>

              {loading && all.length === 0 && <Spinner size="sm" />}
              {error && (
                <Text fontSize="sm" color="fg.error">
                  読み込めませんでした: {error.message}
                </Text>
              )}
              {!loading && items.length === 0 && (
                <Text fontSize="sm" color="fg.muted">
                  {onlyUnhandled
                    ? '未対応の問い合わせはありません。'
                    : 'この期間に問い合わせはありません。'}
                </Text>
              )}

              <VStack align="stretch" gap={3}>
                {items.map((item) => (
                  <Box
                    key={item.id}
                    borderWidth="1px"
                    borderRadius="md"
                    p={3}
                    // 未対応を目立たせる(対応済みは落ち着かせる)
                    borderColor={item.handledAt ? 'border' : 'orange.emphasized'}
                    opacity={item.handledAt ? 0.7 : 1}
                  >
                    <HStack justify="space-between" align="start" gap={2}>
                      <VStack align="start" gap={0} minW={0}>
                        <Text fontSize="xs" color="fg.muted" truncate>
                          {item.userEmail ?? '送信者不明'}
                        </Text>
                        <Text fontSize="xs" color="fg.muted">
                          {formatWhen(item.createdAt)}
                          {item.handledAt &&
                            ` ・対応済み ${formatWhen(item.handledAt)}`}
                        </Text>
                      </VStack>
                      <Button
                        size="xs"
                        flexShrink={0}
                        variant={item.handledAt ? 'outline' : 'solid'}
                        colorPalette={item.handledAt ? 'gray' : 'green'}
                        onClick={() => void toggle(item)}
                      >
                        {item.handledAt ? (
                          <>
                            <LuRotateCcw /> 未対応に戻す
                          </>
                        ) : (
                          <>
                            <LuCheck /> 対応済みにする
                          </>
                        )}
                      </Button>
                    </HStack>

                    <Text fontSize="sm" whiteSpace="pre-wrap" mt={2}>
                      {item.message}
                    </Text>

                    {item.imageUrls.length > 0 && (
                      <HStack gap={2} mt={2} flexWrap="wrap">
                        {item.imageUrls.map((url, i) => (
                          <Image
                            key={url}
                            src={url}
                            alt={`添付画像${i + 1}`}
                            maxH="80px"
                            borderRadius="sm"
                            borderWidth="1px"
                            cursor="zoom-in"
                            onClick={() =>
                              setPreview({
                                url,
                                label: `${item.userEmail ?? '送信者不明'} の添付画像${i + 1}`,
                              })
                            }
                          />
                        ))}
                      </HStack>
                    )}
                  </Box>
                ))}
              </VStack>
            </Dialog.Body>

            <ImagePreview
              src={preview?.url ?? null}
              label={preview?.label}
              onClose={() => setPreview(null)}
            />

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
