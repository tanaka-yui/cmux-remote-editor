import { Menu, Settings } from 'lucide-react'
import type { ConnectionStatus } from '../hooks/useWebSocket'
import { ConnectionIndicator } from './ConnectionIndicator'

interface HeaderProps {
  workspaceName: string | null
  onMenuToggle: () => void
  showMenuButton?: boolean
  status: ConnectionStatus
  lastUpdated?: number | null
  historyMode?: boolean
  onOpenSettings: () => void
}

export function Header({
  workspaceName,
  onMenuToggle,
  showMenuButton = true,
  status,
  lastUpdated,
  historyMode,
  onOpenSettings,
}: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 44,
        padding: '0 12px',
        backgroundColor: 'var(--color-surface)',
        color: 'var(--color-text)',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}
    >
      {showMenuButton && (
        <button
          type="button"
          onClick={onMenuToggle}
          aria-label="Menu"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text)',
            padding: '4px 8px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Menu size={22} />
        </button>
      )}
      <span
        style={{
          marginLeft: showMenuButton ? 8 : 4,
          flex: 1,
          minWidth: 0,
          fontSize: 15,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {workspaceName ?? 'cmux Remote'}
      </span>
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <ConnectionIndicator status={status} lastUpdated={lastUpdated} historyMode={historyMode} />
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="設定"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-muted)',
            padding: '4px 6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Settings size={19} />
        </button>
      </div>
    </header>
  )
}
