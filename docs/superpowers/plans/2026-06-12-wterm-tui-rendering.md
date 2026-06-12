# wterm TUI レンダリング忠実化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** リモートビューアの端末描画を `surface.read_text`（プレーンテキスト）から `terminal.replay`（`render_grid`）へ切替え、TUI（turbo/vim/top 等）をデスクトップ cmux と同等の忠実度で表示する。

**Architecture:** クライアントが `terminal.replay` で取得した `render_grid`（色・属性・カーソル・グリッド）を純粋関数 `renderGridToAnsi` で ANSI フレームに変換し、`@wterm` を grid のネイティブ寸法（`columns`×`rows`）に固定して書き込む。サーバー(`ws.ts`)は `terminal.replay` を素通しするため無変更。履歴(スクロールバック)モードは従来の `read_text` を据え置く。

**Tech Stack:** React 19 + TypeScript（`any`/`unknown`/`class` 禁止）、`@wterm/react` 0.3.0、Vitest（jsdom）、Biome（シングルクォート・セミコロンなし・行幅120）。

---

## File Structure

- **Create** `apps/client/src/lib/render-grid.ts` — `RenderGrid` 等の型と純粋関数 `renderGridToAnsi`。描画ロジックの単一責務。
- **Create** `apps/client/src/lib/__tests__/render-grid.test.ts` — `renderGridToAnsi` の単体テスト。
- **Modify** `apps/client/src/lib/surface-cache.ts` — `CachedScreen` に `grid?` を追加（オフライン表示用）。`text` を任意化し carry-forward。
- **Modify** `apps/client/src/lib/__tests__/surface-cache.test.ts` — grid 保存/読戻しテストを追加。
- **Modify** `apps/client/src/hooks/useCmux.ts` — `readGrid(surfaceRef)` を追加（`terminal.replay`）。
- **Modify** `apps/client/src/hooks/__tests__/useCmux.test.ts` — `readGrid` のパラメータ/戻り値テストを追加。
- **Modify** `apps/client/src/components/Terminal.tsx` — props を `grid`＋`content` にし、grid 時はネイティブ寸法固定で ANSI 描画。
- **Modify** `apps/client/src/App.tsx` — ライブポーリングを `readGrid` に切替、`termGrid` 状態・キャッシュ・Terminal への受け渡しを更新。
- **Modify** `apps/client/src/__tests__/App.test.tsx` — モック state に `readGrid` を追加。

---

## Task 1: render-grid.ts（純粋関数 + 型）

**Files:**
- Create: `apps/client/src/lib/render-grid.ts`
- Test: `apps/client/src/lib/__tests__/render-grid.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/client/src/lib/__tests__/render-grid.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { type RenderGrid, type RenderStyle, renderGridToAnsi } from '../render-grid'

// デフォルトスタイル（id 指定 + 上書きのみ）を組むヘルパ。
function style(id: number, over: Partial<RenderStyle> = {}): RenderStyle {
  return {
    id,
    foreground: '#FFFFFF',
    background: '#1E1E1E',
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    blink: false,
    inverse: false,
    strikethrough: false,
    overline: false,
    invisible: false,
    ...over,
  }
}

function grid(over: Partial<RenderGrid>): RenderGrid {
  return { columns: 10, rows: 2, styles: [], row_spans: [], ...over }
}

describe('renderGridToAnsi', () => {
  it('先頭で画面全消去 + ホームを発行する', () => {
    expect(renderGridToAnsi(grid({}))).toBe('\x1b[2J\x1b[H\x1b[0m')
  })

  it('各 span を 1 始まりで絶対位置指定し reset+前景+背景 SGR とテキストを書く', () => {
    const ansi = renderGridToAnsi(
      grid({
        styles: [style(0)],
        row_spans: [{ row: 0, column: 2, style_id: 0, cell_width: 2, text: 'hi' }],
        cursor: { row: 0, column: 0, visible: false },
      }),
    )
    // row0,col2 -> ESC[1;3H、#FFFFFF=255;255;255、#1E1E1E=30;30;30
    expect(ansi).toContain('\x1b[1;3H\x1b[0;38;2;255;255;255;48;2;30;30;30mhi')
  })

  it('bold/italic/underline/inverse を SGR コードに変換する', () => {
    const ansi = renderGridToAnsi(
      grid({
        styles: [style(0, { bold: true, italic: true, underline: true, inverse: true })],
        row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 1, text: 'X' }],
      }),
    )
    expect(ansi).toContain('\x1b[0;1;3;4;7;38;2;255;255;255;48;2;30;30;30mX')
  })

  it('未知の style_id は reset のみで描く（クラッシュしない）', () => {
    const ansi = renderGridToAnsi(
      grid({ styles: [], row_spans: [{ row: 1, column: 0, style_id: 99, cell_width: 1, text: 'x' }] }),
    )
    expect(ansi).toContain('\x1b[2;1H\x1b[0mx')
  })

  it('カーソルが可視なら ?25h、不可視なら ?25l を末尾に発行する', () => {
    const visible = renderGridToAnsi(grid({ cursor: { row: 3, column: 4, visible: true } }))
    expect(visible).toContain('\x1b[4;5H\x1b[?25h')
    const hidden = renderGridToAnsi(grid({ cursor: { row: 0, column: 0, visible: false } }))
    expect(hidden).toContain('\x1b[?25l')
  })

  it('全角(CJK)テキストをそのまま保持する', () => {
    const ansi = renderGridToAnsi(
      grid({ styles: [style(0)], row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 4, text: '日本' }] }),
    )
    expect(ansi).toContain('日本')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/render-grid.test.ts`
Expected: FAIL（`../render-grid` が存在しない / `renderGridToAnsi is not a function`）

- [ ] **Step 3: Write minimal implementation**

`apps/client/src/lib/render-grid.ts`:

```ts
// cmux ソケットの terminal.replay が返す描画グリッド（format "cmux.render-grid.v1"）を
// ANSI シーケンスへ変換する。surface.read_text のプレーンテキストと違い、色・属性・
// カーソル・グリッド位置を保持できるため、@wterm に書き込めば TUI を忠実に描画できる。

export interface RenderStyle {
  id: number
  foreground: string
  background: string
  bold: boolean
  faint: boolean
  italic: boolean
  underline: boolean
  blink: boolean
  inverse: boolean
  strikethrough: boolean
  overline: boolean
  invisible: boolean
}

export interface RowSpan {
  row: number
  column: number
  style_id: number
  cell_width: number
  text: string
}

export interface GridCursor {
  row: number
  column: number
  visible: boolean
  style?: string
  blinking?: boolean
}

export interface RenderGrid {
  columns: number
  rows: number
  styles: RenderStyle[]
  row_spans: RowSpan[]
  cursor?: GridCursor
  active_screen?: string
}

const ESC = '\x1b'

// "#RRGGBB" → [r, g, b]。不正値は黒にフォールバックする。
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) return [0, 0, 0]
  const n = Number.parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

// 1 span 分の SGR（必ず先頭で 0 リセットしてから属性を積む）。
function sgrFor(style: RenderStyle | undefined): string {
  const codes: number[] = [0]
  if (style) {
    if (style.bold) codes.push(1)
    if (style.faint) codes.push(2)
    if (style.italic) codes.push(3)
    if (style.underline) codes.push(4)
    if (style.blink) codes.push(5)
    if (style.inverse) codes.push(7)
    if (style.invisible) codes.push(8)
    if (style.strikethrough) codes.push(9)
    if (style.overline) codes.push(53)
    const [fr, fg, fb] = hexToRgb(style.foreground)
    codes.push(38, 2, fr, fg, fb)
    const [br, bg, bb] = hexToRgb(style.background)
    codes.push(48, 2, br, bg, bb)
  }
  return `${ESC}[${codes.join(';')}m`
}

export function renderGridToAnsi(grid: RenderGrid): string {
  const styleById = new Map<number, RenderStyle>()
  for (const s of grid.styles) styleById.set(s.id, s)

  const parts: string[] = [`${ESC}[2J${ESC}[H`]
  for (const span of grid.row_spans) {
    parts.push(`${ESC}[${span.row + 1};${span.column + 1}H`)
    parts.push(sgrFor(styleById.get(span.style_id)))
    parts.push(span.text)
  }
  parts.push(`${ESC}[0m`)

  const cur = grid.cursor
  if (cur) {
    parts.push(`${ESC}[${cur.row + 1};${cur.column + 1}H`)
    parts.push(cur.visible ? `${ESC}[?25h` : `${ESC}[?25l`)
  }
  return parts.join('')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/render-grid.test.ts`
Expected: PASS（6 件）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/render-grid.ts apps/client/src/lib/__tests__/render-grid.test.ts
git commit -m "wterm-tui-rendering: add renderGridToAnsi pure converter"
```

---

## Task 2: surface-cache に grid 対応を追加

**Files:**
- Modify: `apps/client/src/lib/surface-cache.ts`
- Test: `apps/client/src/lib/__tests__/surface-cache.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/client/src/lib/__tests__/surface-cache.test.ts` の `describe('surface-cache', ...)` 内に追加:

```ts
  it('grid を保存・読み戻しできる', () => {
    const grid = { columns: 2, rows: 1, styles: [], row_spans: [] }
    saveSurfaceScreen('surface:1', { grid, updatedAt: 5 })
    expect(loadSurfaceScreen('surface:1')?.grid).toEqual(grid)
  })

  it('text 未指定の保存は既存の text/scrollback を引き継ぐ（grid だけ更新）', () => {
    saveSurfaceScreen('surface:1', { text: 'old', scrollback: 'hist', updatedAt: 1 })
    const grid = { columns: 1, rows: 1, styles: [], row_spans: [] }
    saveSurfaceScreen('surface:1', { grid, updatedAt: 2 })
    const loaded = loadSurfaceScreen('surface:1')
    expect(loaded?.text).toBe('old')
    expect(loaded?.scrollback).toBe('hist')
    expect(loaded?.grid).toEqual(grid)
    expect(loaded?.updatedAt).toBe(2)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/surface-cache.test.ts`
Expected: FAIL（`grid` が保存されず undefined / `text` 引き継ぎがされない）

- [ ] **Step 3: Write minimal implementation**

`apps/client/src/lib/surface-cache.ts` を編集。冒頭の import と型、save/load を差し替える。

import を追加（ファイル先頭）:

```ts
import type { RenderGrid } from './render-grid'
```

`CachedScreen` を差し替え:

```ts
export interface CachedScreen {
  text?: string
  scrollback?: string
  // ライブ描画のオフライン表示用に最後の render_grid を保持する。
  grid?: RenderGrid
  updatedAt: number
}
```

`saveSurfaceScreen` を差し替え:

```ts
export function saveSurfaceScreen(surfaceRef: string, screen: CachedScreen): void {
  if (typeof window === 'undefined') return

  // 未指定のフィールドは既存値を引き継ぐ（ライブ poll は grid のみ、履歴 fetch は
  // scrollback のみ、を渡すため）。これで text/scrollback/grid が互いを潰さない。
  const prev = loadSurfaceScreen(surfaceRef)
  const clamped: CachedScreen = { updatedAt: screen.updatedAt }

  const text = screen.text ?? prev?.text
  if (text !== undefined) clamped.text = clampTail(text)

  const scrollback = screen.scrollback ?? prev?.scrollback
  if (scrollback !== undefined) clamped.scrollback = clampTail(scrollback)

  const grid = screen.grid ?? prev?.grid
  if (grid !== undefined) clamped.grid = grid

  try {
    localStorage.setItem(keyFor(surfaceRef), JSON.stringify(clamped))
  } catch {
    // クォータ超過等は無視する（キャッシュは best-effort）。
  }
}
```

`loadSurfaceScreen` の検証行を `text` 必須から `updatedAt` 必須へ変更:

```ts
    const parsed = JSON.parse(raw) as CachedScreen
    if (typeof parsed.updatedAt !== 'number') return null
    return parsed
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/surface-cache.test.ts`
Expected: PASS（既存テスト + 追加 2 件）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/surface-cache.ts apps/client/src/lib/__tests__/surface-cache.test.ts
git commit -m "wterm-tui-rendering: cache render_grid for offline display"
```

---

## Task 3: useCmux に readGrid を追加

**Files:**
- Modify: `apps/client/src/hooks/useCmux.ts`
- Test: `apps/client/src/hooks/__tests__/useCmux.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/client/src/hooks/__tests__/useCmux.test.ts` の `describe('useCmux surface RPC params', ...)` 内に追加:

```ts
  it('readGrid は terminal.replay を surface_id で送り render_grid を返す', async () => {
    const grid = { columns: 80, rows: 24, styles: [], row_spans: [] }
    hoisted.responses['terminal.replay'] = { render_grid: grid, surface_id: 'surface:7' }
    const { result } = renderHook(() => useCmux())

    let got: unknown
    await act(async () => {
      got = await result.current.readGrid('surface:7')
    })

    expect(got).toEqual(grid)
    const req = findReq('terminal.replay')
    expect(req?.params).toEqual({ surface_id: 'surface:7' })
    expect(req?.params).not.toHaveProperty('surface_ref')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: FAIL（`result.current.readGrid is not a function`）

- [ ] **Step 3: Write minimal implementation**

`apps/client/src/hooks/useCmux.ts` を編集。

import に `RenderGrid` 型を追加（先頭の import 群）:

```ts
import type { RenderGrid } from '../lib/render-grid'
```

`readText` の定義（`const readText = useCallback(...)` ブロック）の直後に追加:

```ts
  const readGrid = useCallback(
    async (surfaceRef?: string): Promise<RenderGrid> => {
      // terminal.replay は render_grid（色/属性/カーソル付きグリッド）を返す。read_text と
      // 同じく surface_id を読む（surface_ref はフォーカス中へフォールバックする）。
      const params: Record<string, unknown> = {}
      if (surfaceRef) params.surface_id = surfaceRef
      const result = (await rpc('terminal.replay', params)) as { render_grid: RenderGrid }
      return result.render_grid
    },
    [rpc],
  )
```

return オブジェクトの `readText,` の直後に `readGrid,` を追加。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/hooks/useCmux.ts apps/client/src/hooks/__tests__/useCmux.test.ts
git commit -m "wterm-tui-rendering: add readGrid (terminal.replay) to useCmux"
```

---

## Task 4: Terminal を grid 描画対応にする

**Files:**
- Modify: `apps/client/src/components/Terminal.tsx`

備考: `Terminal` は `App.test.tsx` で `() => null` にモックされており、`@wterm` は WASM ロードのため jsdom 単体テストに不向き。描画ロジックは Task 1 の純粋関数で担保済みのため、本タスクは型・配線のみで、検証は Task 6 の手動確認に委ねる。

- [ ] **Step 1: Terminal.tsx を差し替える**

`apps/client/src/components/Terminal.tsx` 全体を以下に置換:

```tsx
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
```

- [ ] **Step 2: 型チェック**

Run: `cd apps/client && pnpm exec tsc --noEmit`
Expected: エラーなし（`App.tsx` が未修正なら Terminal の props 不一致エラーが出る → Task 5 で解消。ここでは Terminal 単体の型エラーが無いことを確認）

- [ ] **Step 3: Commit**

```bash
git add apps/client/src/components/Terminal.tsx
git commit -m "wterm-tui-rendering: render render_grid in Terminal at native size"
```

---

## Task 5: App をライブ grid ポーリングに切替

**Files:**
- Modify: `apps/client/src/App.tsx`
- Test: `apps/client/src/__tests__/App.test.tsx`

- [ ] **Step 1: App.test のモックに readGrid を追加（テストを壊さない）**

`apps/client/src/__tests__/App.test.tsx` の `cmux.state` 内、`readText:` 行の直後に追加:

```ts
    readGrid: vi.fn(() => Promise.resolve({ columns: 80, rows: 24, styles: [], row_spans: [] })),
```

- [ ] **Step 2: Run App.test to confirm still green baseline**

Run: `cd apps/client && pnpm vitest run src/__tests__/App.test.tsx`
Expected: PASS（モック追加のみ。currentSurface=null なので poll は走らない）

- [ ] **Step 3: App.tsx を編集**

import に型を追加（先頭の import 群）:

```ts
import type { RenderGrid } from './lib/render-grid'
```

`useCmux()` 分割代入に `readGrid` を追加（`readText,` の隣）:

```ts
    readText,
    readGrid,
```

`termContent` state の隣に grid state を追加（`const [termContent, setTermContent] = useState('')` の直後）:

```ts
  const [termGrid, setTermGrid] = useState<RenderGrid | null>(null)
```

surface 切替ハイドレート effect（`const cached = loadSurfaceScreen(currentSurface)` を含む effect）を差し替え:

```ts
  useEffect(() => {
    setHistoryMode(false)
    if (!currentSurface) {
      setTermGrid(null)
      setTermContent('')
      setLastUpdated(null)
      return
    }
    const cached = loadSurfaceScreen(currentSurface)
    setTermGrid(cached?.grid ?? null)
    setTermContent(cached?.text ?? '')
    setLastUpdated(cached?.updatedAt ?? null)
  }, [currentSurface])
```

ライブポーリング effect 内の `poll` 関数を grid 取得へ差し替え（`const text = await readText(currentSurface)` を含む try ブロック）:

```ts
    const poll = async () => {
      try {
        const grid = await readGrid(currentSurface)
        setTermGrid(grid)
        const now = Date.now()
        setLastUpdated(now)
        // オフライン保持用に最後のグリッドを永続化（text/scrollback は引き継がれる）。
        saveSurfaceScreen(currentSurface, { grid, updatedAt: now })
      } catch (err) {
        console.error('[app] Poll error:', err)
      }
    }
```

同 effect の依存配列を `readText` → `readGrid` に変更:

```ts
  }, [status, currentSurface, isBrowserSurface, historyMode, readGrid])
```

Terminal の描画箇所（`<Terminal content={termContent} ... />`）を差し替え:

```tsx
          <Terminal grid={historyMode ? null : termGrid} content={termContent} fontSize={fontSize} gestureRef={gestureRef} />
```

備考: 履歴モード effect（`readText(currentSurface, { scrollback: true, ... })`）は変更しない。履歴トグル中は `grid={null}` を渡すため Terminal は `termContent`（read_text のスクロールバック）を描く。

- [ ] **Step 4: Run App.test to verify it passes**

Run: `cd apps/client && pnpm vitest run src/__tests__/App.test.tsx`
Expected: PASS

- [ ] **Step 5: 型チェック**

Run: `cd apps/client && pnpm exec tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/App.tsx apps/client/src/__tests__/App.test.tsx
git commit -m "wterm-tui-rendering: poll terminal.replay grid for live terminal view"
```

---

## Task 6: 全体検証（CI + 実機）

**Files:** なし（検証のみ）

- [ ] **Step 1: クライアント全テスト**

Run: `cd apps/client && pnpm vitest run`
Expected: 全 PASS

- [ ] **Step 2: check（tsc + biome）**

Run: `pnpm check`
Expected: エラーなし（biome 指摘があれば `pnpm check:fix` で整形し、差分を確認して再コミット）

- [ ] **Step 3: ビルド**

Run: `pnpm build`
Expected: 成功

- [ ] **Step 4: 実機確認（dev サーバーで TUI 表示）**

```bash
pnpm dev
```

確認手順:
1. ブラウザで `http://localhost:5173/?token=<token>` を開く（token は `apps/server/.run/token`）。
2. cmux で `turbo`（または `top` / `vim`）を起動した端末タブを選択。
3. **TUI が崩れず、色・枠線・カーソルがデスクトップ cmux と同等に表示される**ことを確認。
4. 複数サーフェスがあるワークスペースで、**フォーカスしていない別タブ**を選択し、その端末内容が正しく表示されること（`terminal.replay` が `surface_id` を尊重し、選択中ワークスペース内の非フォーカスサーフェスを読める）を確認。
5. ネイティブ幅（例 187 桁）がスマホ幅を超える場合にスクロールできること、ピンチでフォントサイズが変わることを確認。

Expected: TUI がデスクトップ cmux と同等に描画される。崩れ・staircase・色欠落が無い。

備考: 万一 4 で非フォーカスサーフェスが読めない場合（replay が read_text と異なり workspace/focus 制約を持つ場合）は、対象サーフェスの取得前に `workspace.select` 追従済みであることを再確認し、必要なら結果を `result.md` に記録する（設計のリスク項参照）。

- [ ] **Step 5: 最終コミット（未コミット差分があれば）**

```bash
git add -A
git commit -m "wterm-tui-rendering: verification fixups"
```

（差分が無ければスキップ）

---

## Self-Review（記録）

- **Spec coverage:** 根本原因→Task 1/5（grid 描画への切替）、リッチ API 採用→Task 1/3、ネイティブ幅固定→Task 4、履歴据え置き→Task 4/5（grid=null フォールバック）、オフラインキャッシュ→Task 2/5、テスト戦略→Task 1/2/3 + Task 6、エッジケース(別ワークスペース/非フォーカス)→Task 6 Step 4。全項目に対応タスクあり。
- **Placeholder scan:** TBD/TODO・抽象指示なし。各コードステップに実コードを記載。
- **Type consistency:** `RenderGrid`/`RenderStyle`/`RowSpan`/`GridCursor` は Task 1 で定義し、Task 2(surface-cache)・Task 3(useCmux)・Task 4(Terminal)・Task 5(App) で同名 import。`readGrid(surfaceRef?) => Promise<RenderGrid>`・`renderGridToAnsi(grid) => string` はタスク間で一貫。
