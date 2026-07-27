import { useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useRef, useState } from 'react'
import { CATEGORIES_QUERY } from '../../graphql/categories'
import {
  CREATE_UPLOAD_URL_MUTATION,
  REGISTER_MANUAL_MUTATION,
} from '../../graphql/manuals'
import { formatSize } from '../../lib/format'

interface UploadManualDialogProps {
  open: boolean
  onClose: () => void
}

// 1ファイル分のアップロード状態
interface UploadItem {
  file: File
  title: string
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
}

function StatusBadge({ item }: { item: UploadItem }) {
  switch (item.status) {
    case 'pending':
      return <Badge colorPalette="gray">待機中</Badge>
    case 'uploading':
      return <Spinner size="xs" />
    case 'done':
      return <Badge colorPalette="green">✅ 完了</Badge>
    case 'error':
      return <Badge colorPalette="red">❌ 失敗</Badge>
  }
}

export function UploadManualDialog({ open, onClose }: UploadManualDialogProps) {
  const [items, setItems] = useState<UploadItem[]>([])
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: categoriesData } = useQuery(CATEGORIES_QUERY)
  const [createUploadUrl] = useMutation(CREATE_UPLOAD_URL_MUTATION)
  const [registerManual] = useMutation(REGISTER_MANUAL_MUTATION, {
    // 登録後に一覧クエリを取り直し、開いているカテゴリ一覧へ即反映する
    refetchQueries: ['Manuals'],
  })

  /** 選択/ドロップされたファイルをリストに追加(PDF以外は弾く) */
  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return
    const files = Array.from(fileList)
    const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    if (pdfs.length < files.length) {
      window.alert('PDF以外のファイルはスキップしました')
    }
    setItems((prev) => [
      ...prev,
      ...pdfs.map((file) => ({
        file,
        // タイトルの初期値はファイル名(拡張子なし)。あとから編集できる
        title: file.name.replace(/\.pdf$/i, ''),
        status: 'pending' as const,
      })),
    ])
  }

  const resetAndClose = () => {
    if (uploading) return // アップロード中は閉じられない
    setItems([])
    setDescription('')
    setCategoryId('')
    onClose()
  }

  /** 1件ずつ順番にアップロード。'done'はスキップするので失敗分の再試行も同じボタン */
  const handleUpload = async () => {
    if (items.length === 0) return
    setUploading(true)

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.status === 'done') continue
      setItems((prev) =>
        prev.map((it, idx) => (idx === i ? { ...it, status: 'uploading' } : it)),
      )
      try {
        // 1) アップロード専用URLをもらう
        const { data } = await createUploadUrl({
          variables: { fileName: item.file.name },
        })
        if (!data) throw new Error('URLの発行に失敗しました')
        const { uploadUrl, fileKey } = data.createManualUploadUrl

        // 2) ストレージへ直接PUT
        const putResponse = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/pdf' },
          body: item.file,
        })
        if (!putResponse.ok) {
          throw new Error(`アップロードに失敗しました (HTTP ${putResponse.status})`)
        }

        // 3) メタデータをDBに登録(取り込みは自動で始まる)
        await registerManual({
          variables: {
            input: {
              title: item.title.trim() || item.file.name,
              // 説明は1件だけのときのみ(まとめてアップロード時は省略)
              description:
                items.length === 1 && description.trim()
                  ? description.trim()
                  : undefined,
              fileKey,
              fileName: item.file.name,
              size: item.file.size,
              categoryId: categoryId || undefined,
            },
          },
        })
        setItems((prev) =>
          prev.map((it, idx) => (idx === i ? { ...it, status: 'done' } : it)),
        )
      } catch (e) {
        setItems((prev) =>
          prev.map((it, idx) =>
            idx === i
              ? {
                  ...it,
                  status: 'error',
                  error: e instanceof Error ? e.message : '不明なエラー',
                }
              : it,
          ),
        )
      }
    }

    setUploading(false)
  }

  const doneCount = items.filter((i) => i.status === 'done').length
  const hasError = items.some((i) => i.status === 'error')
  const allDone = items.length > 0 && doneCount === items.length

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && resetAndClose()}
      size="lg"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>マニュアルをアップロード</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack gap={4} align="stretch">
                {/* ファイル選択/ドロップゾーン */}
                <Box
                  borderWidth="2px"
                  borderStyle="dashed"
                  borderColor="gray.300"
                  borderRadius="md"
                  p={6}
                  textAlign="center"
                  cursor="pointer"
                  _hover={{ borderColor: 'blue.400', bg: 'blue.50' }}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    addFiles(e.dataTransfer.files)
                  }}
                >
                  <Text color="gray.600">
                    クリックして選択、またはここにPDFをドラッグ&ドロップ
                  </Text>
                  <Text fontSize="xs" color="gray.400" mt={1}>
                    複数ファイルをまとめて選択できます
                  </Text>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      addFiles(e.target.files)
                      e.target.value = '' // 同じファイルを選び直せるように
                    }}
                  />
                </Box>

                {/* ファイルごとの状態リスト */}
                {items.length > 0 && (
                  <VStack gap={2} align="stretch" maxH="240px" overflowY="auto">
                    {items.map((item, i) => (
                      <HStack key={`${item.file.name}-${i}`} gap={2}>
                        <StatusBadge item={item} />
                        <Input
                          size="sm"
                          flex="1"
                          value={item.title}
                          disabled={uploading || item.status === 'done'}
                          onChange={(e) =>
                            setItems((prev) =>
                              prev.map((it, idx) =>
                                idx === i ? { ...it, title: e.target.value } : it,
                              ),
                            )
                          }
                        />
                        <Text fontSize="xs" color="gray.500" flexShrink={0}>
                          {formatSize(item.file.size)}
                        </Text>
                        {!uploading && item.status !== 'done' && (
                          <IconButton
                            aria-label="リストから外す"
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setItems((prev) => prev.filter((_, idx) => idx !== i))
                            }
                          >
                            ✕
                          </IconButton>
                        )}
                        {item.error && (
                          <Text fontSize="xs" color="red.500" flexShrink={0}>
                            {item.error}
                          </Text>
                        )}
                      </HStack>
                    ))}
                  </VStack>
                )}

                {/* 説明(1件のときだけ) */}
                {items.length === 1 && (
                  <div>
                    <Text fontSize="sm" mb={1}>
                      説明（任意）
                    </Text>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="どんな内容のマニュアルか"
                    />
                  </div>
                )}

                {/* カテゴリ(全ファイル共通) */}
                <div>
                  <Text fontSize="sm" mb={1}>
                    カテゴリ（任意・全ファイルに適用）
                  </Text>
                  <NativeSelect.Root disabled={uploading}>
                    <NativeSelect.Field
                      value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                    >
                      <option value="">未分類</option>
                      {categoriesData?.manualCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </NativeSelect.Field>
                    <NativeSelect.Indicator />
                  </NativeSelect.Root>
                </div>

                {/* 進捗サマリ */}
                {items.length > 1 && (uploading || doneCount > 0) && (
                  <Text fontSize="sm" color="gray.600">
                    {doneCount} / {items.length} 件完了
                  </Text>
                )}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="ghost" onClick={resetAndClose} disabled={uploading}>
                {allDone ? '閉じる' : 'キャンセル'}
              </Button>
              {!allDone && (
                <Button
                  colorPalette="blue"
                  onClick={handleUpload}
                  loading={uploading}
                  disabled={items.length === 0}
                >
                  {hasError
                    ? '失敗分を再試行'
                    : `アップロード${items.length > 1 ? `（${items.length}件）` : ''}`}
                </Button>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
