import type { ConnectionStatus } from '../hooks/useWebSocket'
import { ConnectionIndicator } from './ConnectionIndicator'

interface HeaderProps {
  workspaceName: string | null
  onMenuToggle: () => void
  showMenuButton?: boolean
  // 接続状態＋鮮度表示(旧 footer/StatusBar からヘッダーへ移設)。
  status: ConnectionStatus
  lastUpdated?: number | null
  // 履歴(スクロールバック)モードのトグル。undefined のときボタンを出さない（例: ブラウザサーフェス）。
  historyMode?: boolean
  onToggleHistory?: () => void
  // 設定モーダルを開く。
  onOpenSettings: () => void
}

export function Header({
  workspaceName,
  onMenuToggle,
  showMenuButton = true,
  status,
  lastUpdated,
  historyMode,
  onToggleHistory,
  onOpenSettings,
}: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 44,
        padding: '0 12px',
        backgroundColor: '#16213e',
        color: '#e0e0e0',
        borderBottom: '1px solid #2a2a4e',
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
            color: '#e0e0e0',
            fontSize: 22,
            padding: '4px 8px',
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          &#9776;
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
      {/* 右側グループ: 接続状態＋鮮度(旧 footer)と履歴トグル。 */}
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <ConnectionIndicator status={status} lastUpdated={lastUpdated} historyMode={historyMode} />
        {onToggleHistory && (
          <button
            type="button"
            onClick={onToggleHistory}
            aria-label="Toggle history"
            aria-pressed={historyMode}
            style={{
              background: historyMode ? '#4caf50' : 'none',
              border: '1px solid #2a2a4e',
              borderRadius: 6,
              color: historyMode ? '#16213e' : '#aaa',
              fontSize: 13,
              padding: '4px 10px',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            履歴
          </button>
        )}
        {/* 設定（履歴バッファ等）。履歴ボタンの隣の歯車。 */}
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="設定"
          style={{
            background: 'none',
            border: 'none',
            color: '#aaa',
            fontSize: 19,
            padding: '4px 6px',
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          &#9881;
        </button>
      </div>
    </header>
  )
}
