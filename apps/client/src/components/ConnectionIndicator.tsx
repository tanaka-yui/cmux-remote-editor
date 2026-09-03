import { useEffect, useRef, useState } from 'react'
import type { ConnectionStatus } from '../hooks/useWebSocket'

// connected 表示中の一瞬の切断・再接続でステータス表示をチラつかせない猶予時間（ms）。
const OFFLINE_GRACE_MS = 2000

interface ConnectionIndicatorProps {
  status: ConnectionStatus
  freshness: string | null
}

const STATUS_CONFIG: Record<ConnectionStatus, { label: string; color: string }> = {
  connected: { label: 'Connected', color: 'var(--color-accent)' },
  connecting: { label: 'Connecting...', color: 'var(--color-warning)' },
  disconnected: { label: 'Disconnected', color: 'var(--color-danger)' },
}

// 接続状態（ドット＋ラベル）とオフラインの鮮度表示。Header の右側に置く。
export function ConnectionIndicator({ status, freshness }: ConnectionIndicatorProps) {
  // 接続済みからの一瞬の切断はチラつかせない。connected は即時、初回接続中(まだ未接続)も即時。
  // connected 表示中の disconnected / connecting だけ OFFLINE_GRACE_MS 遅延して反映する。
  const [shownStatus, setShownStatus] = useState<ConnectionStatus>(status)
  const [shownFreshness, setShownFreshness] = useState<string | null>(freshness)
  const latestFreshness = useRef(freshness)

  useEffect(() => {
    latestFreshness.current = freshness
    if (status === shownStatus) setShownFreshness(freshness)
  }, [freshness, status, shownStatus])

  useEffect(() => {
    if (status === shownStatus) return
    if (shownStatus !== 'connected' || status === 'connected') {
      setShownStatus(status)
      setShownFreshness(latestFreshness.current)
      return
    }
    const t = setTimeout(() => {
      setShownStatus(status)
      setShownFreshness(latestFreshness.current)
    }, OFFLINE_GRACE_MS)
    return () => clearTimeout(t)
  }, [status, shownStatus])

  const config = STATUS_CONFIG[shownStatus]

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
      {shownFreshness && <span style={{ color: 'var(--color-text-subtle)' }}>{shownFreshness}</span>}
      <span
        style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: config.color, display: 'inline-block' }}
      />
      {config.label}
    </span>
  )
}
