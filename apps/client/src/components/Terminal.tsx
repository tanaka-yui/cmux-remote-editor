import { useTerminal, Terminal as WTerminal } from '@wterm/react'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import '@wterm/react/css'

interface TerminalProps {
  content: string
  fontSize: number
  gestureRef: (el: HTMLDivElement | null) => void
}

// cmux read-screen emits bare "\n" line feeds; wterm (unlike xterm's convertEol)
// does not return the cursor to column 0, so join with "\r\n" to avoid a
// staircase effect. Trailing whitespace is trimmed; leading indentation is kept.
function cleanScreen(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\r\n')
}

const CLEAR = '\x1b[2J\x1b[3J\x1b[H'

export function Terminal({ content, fontSize, gestureRef }: TerminalProps) {
  const { ref, write } = useTerminal()
  const contentRef = useRef('')
  const readyRef = useRef(false)

  const repaint = useCallback(
    (text: string) => {
      write(CLEAR + cleanScreen(text))
    },
    [write],
  )

  useEffect(() => {
    contentRef.current = content
    if (readyRef.current) repaint(content)
  }, [content, repaint])

  const onReady = useCallback(() => {
    readyRef.current = true
    repaint(contentRef.current)
  }, [repaint])

  const wrapperStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    width: '100%',
    overflow: 'hidden',
    touchAction: 'none',
  }

  // wterm reads font/colors from CSS custom properties on the terminal element.
  const termStyle = {
    width: '100%',
    height: '100%',
    padding: 8,
    borderRadius: 0,
    boxShadow: 'none',
    '--term-bg': '#1a1a2e',
    '--term-fg': '#e0e0e0',
    '--term-cursor': '#e0e0e0',
    '--term-font-size': `${fontSize}px`,
  } as CSSProperties

  return (
    <div ref={gestureRef} style={wrapperStyle}>
      <WTerminal ref={ref} autoResize cursorBlink={false} onData={() => {}} onReady={onReady} style={termStyle} />
    </div>
  )
}
