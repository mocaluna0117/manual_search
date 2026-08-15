/** バイト数を人間が読みやすい形式にする(例: 1536000 → "1.5 MB") */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * AIの分類で、同名フォルダがゴミ箱にあるせいで作れなかった分の案内。
 * これを出さないと「押しても分類されない」ようにしか見えない
 */
export function trashedCategoriesNote(names: string[]): string {
  if (names.length === 0) return ''
  return (
    `\n\n⚠️ 次のフォルダは同じ名前がゴミ箱にあるため作れませんでした: ${names.join('、')}` +
    '\n対象のマニュアルは未分類のままです。ゴミ箱から復元するか、完全に削除してから、もう一度実行してください。'
  )
}
