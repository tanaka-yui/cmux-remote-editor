interface HeaderProps {
  workspaceName: string | null
  onMenuToggle: () => void
  showMenuButton?: boolean
  // 履歴(スクロールバック)モードのトグル。undefined のときボタンを出さない（例: ブラウザサーフェス）。
  historyMode?: boolean
  onToggleHistory?: () => void
}

export function Header({
  workspaceName,
  onMenuToggle,
  showMenuButton = true,
  historyMode,
  onToggleHistory,
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
          fontSize: 15,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {workspaceName ?? 'cmux Remote'}
      </span>
      {onToggleHistory && (
        <button
          type="button"
          onClick={onToggleHistory}
          aria-label="Toggle history"
          aria-pressed={historyMode}
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
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
    </header>
  )
}
