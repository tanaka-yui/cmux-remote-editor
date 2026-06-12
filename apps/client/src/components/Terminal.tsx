import { useTerminal, Terminal as WTerminal } from '@wterm/react'
import type { CSSProperties, TouchEvent as ReactTouchEvent } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import '@wterm/react/css'
import { type RenderGrid, renderGridToAnsi } from '../lib/render-grid'
import { cellSize } from '../lib/terminal-coords'
import { touchToMouseSequence } from '../lib/touch-to-mouse'

interface TerminalProps {
  // ライブ/オフライン表示用の描画グリッド。null のとき content(プレーンテキスト)を描く。
  grid: RenderGrid | null
  // 履歴(スクロールバック)モード等のプレーンテキスト。grid が null のときのみ使う。
  content: string
  fontSize: number
  gestureRef: (el: HTMLDivElement | null) => void
  // マウス送信（render_grid.modes から App が導出）。
  mouseEnabled: boolean
  useSgr: boolean
  onSendMouse: (text: string) => void
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

export function Terminal({ grid, content, fontSize, gestureRef, mouseEnabled, useSgr, onSendMouse }: TerminalProps) {
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

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const touchStartRef = useRef<{ clientX: number; clientY: number } | null>(null)

  // マウス送信が有効かつ grid（cols/rows 既知）があるときだけ touch を横取りする。
  const mouseActive = mouseEnabled && useSgr && grid !== null

  const onTouchStart = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      if (!mouseActive) return
      const t = e.touches[0]
      if (t) touchStartRef.current = { clientX: t.clientX, clientY: t.clientY }
    },
    [mouseActive],
  )

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      const start = touchStartRef.current
      touchStartRef.current = null
      if (!mouseActive || !start || !grid) return
      const el = wrapperRef.current
      const t = e.changedTouches[0]
      if (!el || !t) return

      const rect = el.getBoundingClientRect()
      const { cellWidth, cellHeight } = cellSize({
        contentWidth: el.scrollWidth,
        contentHeight: el.scrollHeight,
        cols: grid.columns,
        rows: grid.rows,
        padding: 8,
      })
      const seq = touchToMouseSequence({
        useSgr,
        start,
        end: { clientX: t.clientX, clientY: t.clientY },
        rectLeft: rect.left,
        rectTop: rect.top,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
        cellWidth,
        cellHeight,
        padding: 8,
        cols: grid.columns,
        rows: grid.rows,
      })
      if (seq) onSendMouse(seq)
    },
    [mouseActive, grid, useSgr, onSendMouse],
  )

  const onTouchCancel = useCallback(() => {
    touchStartRef.current = null
  }, [])

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
    <div
      ref={(el) => {
        wrapperRef.current = el
        gestureRef(el)
      }}
      style={wrapperStyle}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
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
