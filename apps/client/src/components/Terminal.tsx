import { Terminal as WTerminal, useTerminal } from '@wterm/react'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import '@wterm/react/css'
import { type RenderGrid, renderGridToAnsi } from '../lib/render-grid'

interface TerminalProps {
  // ライブ/オフライン表示用の描画グリッド。null のとき content(プレーンテキスト)を描く。
  grid: RenderGrid | null
  // 履歴(スクロールバック)モード等のプレーンテキスト。grid が null のときのみ使う。
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

export function Terminal({ grid, content, fontSize, gestureRef }: TerminalProps) {
  const { ref, write } = useTerminal()
  const gridRef = useRef<RenderGrid | null>(null)
  const contentRef = useRef('')
  const readyRef = useRef(false)

  const repaint = useCallback(
    (g: RenderGrid | null, text: string) => {
      // grid があればグリッドを忠実描画、無ければ従来のプレーンテキスト描画にフォールバック。
      if (g) write(renderGridToAnsi(g))
      else write(CLEAR + cleanScreen(text))
    },
    [write],
  )

  useEffect(() => {
    gridRef.current = grid
    contentRef.current = content
    if (readyRef.current) repaint(grid, content)
  }, [grid, content, repaint])

  const onReady = useCallback(() => {
    readyRef.current = true
    repaint(gridRef.current, contentRef.current)
  }, [repaint])

  // grid モードはネイティブ寸法に固定（autoResize 廃止）。@wterm は cols/rows prop 変化時に
  // 自動で resize() するため、グリッドの幅・行数どおりに表示しデスクトップ cmux と一致させる。
  const useGrid = grid !== null

  const wrapperStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    width: '100%',
    // grid モードはネイティブ幅(例 187 桁)がスマホ幅を超えるためスクロール可能にする。
    overflow: useGrid ? 'auto' : 'hidden',
    touchAction: 'none',
  }

  // wterm reads font/colors from CSS custom properties on the terminal element.
  const termStyle = {
    padding: 8,
    borderRadius: 0,
    boxShadow: 'none',
    '--term-bg': '#1e1e1e',
    '--term-fg': '#e0e0e0',
    '--term-cursor': '#e0e0e0',
    '--term-font-size': `${fontSize}px`,
  } as CSSProperties

  return (
    <div ref={gestureRef} style={wrapperStyle}>
      <WTerminal
        ref={ref}
        autoResize={!useGrid}
        cols={useGrid ? grid.columns : undefined}
        rows={useGrid ? grid.rows : undefined}
        cursorBlink={false}
        onData={() => {}}
        onReady={onReady}
        style={termStyle}
      />
    </div>
  )
}
