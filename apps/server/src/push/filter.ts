import type { CmuxNotification } from './types'

// Drawer の deriveStatus と一致させた actionable 判定（Needs input / Permission）。
// 未読のもののみ対象にする。
export function isActionable(n: CmuxNotification): boolean {
  if (n.is_read) return false
  const body = n.body.toLowerCase()
  const subtitle = n.subtitle.toLowerCase()
  if (body.includes('waiting for your input') || subtitle === 'waiting') return true
  if (body.includes('permission')) return true
  return false
}
