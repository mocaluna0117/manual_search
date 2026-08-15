import { useMutation, useQuery } from '@apollo/client/react'
import { Box, Button, HStack, Spinner, Text } from '@chakra-ui/react'
import { useState } from 'react'
import { LuRotateCcw, LuTrash2 } from 'react-icons/lu'
import {
  EMPTY_TRASH_MUTATION,
  PURGE_MANUALS_MUTATION,
  RESTORE_MANUALS_MUTATION,
  TRASHED_MANUALS_QUERY,
} from '../../graphql/manuals'
import { ME_QUERY } from '../../graphql/me'
import {
  ManualItemList,
  ViewModeSwitch,
  formatDateTime,
  useViewMode,
} from './ManualItemList'
import { useManualViewer } from './ManualViewerProvider'

/** ゴミ箱に入れてから自動削除されるまでの日数(サーバー側の設定と合わせる) */
const RETENTION_DAYS = 30

/**
 * ゴミ箱。削除したマニュアルを一定期間ここに置き、元に戻せるようにする。
 * 一覧の見た目は通常のフォルダ表示と同じ部品を使う
 */
export function TrashView() {
  const { data, loading } = useQuery(TRASHED_MANUALS_QUERY, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: meData } = useQuery(ME_QUERY)
  const isAdmin = meData?.me.role === 'ADMIN'
  const { openManual } = useManualViewer()
  const [viewMode, changeViewMode] = useViewMode()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const refetch = {
    refetchQueries: ['TrashedManuals', 'Manuals', 'ManualCategories'],
  }
  const [restoreManuals] = useMutation(RESTORE_MANUALS_MUTATION, refetch)
  const [purgeManuals] = useMutation(PURGE_MANUALS_MUTATION, refetch)
  const [emptyTrash] = useMutation(EMPTY_TRASH_MUTATION, refetch)

  const manuals = data?.trashedManuals ?? []

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await action()
      setCheckedIds(new Set())
      window.alert(done)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : '実行できませんでした')
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = () =>
    run(
      () => restoreManuals({ variables: { ids: [...checkedIds] } }),
      `${checkedIds.size}件を元に戻しました。元のフォルダに表示されます。`,
    )

  const handlePurge = () => {
    if (
      !window.confirm(
        `選択した${checkedIds.size}件を完全に削除します。\nこの操作は取り消せません。よろしいですか？`,
      )
    )
      return
    return run(
      () => purgeManuals({ variables: { ids: [...checkedIds] } }),
      `${checkedIds.size}件を完全に削除しました。`,
    )
  }

  const handleEmpty = () => {
    if (
      !window.confirm(
        `ゴミ箱の${manuals.length}件をすべて完全に削除します。\nこの操作は取り消せません。よろしいですか？`,
      )
    )
      return
    return run(() => emptyTrash(), 'ゴミ箱を空にしました。')
  }

  return (
    <Box
      p={{ base: 4, md: 6 }}
      pt={{ base: 14, md: 6 }}
      h="100%"
      overflowY="auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedId(null)
      }}
    >
      <HStack mb={4} gap={2} flexWrap="wrap">
        <HStack gap={2} fontWeight="bold">
          <LuTrash2 />
          <Text>ゴミ箱</Text>
        </HStack>
        {data && (
          <Text fontSize="sm" color="fg.muted">
            {manuals.length}件
          </Text>
        )}
        <Box flex="1" />
        {checkedIds.size > 0 && (
          <>
            <Button
              size="xs"
              colorPalette="blue"
              variant="outline"
              loading={busy}
              onClick={() => void handleRestore()}
            >
              <LuRotateCcw /> 選択した{checkedIds.size}件を元に戻す
            </Button>
            <Button
              size="xs"
              colorPalette="red"
              variant="outline"
              loading={busy}
              onClick={() => void handlePurge()}
            >
              <LuTrash2 /> 完全に削除
            </Button>
          </>
        )}
        {manuals.length > 0 && checkedIds.size === 0 && (
          <Button
            size="xs"
            colorPalette="red"
            variant="outline"
            loading={busy}
            onClick={() => void handleEmpty()}
          >
            <LuTrash2 /> ゴミ箱を空にする
          </Button>
        )}
        <ViewModeSwitch viewMode={viewMode} onChange={changeViewMode} />
      </HStack>

      {loading && !data && <Spinner />}

      <ManualItemList
        viewMode={viewMode}
        manuals={manuals}
        isAdmin={isAdmin}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenManual={(manual) => openManual(manual.id, manual.title)}
        checkedIds={checkedIds}
        onToggleCheck={(id) =>
          setCheckedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
        onToggleCheckAll={() =>
          setCheckedIds((prev) =>
            manuals.every((m) => prev.has(m.id))
              ? new Set()
              : new Set(manuals.map((m) => m.id)),
          )
        }
        // 捨てた日時を名前の下に出す(いつ消えるかの目安になる)
        renderSubtitle={(manual) =>
          viewMode === 'details' && manual.deletedAt ? (
            <Text fontSize="xs" color="fg.muted" pl={9} pb={1}>
              {formatDateTime(manual.deletedAt)} に削除
            </Text>
          ) : null
        }
      />

      {!loading && manuals.length === 0 && (
        <Text mt={6} color="fg.muted" fontSize="sm">
          ゴミ箱は空です
        </Text>
      )}

      {manuals.length > 0 && (
        <Text mt={6} fontSize="xs" color="fg.subtle">
          ゴミ箱の中身は検索・AIの回答には出てきません。
          削除から{RETENTION_DAYS}日が過ぎたものは自動的に完全削除されます。
        </Text>
      )}
    </Box>
  )
}
