import { Box, HStack, IconButton, Portal, Text } from '@chakra-ui/react'
import { useEffect, useState, type ReactNode } from 'react'
import { FcFile, FcFolder } from 'react-icons/fc'
import {
  LuBookOpen,
  LuChevronDown,
  LuChevronUp,
  LuClock,
  LuLayoutGrid,
  LuList,
  LuPin,
  LuPinOff,
  LuRefreshCw,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu'
import type { Category } from '../../graphql/categories'
import type { Manual } from '../../graphql/manuals'
import { formatSize } from '../../lib/format'
import { FOLDER_MIME } from '../layout/Sidebar'

/**
 * マニュアル/フォルダの一覧表示(Windowsのエクスプローラー風)。
 * フォルダ閲覧(ManualExplorer)とキーワード検索結果(ManualSearchResults)の
 * 両方から使う共通部品。表示形式・操作・見た目をここに集約する
 */

/** 表示形式(Windowsの「詳細」と「中アイコン」に相当) */
export type ViewMode = 'details' | 'icons'
const VIEW_MODE_KEY = 'manualSearch.explorerViewMode'

export type SortKey = 'name' | 'createdAt' | 'size'

/** 表示形式をlocalStorageに保存して共有する(一覧をどこで開いても同じ形式) */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === 'icons'
        ? 'icons'
        : 'details'
    } catch {
      return 'details'
    }
  })
  const change = (mode: ViewMode) => {
    setViewMode(mode)
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode)
    } catch {
      // 保存できない環境では今回だけ有効
    }
  }
  return [viewMode, change]
}

/** 「2026/08/11 19:59」形式(Windowsの日付列と同じ見た目) */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 取り込み状態の目印(色付きアイコン)。正常時は何も出さない */
export function StatusIcon({ manual }: { manual: Manual }) {
  switch (manual.ingestStatus) {
    case 'PENDING':
    case 'PROCESSING':
      return (
        <Box color="orange.fg" title="取り込み中…" flexShrink={0}>
          <LuClock size={14} />
        </Box>
      )
    case 'FAILED':
      return (
        <Box
          color="fg.error"
          title={manual.ingestError ?? '取り込みに失敗しました'}
          flexShrink={0}
        >
          <LuTriangleAlert size={14} />
        </Box>
      )
    case 'COMPLETED':
      return null
  }
}

/** 詳細/アイコン表示の切替ボタン */
export function ViewModeSwitch({
  viewMode,
  onChange,
}: {
  viewMode: ViewMode
  onChange: (mode: ViewMode) => void
}) {
  return (
    <HStack gap={0} borderWidth="1px" borderRadius="md" overflow="hidden">
      <IconButton
        aria-label="詳細表示"
        title="詳細"
        size="xs"
        borderRadius={0}
        variant={viewMode === 'details' ? 'subtle' : 'ghost'}
        onClick={() => onChange('details')}
      >
        <LuList />
      </IconButton>
      <IconButton
        aria-label="アイコン表示"
        title="中アイコン"
        size="xs"
        borderRadius={0}
        variant={viewMode === 'icons' ? 'subtle' : 'ghost'}
        onClick={() => onChange('icons')}
      >
        <LuLayoutGrid />
      </IconButton>
    </HStack>
  )
}

interface ManualItemListProps {
  viewMode: ViewMode
  /** 一緒に並べるフォルダ(ルート表示のときだけ。検索結果では空) */
  folders?: Category[]
  manuals: Manual[]
  /** マニュアル名の描画(検索結果ではキーワードをハイライトする) */
  renderTitle?: (manual: Manual) => ReactNode
  /** マニュアルの下に出す補足(検索結果の本文抜粋など) */
  renderSubtitle?: (manual: Manual) => ReactNode
  isAdmin: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onOpenManual: (manual: Manual) => void
  onOpenFolder?: (folder: Category) => void
  /** 管理者のみ。省略するとドラッグ移動・右クリック操作を出さない */
  onDropToFolder?: (manualId: string, categoryId: string) => void
  onDeleteManual?: (manual: Manual) => void
  onIngestManual?: (manual: Manual) => void
  onTogglePin?: (manual: Manual) => void
  /** 並べ替え(詳細表示のヘッダー)。省略すると並べ替え不可 */
  sortKey?: SortKey
  sortAsc?: boolean
  onSort?: (key: SortKey) => void
  /** 一括ダウンロード用のチェック。省略するとチェックボックスを出さない */
  checkedIds?: Set<string>
  onToggleCheck?: (id: string) => void
  onToggleCheckAll?: () => void
  /** フォルダのチェック(フォルダ単位でまとめてダウンロードする) */
  checkedFolderIds?: Set<string>
  onToggleFolderCheck?: (id: string) => void
}

/** 一括操作用のチェックボックス(行やタイルのクリックとは独立させる) */
function ItemCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      // 行のクリック(選択)やダブルクリック(開く)を巻き込まない
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={onChange}
      style={{ width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }}
    />
  )
}

export function ManualItemList({
  viewMode,
  folders = [],
  manuals,
  renderTitle,
  renderSubtitle,
  isAdmin,
  selectedId,
  onSelect,
  onOpenManual,
  onOpenFolder,
  onDropToFolder,
  onDeleteManual,
  onIngestManual,
  onTogglePin,
  sortKey,
  sortAsc = true,
  onSort,
  checkedIds,
  onToggleCheck,
  onToggleCheckAll,
  checkedFolderIds,
  onToggleFolderCheck,
}: ManualItemListProps) {
  const selectable = Boolean(checkedIds && onToggleCheck)
  const foldersSelectable = Boolean(checkedFolderIds && onToggleFolderCheck)
  // 全選択の判定は「表示中のフォルダとファイルがすべて入っているか」
  const allChecked =
    manuals.length + folders.length > 0 &&
    manuals.every((m) => checkedIds?.has(m.id)) &&
    (!foldersSelectable || folders.every((f) => checkedFolderIds?.has(f.id)))
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    manual: Manual
  } | null>(null)

  // 右クリックメニューは画面のどこかをクリック/Escで閉じる(Windowsと同じ)。
  // React 18ではクリック系イベント中のuseEffectが同期的に走るため、
  // メニューを開いたイベント自身に反応して即閉じないよう、登録を1tick遅らせる
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const timer = window.setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('keydown', onKey)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  /** 選択・ドロップ先のハイライト(Windows風の青) */
  const highlight = (id: string, isDropTarget = false) => ({
    borderWidth: '2px',
    borderColor:
      dragOverFolderId === id && isDropTarget
        ? 'blue.solid'
        : selectedId === id
          ? 'blue.muted'
          : 'transparent',
    bg: selectedId === id ? 'blue.subtle' : undefined,
    _hover: { bg: selectedId === id ? 'blue.subtle' : 'bg.muted' },
    cursor: 'default',
    userSelect: 'none' as const,
  })

  const folderItemProps = (folder: Category) => ({
    onClick: () => onSelect(folder.id),
    onDoubleClick: () => onOpenFolder?.(folder),
    // フォルダ自体もドラッグできる(サイドバーのゴミ箱へ運ぶため)。
    // マニュアルのドラッグと区別できるよう専用のデータ形式を使う
    draggable: isAdmin,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(FOLDER_MIME, folder.id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isAdmin || !onDropToFolder) return
      // 運んでいるのがフォルダなら、ここは受け皿にしない
      if (e.dataTransfer.types.includes(FOLDER_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOverFolderId(folder.id)
    },
    onDragLeave: () => setDragOverFolderId(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDragOverFolderId(null)
      const manualId = e.dataTransfer.getData('text/plain')
      if (manualId) onDropToFolder?.(manualId, folder.id)
    },
  })

  const manualItemProps = (manual: Manual) => ({
    draggable: isAdmin,
    onClick: () => onSelect(manual.id),
    onDoubleClick: () => onOpenManual(manual),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      // このイベント自身がwindowの「閉じる」リスナーに届くと、
      // 開いた瞬間に閉じてメニューが一度も表示されない
      e.stopPropagation()
      onSelect(manual.id)
      setContextMenu({ x: e.clientX, y: e.clientY, manual })
    },
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData('text/plain', manual.id)
      e.dataTransfer.effectAllowed = 'move'
    },
  })

  /** 詳細表示の列ヘッダー(クリックで並べ替え) */
  const sortHeader = (label: string, key: SortKey, w?: string) => (
    <HStack
      w={w}
      flex={w ? undefined : '1'}
      gap={1}
      cursor={onSort ? 'pointer' : 'default'}
      _hover={onSort ? { color: 'fg' } : undefined}
      onClick={() => onSort?.(key)}
    >
      <Text>{label}</Text>
      {sortKey === key &&
        (sortAsc ? <LuChevronUp size={12} /> : <LuChevronDown size={12} />)}
    </HStack>
  )

  return (
    <>
      {viewMode === 'details' && (
        <Box>
          {/* 列見出しもスクロール中は上端に残す(何の列か見失わないように) */}
          <HStack
            px={2}
            py={2}
            gap={2}
            borderBottomWidth="1px"
            color="fg.muted"
            fontSize="xs"
            position="sticky"
            top={0}
            zIndex={1}
            bg="bg"
          >
            {selectable && (
              <ItemCheckbox
                checked={allChecked}
                onChange={() => onToggleCheckAll?.()}
                label="すべて選択"
              />
            )}
            {sortHeader('名前', 'name')}
            {sortHeader('作成日', 'createdAt', '140px')}
            {sortHeader('サイズ', 'size', '80px')}
          </HStack>

          {folders.map((folder) => (
            <HStack
              key={folder.id}
              px={2}
              py={1}
              gap={2}
              borderRadius="sm"
              {...highlight(folder.id, true)}
              {...folderItemProps(folder)}
            >
              {selectable &&
                (foldersSelectable ? (
                  <ItemCheckbox
                    checked={checkedFolderIds!.has(folder.id)}
                    onChange={() => onToggleFolderCheck!(folder.id)}
                    label={`${folder.name} を選択`}
                  />
                ) : (
                  // 列の位置を合わせるための余白
                  <Box w="15px" flexShrink={0} />
                ))}
              <HStack flex="1" gap={2} minW={0}>
                <Box flexShrink={0}>
                  <FcFolder size={18} />
                </Box>
                <Text fontSize="sm" truncate>
                  {folder.name}
                </Text>
              </HStack>
              <Text w="140px" fontSize="sm" color="fg.muted" flexShrink={0}>
                {formatDateTime(folder.updatedAt)}
              </Text>
              <Text
                w="80px"
                fontSize="sm"
                color="fg.muted"
                flexShrink={0}
                title={`${folder.manualCount ?? 0}件のファイル`}
              >
                {formatSize(folder.totalSize ?? 0)}
              </Text>
            </HStack>
          ))}

          {manuals.map((manual) => (
            <Box key={manual.id}>
              <HStack
                px={2}
                py={1}
                gap={2}
                borderRadius="sm"
                {...highlight(manual.id)}
                {...manualItemProps(manual)}
                title={manual.title}
              >
                {selectable && (
                  <ItemCheckbox
                    checked={checkedIds!.has(manual.id)}
                    onChange={() => onToggleCheck!(manual.id)}
                    label={`${manual.title} を選択`}
                  />
                )}
                <HStack flex="1" gap={2} minW={0}>
                  <Box flexShrink={0}>
                    <FcFile size={18} />
                  </Box>
                  <Text fontSize="sm" truncate>
                    {renderTitle ? renderTitle(manual) : manual.title}
                  </Text>
                  {isAdmin && manual.categoryPinned && (
                    <Box
                      color="fg.muted"
                      flexShrink={0}
                      title="ピン留め済み(AIの再分類では動きません)"
                    >
                      <LuPin size={12} />
                    </Box>
                  )}
                  <StatusIcon manual={manual} />
                </HStack>
                <Text w="140px" fontSize="sm" color="fg.muted" flexShrink={0}>
                  {formatDateTime(manual.pdfCreatedAt ?? undefined)}
                </Text>
                <Text w="80px" fontSize="sm" color="fg.muted" flexShrink={0}>
                  {formatSize(manual.size)}
                </Text>
              </HStack>
              {/* 本文ヒットの抜粋など(検索結果のみ) */}
              {renderSubtitle?.(manual)}
            </Box>
          ))}
        </Box>
      )}

      {viewMode === 'icons' && (
        <Box
          display="grid"
          gridTemplateColumns="repeat(auto-fill, minmax(112px, 1fr))"
          gap={1}
        >
          {folders.map((folder) => (
            <Box
              key={folder.id}
              w="112px"
              px={1}
              py={2}
              borderRadius="md"
              textAlign="center"
              position="relative"
              {...highlight(folder.id, true)}
              {...folderItemProps(folder)}
            >
              <Box display="flex" justifyContent="center">
                <FcFolder size={48} />
              </Box>
              {foldersSelectable && (
                <Box position="absolute" top="1" left="3">
                  <ItemCheckbox
                    checked={checkedFolderIds!.has(folder.id)}
                    onChange={() => onToggleFolderCheck!(folder.id)}
                    label={`${folder.name} を選択`}
                  />
                </Box>
              )}
              <Text fontSize="xs" mt={1} lineClamp={2} wordBreak="break-all">
                {folder.name}
              </Text>
            </Box>
          ))}

          {manuals.map((manual) => (
            <Box
              key={manual.id}
              w="112px"
              px={1}
              py={2}
              borderRadius="md"
              textAlign="center"
              position="relative"
              {...highlight(manual.id)}
              {...manualItemProps(manual)}
              title={manual.title}
            >
              <Box display="flex" justifyContent="center">
                <FcFile size={48} />
              </Box>
              {/* 状態とピンは右上にまとめ、左上はチェックボックスに空ける */}
              <HStack position="absolute" top="1" right="3" gap={1}>
                {isAdmin && manual.categoryPinned && (
                  <Box
                    color="fg.muted"
                    title="ピン留め済み(AIの再分類では動きません)"
                  >
                    <LuPin size={14} />
                  </Box>
                )}
                <StatusIcon manual={manual} />
              </HStack>
              {selectable && (
                <Box position="absolute" top="1" left="3">
                  <ItemCheckbox
                    checked={checkedIds!.has(manual.id)}
                    onChange={() => onToggleCheck!(manual.id)}
                    label={`${manual.title} を選択`}
                  />
                </Box>
              )}
              <Text fontSize="xs" mt={1} lineClamp={2} wordBreak="break-all">
                {renderTitle ? renderTitle(manual) : manual.title}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* 右クリックメニュー(Windows風) */}
      {contextMenu && (
        <Portal>
          <Box
            position="fixed"
            left={`${contextMenu.x}px`}
            top={`${contextMenu.y}px`}
            zIndex={2000}
            bg="bg.panel"
            borderWidth="1px"
            borderRadius="md"
            boxShadow="lg"
            py={1}
            minW="180px"
          >
            <MenuButton onClick={() => onOpenManual(contextMenu.manual)}>
              <LuBookOpen /> 開く
            </MenuButton>
            {isAdmin && onTogglePin && (
              <MenuButton onClick={() => onTogglePin(contextMenu.manual)}>
                {contextMenu.manual.categoryPinned ? (
                  <>
                    <LuPinOff /> ピン留めを解除
                  </>
                ) : (
                  <>
                    <LuPin /> ピン留め(再分類で動かさない)
                  </>
                )}
              </MenuButton>
            )}
            {isAdmin &&
              onIngestManual &&
              contextMenu.manual.ingestStatus === 'FAILED' && (
                <MenuButton onClick={() => onIngestManual(contextMenu.manual)}>
                  <LuRefreshCw /> 再取り込み
                </MenuButton>
              )}
            {isAdmin && onDeleteManual && (
              <MenuButton
                color="fg.error"
                onClick={() => onDeleteManual(contextMenu.manual)}
              >
                <LuTrash2 /> 削除
              </MenuButton>
            )}
          </Box>
        </Portal>
      )}
    </>
  )
}

/** 右クリックメニューの1項目 */
function MenuButton({
  children,
  onClick,
  color,
}: {
  children: ReactNode
  onClick: () => void
  color?: string
}) {
  return (
    <HStack
      as="button"
      w="100%"
      px={3}
      py={2}
      gap={2}
      fontSize="sm"
      color={color}
      _hover={{ bg: 'bg.muted' }}
      onClick={onClick}
    >
      {children}
    </HStack>
  )
}
