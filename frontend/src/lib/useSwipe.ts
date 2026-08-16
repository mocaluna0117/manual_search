import { useEffect } from 'react'

/** これ以上動かしたらスワイプとみなす距離(px) */
const THRESHOLD = 60

/** 画面の左端から何pxまでを「引き出しを開く操作」の起点にするか */
const EDGE_WIDTH = 24

/**
 * 縦スクロールと取り違えないための判定。
 * 横の移動量が縦より大きいときだけスワイプとして扱う
 */
function isHorizontal(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy)
}

/**
 * 画面の左端から右へなぞったら開く(スマホの引き出し操作)。
 *
 * 起点を左端に限るのが要点。画面のどこからでも拾うと、一覧を横に
 * スクロールしたり文字を選んだりする操作を奪ってしまう。
 */
export function useEdgeSwipeOpen(enabled: boolean, onOpen: () => void) {
  useEffect(() => {
    if (!enabled) return
    let startX = 0
    let startY = 0
    let tracking = false

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      tracking = touch.clientX <= EDGE_WIDTH
      startX = touch.clientX
      startY = touch.clientY
    }
    const onMove = (e: TouchEvent) => {
      if (!tracking) return
      const touch = e.touches[0]
      if (!touch) return
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (dx > THRESHOLD && isHorizontal(dx, dy)) {
        tracking = false
        onOpen()
      }
    }
    const onEnd = () => {
      tracking = false
    }

    // passive: ブラウザのスクロールを妨げない(この操作では止める必要がない)
    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled, onOpen])
}

/**
 * 要素の上で左へなぞったら閉じる。開いている引き出しに付ける。
 * 戻り値をそのまま要素へ展開して使う
 */
export function useSwipeToClose(onClose: () => void) {
  let startX = 0
  let startY = 0
  let tracking = false

  return {
    onTouchStart: (e: React.TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      tracking = true
      startX = touch.clientX
      startY = touch.clientY
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!tracking) return
      const touch = e.touches[0]
      if (!touch) return
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (dx < -THRESHOLD && isHorizontal(dx, dy)) {
        tracking = false
        onClose()
      }
    },
    onTouchEnd: () => {
      tracking = false
    },
  }
}
