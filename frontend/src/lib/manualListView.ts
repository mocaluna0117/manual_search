import { useState } from 'react'

/** 一覧の表示形式と並び順。画面をまたいで同じ設定を使うのでここに置く */
export type ViewMode = 'details' | 'icons'

export type SortKey = 'name' | 'type' | 'updatedAt' | 'size'

const VIEW_MODE_KEY = 'manualSearch.explorerViewMode'


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

