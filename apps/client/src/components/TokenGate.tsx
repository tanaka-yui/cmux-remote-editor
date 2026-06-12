import { useState } from 'react'

interface TokenGateProps {
  onSubmit: (token: string) => void
}

export function TokenGate({ onSubmit }: TokenGateProps) {
  const [value, setValue] = useState('')
  const token = value.trim()

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (token) onSubmit(token)
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 12,
        height: 'var(--app-height)',
        maxWidth: 420,
        margin: '0 auto',
        padding: 24,
        backgroundColor: '#1a1a2e',
        color: '#e0e0e0',
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>cmux Remote</h1>
      <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>
        接続には認証トークンが必要です。サーバー側の <code>pnpm start</code> の完了メッセージ（または{' '}
        <code>pnpm server:logs</code>）に表示されるトークンを貼り付けてください。
      </p>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="認証トークン"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        // 16px+ keeps iOS Safari from auto-zooming the focused input.
        style={{
          padding: '10px 12px',
          fontSize: 16,
          color: '#e0e0e0',
          backgroundColor: '#16213e',
          border: '1px solid #2a2a4e',
          borderRadius: 8,
          outline: 'none',
        }}
      />
      <button
        type="submit"
        disabled={!token}
        style={{
          padding: '10px 12px',
          fontSize: 15,
          fontWeight: 600,
          color: '#e0e0e0',
          backgroundColor: '#2e5cb8',
          border: 'none',
          borderRadius: 8,
          cursor: token ? 'pointer' : 'default',
          opacity: token ? 1 : 0.5,
        }}
      >
        接続
      </button>
    </form>
  )
}
