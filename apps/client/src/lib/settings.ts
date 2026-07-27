// ライブ表示で上へ遡れるスクロールバック行数の設定。localStorage に永続化する。値は毎秒
// ポーリングの readText scrollback lines に渡る。多すぎると取得/描画が重くなるためクランプする。
const KEY = 'cmux:history-lines'

export const HISTORY_LINES_MIN = 1000
export const HISTORY_LINES_MAX = 100000
export const HISTORY_LINES_DEFAULT = 2000

export function clampHistoryLines(n: number): number {
  if (!Number.isFinite(n)) return HISTORY_LINES_DEFAULT
  return Math.min(HISTORY_LINES_MAX, Math.max(HISTORY_LINES_MIN, Math.round(n)))
}

export function loadHistoryLines(): number {
  if (typeof localStorage === 'undefined') return HISTORY_LINES_DEFAULT
  const raw = localStorage.getItem(KEY)
  if (raw === null) return HISTORY_LINES_DEFAULT
  return clampHistoryLines(Number.parseInt(raw, 10))
}

export function saveHistoryLines(n: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, String(clampHistoryLines(n)))
}

// Web Push 通知の有効フラグ。実際の購読状態は SW の pushManager.getSubscription() が真実だが、
// トグルの楽観的初期表示用に localStorage にも保持する。
const PUSH_ENABLED_KEY = 'cmux:push-enabled'

export function loadPushEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(PUSH_ENABLED_KEY) === 'true'
}

export function savePushEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(PUSH_ENABLED_KEY, enabled ? 'true' : 'false')
}
