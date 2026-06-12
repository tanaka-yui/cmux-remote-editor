import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'

interface BrowserViewProps {
  url: string
  title: string
  gestureRef: (el: HTMLDivElement | null) => void
}

// Most real sites (Google, AWS, GitHub) return X-Frame-Options / CSP
// frame-ancestors and refuse to render in an iframe. That block is cross-origin
// and cannot be detected reliably from JS (a blocked frame may still fire load),
// so the always-visible "open in new tab" link is the dependable escape hatch.
// The load timeout only drives a soft hint, never the primary affordance.
const LOAD_HINT_DELAY = 3000

export function BrowserView({ url, title, gestureRef }: BrowserViewProps) {
  const [loaded, setLoaded] = useState(false)
  const [hint, setHint] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    setLoaded(false)
    setHint(false)
    timerRef.current = setTimeout(() => setHint(true), LOAD_HINT_DELAY)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const wrapperStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: '#1a1a2e',
  }

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    fontSize: 12,
    backgroundColor: '#16213e',
    borderBottom: '1px solid #0f3460',
    flexShrink: 0,
  }

  const urlStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#8a8aa0',
  }

  const linkStyle: CSSProperties = {
    flexShrink: 0,
    color: '#4fc3f7',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  }

  return (
    <div ref={gestureRef} style={wrapperStyle}>
      <div style={headerStyle}>
        <span style={{ color: '#e0e0e0', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={urlStyle}>{url}</span>
        <a href={url} target="_blank" rel="noreferrer" style={linkStyle}>
          新しいタブで開く ↗
        </a>
      </div>
      {url ? (
        <iframe
          title={title}
          src={url}
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoaded(true)
            setHint(false)
          }}
          style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', backgroundColor: '#fff' }}
        />
      ) : (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: '#8a8aa0' }}>
          URL を取得できませんでした
        </div>
      )}
      {hint && !loaded && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: '#8a8aa0', backgroundColor: '#16213e' }}>
          このサイトは埋め込み表示に対応していない可能性があります。「新しいタブで開く」をお試しください。
        </div>
      )}
    </div>
  )
}
