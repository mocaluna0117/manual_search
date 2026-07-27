import { useLazyQuery } from '@apollo/client/react'
import {
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  VStack,
} from '@chakra-ui/react'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { MANUAL_DOWNLOAD_URL_QUERY } from '../../graphql/manuals'

interface ManualViewerContextValue {
  /** どの画面からでもこれを呼ぶと、アプリ内モーダルでPDFが開く(pageで特定ページを直接表示) */
  openManual: (id: string, title: string, page?: number | null) => void
}

const ManualViewerContext = createContext<ManualViewerContextValue | null>(null)

export function useManualViewer() {
  const ctx = useContext(ManualViewerContext)
  if (!ctx) {
    throw new Error('useManualViewerはManualViewerProviderの内側で使うこと')
  }
  return ctx
}

/** アプリ全体に「PDFビューアを開く機能」を配るProvider。モーダル本体もここが1つだけ持つ */
export function ManualViewerProvider({ children }: { children: ReactNode }) {
  const [viewing, setViewing] = useState<{ id: string; title: string } | null>(
    null,
  )
  const [url, setUrl] = useState<string | null>(null)

  const [fetchDownloadUrl] = useLazyQuery(MANUAL_DOWNLOAD_URL_QUERY, {
    // 署名付きURLは期限があるので毎回取り直す
    fetchPolicy: 'no-cache',
  })

  const openManual = async (id: string, title: string, page?: number | null) => {
    setViewing({ id, title })
    setUrl(null) // 前のPDFが一瞬見えないようにリセット
    const { data, error } = await fetchDownloadUrl({ variables: { id } })
    if (data) {
      // #page=N はブラウザ内蔵PDFビューアの機能。該当ページを直接表示する
      // (URLフラグメントはサーバーに送られないので署名の検証にも影響しない)
      setUrl(data.manualDownloadUrl + (page ? `#page=${page}` : ''))
    } else if (error) {
      setViewing(null)
      window.alert('このマニュアルは削除された可能性があり、開けませんでした')
    }
  }

  const close = () => {
    setViewing(null)
    setUrl(null)
  }

  return (
    <ManualViewerContext.Provider value={{ openManual }}>
      {children}

      <Dialog.Root
        open={viewing !== null}
        onOpenChange={(e) => !e.open && close()}
        size="cover"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content display="flex" flexDirection="column">
              <Dialog.Header py={3}>
                <HStack justify="space-between" w="100%">
                  <Dialog.Title truncate>📄 {viewing?.title}</Dialog.Title>
                  <HStack gap={2} flexShrink={0}>
                    {url && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(url, '_blank')}
                      >
                        別タブで開く ↗
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={close}>
                      ✕ 閉じる
                    </Button>
                  </HStack>
                </HStack>
              </Dialog.Header>

              <Dialog.Body flex="1" p={0}>
                {url ? (
                  // ブラウザ内蔵のPDFビューアをそのまま埋め込む
                  <iframe
                    src={url}
                    title={viewing?.title ?? 'マニュアル'}
                    style={{ width: '100%', height: '100%', border: 'none' }}
                  />
                ) : (
                  <VStack h="100%" justify="center">
                    <Spinner size="lg" />
                  </VStack>
                )}
              </Dialog.Body>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </ManualViewerContext.Provider>
  )
}
