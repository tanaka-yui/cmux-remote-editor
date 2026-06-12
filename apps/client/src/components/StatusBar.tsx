import { useEffect, useState } from 'react'
import type { ConnectionStatus } from '../hooks/useWebSocket'

// connected からの一瞬の切断（即再接続）でステータス表示をチラつかせない猶予時間（ms）。
const OFFLINE_GRACE_MS = 2000

interface StatusBarProps {
  status: ConnectionStatus
  paneName: string | null
  paneIndex: number
  paneCount: number
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

const DOT_BASE_STYLE = { width: 6, height: 6, borderRadius: '50%', display: 'inline-block' as const }

const STATUS_CONFIG: Record<ConnectionStatus, { label: string; color: string }> = {
  connected: { label: 'Connected', color: '#4caf50' },
  connecting: { label: 'Connecting...', color: '#ff9800' },
  disconnected: { label: 'Disconnected', color: '#f44336' },
}

export function StatusBar({ status, paneName, paneIndex, paneCount, lastUpdated, historyMode }: StatusBarProps) {
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
    <footer
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        // box-sizing:border-box のため、固定 height に paddingBottom(safe-area) を足すと内容領域が
        // その分潰れて borderTop にかぶる(iPhone/iPad)。高さ自体に safe-area を加算して 28px を確保する。
        height: 'calc(28px + env(safe-area-inset-bottom))',
        padding: '0 12px',
        paddingBottom: 'env(safe-area-inset-bottom)',
        backgroundColor: '#16213e',
        borderTop: '1px solid #2a2a4e',
        fontSize: 12,
        color: '#888',
        flexShrink: 0,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>{paneName ?? ''}</span>
        {paneCount > 1 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {Array.from({ length: paneCount }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: pane position indicators have no meaningful unique IDs
              <span key={i} style={{ ...DOT_BASE_STYLE, backgroundColor: i === paneIndex ? '#e0e0e0' : '#444' }} />
            ))}
          </span>
        )}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {notice && <span style={{ color: historyMode ? '#4caf50' : '#ff9800' }}>{notice}</span>}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: config.color,
            display: 'inline-block',
          }}
        />
        {config.label}
      </span>
    </footer>
  )
}
