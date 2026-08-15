import { useMutation, useQuery } from '@apollo/client/react'
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  Portal,
  Select,
  createListCollection,
  Spinner,
  Text,
  VStack,
} from '@chakra-ui/react'
import { useMemo, useRef, useState } from 'react'
import { LuBot, LuCheck, LuTriangleAlert, LuX } from 'react-icons/lu'
import { CATEGORIES_QUERY } from '../../graphql/categories'
import {
  CREATE_UPLOAD_URL_MUTATION,
  MANUALS_QUERY,
  REGISTER_MANUAL_MUTATION,
  type RegisterOutcome,
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
  outcome?: RegisterOutcome // 完了後: 新規追加 / 既存を更新 / 古いのでスキップ
  // スキップされたときに判定根拠を画面で説明するための日時
  existingDate?: string | null
  incomingDate?: string | null
  error?: string
}

/** 日時を読みやすい形にする(不明ならその旨を返す) */
function formatDate(iso?: string | null): string {
  if (!iso) return '不明'
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function StatusBadge({ item }: { item: UploadItem }) {
  switch (item.status) {
    case 'pending':
      return <Badge colorPalette="gray">待機中</Badge>
    case 'uploading':
      return <Spinner size="xs" />
    case 'done':
      if (item.outcome === 'UPDATED') {
        return <Badge colorPalette="blue">更新</Badge>
      }
      if (item.outcome === 'SKIPPED_OLDER') {
        return <Badge colorPalette="orange">⏭ スキップ</Badge>
      }
      return <Badge colorPalette="green">✅ 完了</Badge>
    case 'error':
      return <Badge colorPalette="red">❌ 失敗</Badge>
  }
}

/** 完了後に「何が起きたか」を1行で説明する */
function outcomeNote(item: UploadItem): string | null {
  switch (item.outcome) {
    case 'UPDATED':
      return '同名の既存マニュアルを、この新しいファイルで置き換えました'
    case 'SKIPPED_OLDER':
      // 判定の根拠になった日時を必ず見せる(なぜスキップされたか分かるように)
      return (
        `既存マニュアルの方が新しいため取り込みませんでした` +
        `（既存: ${formatDate(item.existingDate)} / 今回: ${formatDate(item.incomingDate)}）`
      )
    default:
      return null
  }
}

/** カテゴリ欄の「AIにおまかせ」を表す値(実在のフォルダIDとは別物) */
const AUTO = '__auto'

export function UploadManualDialog({ open, onClose }: UploadManualDialogProps) {
  const [items, setItems] = useState<UploadItem[]>([])
  // おすすめの「AIにおまかせ」を最初から選んでおく
  const [categoryId, setCategoryId] = useState(AUTO)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: categoriesData } = useQuery(CATEGORIES_QUERY)
  // Selectに渡す選択肢(先頭は「未分類」= 値なし)
  const categoryCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: '未分類', value: '' },
          ...(categoriesData?.manualCategories ?? []).map((c) => ({
            label: c.name,
            value: c.id,
          })),
        ],
      }),
    [categoriesData],
  )
  // 既存マニュアルのファイル名一覧(アップロード前に同名を知らせるため)
  const { data: existingData } = useQuery(MANUALS_QUERY, {
    fetchPolicy: 'cache-and-network',
  })
  const existingFileNames = new Set(
    existingData?.manuals.map((m) => m.fileName) ?? [],
  )

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
    setCategoryId(AUTO)
    onClose()
  }

  /** 指定した1件をアップロードして登録する(強制差し替えの再実行にも使う) */
  const uploadOne = async (index: number, forceReplace = false) => {
    const item = items[index]
    if (!item) return
    setItems((prev) =>
      prev.map((it, idx) => (idx === index ? { ...it, status: 'uploading' } : it)),
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
      const { data: registered } = await registerManual({
        variables: {
          input: {
            title: item.title.trim() || item.file.name,
            fileKey,
            fileName: item.file.name,
            size: item.file.size,
            categoryId:
              categoryId && categoryId !== AUTO ? categoryId : undefined,
            // 「AIにおまかせ」なら取り込み完了後に自動でカテゴリが付く
            autoCategorize: categoryId === AUTO || undefined,
            // 同名マニュアルがある場合の新旧判定に使う(ブラウザが持つファイルの更新日時)
            fileLastModified: new Date(item.file.lastModified).toISOString(),
            forceReplace: forceReplace || undefined,
          },
        },
      })
      setItems((prev) =>
        prev.map((it, idx) =>
          idx === index
            ? {
                ...it,
                status: 'done',
                outcome: registered?.registerManual.outcome,
                existingDate: registered?.registerManual.existingFileLastModified,
                incomingDate: registered?.registerManual.incomingFileLastModified,
              }
            : it,
        ),
      )
    } catch (e) {
      setItems((prev) =>
        prev.map((it, idx) =>
          idx === index
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

  /** 1件ずつ順番にアップロード。'done'はスキップするので失敗分の再試行も同じボタン */
  const handleUpload = async () => {
    if (items.length === 0) return
    setUploading(true)
    for (let i = 0; i < items.length; i++) {
      if (items[i].status === 'done') continue
      await uploadOne(i)
    }
    setUploading(false)
  }

  /** スキップされた1件を、判定を無視して差し替える */
  const handleForceReplace = async (index: number) => {
    setUploading(true)
    await uploadOne(index, true)
    setUploading(false)
  }

  const doneCount = items.filter((i) => i.status === 'done').length
  const hasError = items.some((i) => i.status === 'error')
  const allDone = items.length > 0 && doneCount === items.length
  // アップロードボタンが実際に処理する件数(終わったものは対象外)
  const uploadableCount = items.filter((i) => i.status !== 'done').length
  const skippedCount = items.filter(
    (i) => i.outcome === 'SKIPPED_OLDER',
  ).length

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
                  borderColor="border.emphasized"
                  borderRadius="md"
                  p={6}
                  textAlign="center"
                  cursor="pointer"
                  _hover={{ borderColor: 'blue.solid', bg: 'blue.subtle' }}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    addFiles(e.dataTransfer.files)
                  }}
                >
                  <Text color="fg.muted">
                    クリックして選択、またはここにPDFをドラッグ&ドロップ
                  </Text>
                  <Text fontSize="xs" color="fg.subtle" mt={1}>
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
                  <VStack gap={3} align="stretch" maxH="260px" overflowY="auto">
                    {items.map((item, i) => (
                      <Box key={`${item.file.name}-${i}`}>
                        <HStack gap={2}>
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
                          <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                            {formatSize(item.file.size)}
                          </Text>
                          {!uploading && item.status !== 'done' && (
                            <IconButton
                              aria-label="リストから外す"
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                setItems((prev) =>
                                  prev.filter((_, idx) => idx !== i),
                                )
                              }
                            >
                              <LuX />
                            </IconButton>
                          )}
                        </HStack>

                        {/* アップロード前: 同名マニュアルがある場合の予告 */}
                        {item.status === 'pending' &&
                          existingFileNames.has(item.file.name) && (
                            <HStack gap={1} fontSize="xs" color="orange.fg" mt={1} align="flex-start">
                              <LuTriangleAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                              <Text fontSize="xs">
                                同名のマニュアルが既にあります。ファイルの更新日が新しい方だけが残ります
                              </Text>
                            </HStack>
                          )}

                        {/* アップロード後: 何が起きたかの説明 */}
                        {item.status === 'done' && outcomeNote(item) && (
                          <Text
                            fontSize="xs"
                            color={
                              item.outcome === 'UPDATED'
                                ? 'blue.fg'
                                : 'orange.fg'
                            }
                            mt={1}
                          >
                            {outcomeNote(item)}
                          </Text>
                        )}

                        {/* スキップされた場合の逃げ道: 判定を無視して差し替える */}
                        {item.status === 'done' &&
                          item.outcome === 'SKIPPED_OLDER' && (
                            <Button
                              size="xs"
                              variant="outline"
                              colorPalette="orange"
                              mt={1}
                              loading={uploading}
                              onClick={() => void handleForceReplace(i)}
                            >
                              それでも差し替える
                            </Button>
                          )}

                        {item.error && (
                          <Text fontSize="xs" color="fg.error" mt={1}>
                            {item.error}
                          </Text>
                        )}
                      </Box>
                    ))}
                  </VStack>
                )}

                {/* カテゴリ(全ファイル共通)。
                    おすすめの「AIにおまかせ」は<option>だと装飾できないので
                    ドロップダウンの外に出して目立つボタンにする */}
                <div>
                  <Text fontSize="sm" mb={1}>
                    カテゴリ（任意・全ファイルに適用）
                  </Text>
                  <Button
                    w="100%"
                    justifyContent="flex-start"
                    colorPalette="purple"
                    variant={categoryId === AUTO ? 'solid' : 'outline'}
                    disabled={uploading}
                    mb={2}
                    onClick={() =>
                      setCategoryId(categoryId === AUTO ? '' : AUTO)
                    }
                  >
                    <LuBot />
                    <Text>AIにおまかせ（内容から自動分類）</Text>
                    <Box flex="1" />
                    {categoryId === AUTO ? (
                      <LuCheck />
                    ) : (
                      <Badge colorPalette="purple" variant="surface">
                        おすすめ
                      </Badge>
                    )}
                  </Button>
                  {/* ネイティブの<select>はフォルダが増えると上方向に開いて
                      画面外へはみ出すため、位置を指定できるSelectを使う */}
                  <Select.Root
                    collection={categoryCollection}
                    disabled={uploading || categoryId === AUTO}
                    value={[categoryId === AUTO ? '' : categoryId]}
                    onValueChange={(e) => setCategoryId(e.value[0] ?? '')}
                    positioning={{ placement: 'bottom-start', sameWidth: true }}
                    size="sm"
                  >
                    <Select.HiddenSelect />
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="未分類" />
                      </Select.Trigger>
                      <Select.IndicatorGroup>
                        <Select.Indicator />
                      </Select.IndicatorGroup>
                    </Select.Control>
                    <Portal>
                      <Select.Positioner>
                        {/* 候補が多いときはこの中でスクロールさせる */}
                        <Select.Content maxH="240px" overflowY="auto">
                          {categoryCollection.items.map((item) => (
                            <Select.Item item={item} key={item.value}>
                              {item.label}
                              <Select.ItemIndicator />
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Portal>
                  </Select.Root>
                  {categoryId === AUTO && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      内容を読んで自動で振り分けます（合うフォルダが無ければ作成）。
                      フォルダを自分で選ぶ場合は、もう一度ボタンを押して解除してください。
                    </Text>
                  )}
                </div>

                {/* 進捗サマリ */}
                {items.length > 1 && (uploading || doneCount > 0) && !allDone && (
                  <Text fontSize="sm" color="fg.muted">
                    {doneCount} / {items.length} 件完了
                  </Text>
                )}

                {/* 全部終わったときは、次に何ができるかまで伝える。
                    ボタンが押せない理由が分からないままにしない */}
                {allDone && !uploading && (
                  <Text fontSize="sm" color="green.fg">
                    {skippedCount > 0
                      ? `${doneCount - skippedCount}件を取り込みました（${skippedCount}件はスキップ）。`
                      : `${doneCount}件のアップロードが終わりました。`}
                    続けて上げる場合は、上の枠にファイルを追加してください。
                  </Text>
                )}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="ghost" onClick={resetAndClose} disabled={uploading}>
                {allDone ? '閉じる' : 'キャンセル'}
              </Button>
              {/* 終わったあともボタンは出したままにする。消してしまうと
                  「アップロードできなくなった」ように見えるため、
                  押せないことは無効表示で示す(ファイルを足せばまた押せる) */}
              <Button
                colorPalette="blue"
                onClick={handleUpload}
                loading={uploading}
                disabled={uploadableCount === 0}
              >
                {hasError
                  ? '失敗分を再試行'
                  : `アップロード${uploadableCount > 1 ? `（${uploadableCount}件）` : ''}`}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
