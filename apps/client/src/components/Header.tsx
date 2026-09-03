import { Menu, Settings } from 'lucide-react'
import type { ConnectionStatus } from '../hooks/useWebSocket'
import { ConnectionIndicator } from './ConnectionIndicator'

interface HeaderProps {
  workspaceTitle: string | null
  surfaceTitle: string | null
  onMenuToggle: () => void
  showMenuButton?: boolean
  status: ConnectionStatus
  freshness: string | null
  onOpenSettings: () => void
}

export function Header({
  workspaceTitle,
  surfaceTitle,
  onMenuToggle,
  showMenuButton = true,
  status,
  freshness,
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
      <div
        style={{
          marginLeft: showMenuButton ? 8 : 4,
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          fontSize: 15,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--color-text-muted)',
          }}
        >
          {workspaceTitle ?? 'cmux Remote'}
        </span>
        {surfaceTitle && <span style={{ margin: '0 6px', color: 'var(--color-text-muted)', flexShrink: 0 }}>·</span>}
        {surfaceTitle && <span style={{ color: 'var(--color-text)', flexShrink: 0 }}>{surfaceTitle}</span>}
      </div>
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <ConnectionIndicator status={status} freshness={freshness} />
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
