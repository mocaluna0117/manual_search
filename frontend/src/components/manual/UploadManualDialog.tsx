import { useMutation, useQuery } from '@apollo/client/react'
import {
  Button,
  Dialog,
  Input,
  NativeSelect,
  Portal,
  Text,
  Textarea,
  VStack,
} from '@chakra-ui/react'
import { useState } from 'react'
import { CATEGORIES_QUERY } from '../../graphql/categories'
import {
  CREATE_UPLOAD_URL_MUTATION,
  REGISTER_MANUAL_MUTATION,
} from '../../graphql/manuals'

interface UploadManualDialogProps {
  open: boolean
  onClose: () => void
}

export function UploadManualDialog({ open, onClose }: UploadManualDialogProps) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [uploading, setUploading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const { data: categoriesData } = useQuery(CATEGORIES_QUERY)
  const [createUploadUrl] = useMutation(CREATE_UPLOAD_URL_MUTATION)
  const [registerManual] = useMutation(REGISTER_MANUAL_MUTATION, {
    // 登録後に一覧クエリを取り直し、開いているカテゴリ一覧へ即反映する
    refetchQueries: ['Manuals'],
  })

  const handleFileChange = (selected: File | null) => {
    setFile(selected)
    // タイトル未入力なら、ファイル名(拡張子なし)を初期値にする
    if (selected && !title) {
      setTitle(selected.name.replace(/\.pdf$/i, ''))
    }
  }

  const resetAndClose = () => {
    setFile(null)
    setTitle('')
    setDescription('')
    setCategoryId('')
    setErrorMessage('')
    onClose()
  }

  const handleUpload = async () => {
    if (!file || !title.trim()) return
    setUploading(true)
    setErrorMessage('')
    try {
      // 1) アップロード専用URLをもらう
      const { data } = await createUploadUrl({
        variables: { fileName: file.name },
      })
      if (!data) throw new Error('URLの発行に失敗しました')
      const { uploadUrl, fileKey } = data.createManualUploadUrl

      // 2) ストレージへ直接PUT(バックエンドを経由しない)
      const putResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: file,
      })
      if (!putResponse.ok) {
        throw new Error(`アップロードに失敗しました (HTTP ${putResponse.status})`)
      }

      // 3) メタデータをDBに登録
      await registerManual({
        variables: {
          input: {
            title: title.trim(),
            description: description.trim() || undefined,
            fileKey,
            fileName: file.name,
            size: file.size,
            categoryId: categoryId || undefined,
          },
        },
      })

      resetAndClose()
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '不明なエラーです')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && resetAndClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>マニュアルをアップロード</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack gap={4} align="stretch">
                <div>
                  <Text fontSize="sm" mb={1}>
                    PDFファイル *
                  </Text>
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
                  />
                </div>

                <div>
                  <Text fontSize="sm" mb={1}>
                    タイトル *
                  </Text>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例: 経費精算マニュアル"
                  />
                </div>

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

                <div>
                  <Text fontSize="sm" mb={1}>
                    カテゴリ（任意）
                  </Text>
                  <NativeSelect.Root>
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

                {errorMessage && (
                  <Text fontSize="sm" color="red.500">
                    {errorMessage}
                  </Text>
                )}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="ghost" onClick={resetAndClose}>
                キャンセル
              </Button>
              <Button
                colorPalette="blue"
                onClick={handleUpload}
                loading={uploading}
                disabled={!file || !title.trim()}
              >
                アップロード
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}
