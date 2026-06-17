import { useEffect, useState } from 'react'
import type { ConnectionStatus } from '../hooks/useWebSocket'

// connected からの一瞬の切断（即再接続）でステータス表示をチラつかせない猶予時間（ms）。
const OFFLINE_GRACE_MS = 2000

interface ConnectionIndicatorProps {
  status: ConnectionStatus
  // 表示中の内容が取得された時刻(epoch ms)。切断/履歴モード時に「いつの内容か」を示す。
  lastUpdated?: number | null
  historyMode?: boolean
}

function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

const STATUS_CONFIG: Record<ConnectionStatus, { label: string; color: string }> = {
  connected: { label: 'Connected', color: 'var(--color-accent)' },
  connecting: { label: 'Connecting...', color: 'var(--color-warning)' },
  disconnected: { label: 'Disconnected', color: 'var(--color-danger)' },
}

// 接続状態（ドット＋ラベル）とオフライン/履歴の鮮度表示。Header の右側に置く。
export function ConnectionIndicator({ status, lastUpdated, historyMode }: ConnectionIndicatorProps) {
  // 接続済みからの一瞬の切断はチラつかせない。connected は即時、初回接続中(まだ未接続)も即時、
  // connected→切断のときだけ OFFLINE_GRACE_MS 遅延して反映する。
  const [shownStatus, setShownStatus] = useState<ConnectionStatus>(status)
  useEffect(() => {
    if (status === shownStatus) return
    if (status === 'connected' || shownStatus !== 'connected') {
      setShownStatus(status)
      return
    }
    const t = setTimeout(() => setShownStatus(status), OFFLINE_GRACE_MS)
    return () => clearTimeout(t)
  }, [status, shownStatus])

  const config = STATUS_CONFIG[shownStatus]

  // 切断中（オフライン保持）や履歴モードでは、表示内容がいつ時点のものかを明示する。
  let notice: string | null = null
  if (historyMode) {
    notice = lastUpdated ? `履歴 · ${formatClock(lastUpdated)}時点` : '履歴'
  } else if (shownStatus !== 'connected' && lastUpdated) {
    notice = `オフライン · 最終 ${formatClock(lastUpdated)}`
  }

  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: 'var(--color-text-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      {notice && <span style={{ color: historyMode ? 'var(--color-accent)' : 'var(--color-warning)' }}>{notice}</span>}
      <span
        style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: config.color, display: 'inline-block' }}
      />
      {config.label}
    </span>
  )
}
