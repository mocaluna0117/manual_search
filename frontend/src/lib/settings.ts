import { useSyncExternalStore } from 'react'

/**
 * アプリ設定(localStorageに保存)。
 * useSyncExternalStoreで購読するので、設定ダイアログでの変更が
 * チャット画面などの利用側に即座に反映される。
 */

/** チャットの送信キー: enter=Enterで送信 / shift-enter=Shift+Enterで送信 */
export type SendKey = 'enter' | 'shift-enter'

const SEND_KEY_STORAGE = 'manualSearch.settings.sendKey'
const listeners = new Set<() => void>()

export function getSendKey(): SendKey {
  try {
    return localStorage.getItem(SEND_KEY_STORAGE) === 'shift-enter'
      ? 'shift-enter'
      : 'enter'
  } catch {
    return 'enter'
  }
}

export function setSendKey(value: SendKey) {
  try {
    localStorage.setItem(SEND_KEY_STORAGE, value)
  } catch {
    // ストレージが使えない環境では保存されないだけ(既定値のまま動く)
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactコンポーネントから設定値を購読する */
export function useSendKey(): SendKey {
  return useSyncExternalStore(subscribe, getSendKey)
}
