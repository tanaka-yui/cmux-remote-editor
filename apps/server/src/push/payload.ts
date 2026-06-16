import type { CmuxNotification } from './types'

// 通知 → Service Worker の push ハンドラが showNotification に渡す JSON。
// tag/url に workspace_id を載せ、同一WSの通知を畳み込み・タップで該当WSへ遷移させる。
export function buildPayload(n: CmuxNotification): string {
  const title = n.title || 'cmux'
  const body = [n.subtitle, n.body].filter((s) => s.trim() !== '').join(' — ') || 'New notification'
  return JSON.stringify({
    title,
    body,
    tag: n.workspace_id,
    data: { workspace_id: n.workspace_id, url: `/?workspace=${encodeURIComponent(n.workspace_id)}` },
  })
}
