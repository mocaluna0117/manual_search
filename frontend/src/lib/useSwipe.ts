import { useEffect, useRef } from 'react'

/** これ以上動かしたらスワイプとみなす距離(px) */
const THRESHOLD = 50

/**
 * 「引き出しを開く操作」の起点にする範囲(画面左からの割合と上限px)。
 *
 * 画面のいちばん外側だけを起点にすると、iOSのSafariが「前の画面へ戻る」の
 * ジェスチャーとして先に横取りしてしまい、こちらまで指の動きが届かない。
 * そのため少し内側まで広げて拾う。
 */
const START_ZONE_RATIO = 0.3
const START_ZONE_MAX = 140

/** その位置から開く操作を始めてよいか */
function inStartZone(x: number): boolean {
  return x <= Math.min(window.innerWidth * START_ZONE_RATIO, START_ZONE_MAX)
}

/**
 * 縦スクロールと取り違えないための判定。
 * 内側から拾う分だけ誤作動しやすくなるので、はっきり横向きのときだけ通す
 */
function isHorizontal(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy) * 1.5
}

/**
 * 画面の左側から右へなぞったら開く(スマホの引き出し操作)。
 *
 * 起点を左側に限るのが要点。画面のどこからでも拾うと、一覧を横に
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
      tracking = inStartZone(touch.clientX)
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
  // 指を置いてから動かすまでの間に画面が描き直されることがある。
  // 普通の変数だと作り直されて「触り始めた位置」を見失うのでrefで持つ
  const start = useRef<{ x: number; y: number } | null>(null)

  return {
    onTouchStart: (e: React.TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      start.current = { x: touch.clientX, y: touch.clientY }
    },
    onTouchMove: (e: React.TouchEvent) => {
      const from = start.current
      const touch = e.touches[0]
      if (!from || !touch) return
      const dx = touch.clientX - from.x
      const dy = touch.clientY - from.y
      if (dx < -THRESHOLD && isHorizontal(dx, dy)) {
        start.current = null
        onClose()
      }
    },
    onTouchEnd: () => {
      start.current = null
    },
  }
}
