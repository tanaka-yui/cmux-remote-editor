import type { CSSProperties } from 'react'

interface BrowserViewProps {
  url: string
  title: string
}

// Most real sites (Google, AWS, GitHub) return X-Frame-Options / CSP
// frame-ancestors and refuse to render in an iframe, leaving a blank white
// pane. Embedding is not attempted: the title and the open-in-new-tab link
// are shown front and center instead.
export function BrowserView({ url, title }: BrowserViewProps) {
  const wrapperStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    overflow: 'hidden',
    backgroundColor: 'var(--color-bg)',
    textAlign: 'center',
  }

  if (!url) {
    return (
      <div style={wrapperStyle}>
        <div style={{ color: 'var(--color-text-muted)' }}>URL を取得できませんでした</div>
      </div>
    )
  }

  return (
    <div style={wrapperStyle}>
      <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--color-text)', overflowWrap: 'anywhere' }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', overflowWrap: 'anywhere' }}>{url}</div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        style={{
          padding: '12px 24px',
          borderRadius: 8,
          backgroundColor: 'var(--color-link-bg)',
          color: 'var(--color-link)',
          textDecoration: 'none',
          fontSize: 16,
        }}
      >
        新しいタブで開く ↗
      </a>
    </div>
  )
}
