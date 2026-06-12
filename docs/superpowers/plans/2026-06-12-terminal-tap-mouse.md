# ターミナルのタップ → cmux マウス送信（フェーズ1）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA のターミナルをタップ＝左クリック、上下スワイプ＝マウスホイールとして cmux に転送し、nvim 等の TUI を指で操作できるようにする（フェーズ1）。

**Architecture:** 判定・座標変換・エンコードを純粋関数（`lib/`）に切り出して単体テストし、`Terminal.tsx` は DOM 実測値を集めて純粋関数を呼ぶだけの薄い層にする。マウス入力の可否は `render_grid.modes`（DECSET モード）で判定し、有効時のみタップを送る（通常シェルでの誤入力ゼロ）。送信は既存の `surface.send_text` を再利用し、新 RPC は追加しない。

**Tech Stack:** React 19 + Vite + TypeScript, `@wterm/react`, vitest, cmux UDS JSON-RPC（NDJSON）。

設計 spec: `docs/superpowers/specs/2026-06-12-terminal-tap-mouse-design.md`

---

## ファイル構成

新規（すべて純粋関数 + テスト）:
- `apps/client/src/lib/mouse-mode.ts` — `render_grid.modes` → `{ mouseEnabled, useSgr }`
- `apps/client/src/lib/sgr-mouse.ts` — マウスイベント → SGR エスケープ列
- `apps/client/src/lib/terminal-coords.ts` — ピクセル座標 → セル `{ col, row }`
- `apps/client/src/lib/gesture-classify.ts` — 移動量 → `tap` / `wheel` / `none`
- `apps/client/src/lib/touch-to-mouse.ts` — 上記4つを統合し touch 開始/終了 → 送信文字列

変更:
- `apps/client/src/lib/render-grid.ts` — `RenderGrid` に `modes` を追加
- `apps/client/src/components/Terminal.tsx` — touch ハンドラと props 追加
- `apps/client/src/App.tsx` — `deriveMouseMode` 配線、Terminal への props、swipe 無効化

---

## 共有定数（フェーズ1の仮値。Task 9 で実機調整）

`gesture-classify.ts` に定義:
- `TAP_MAX_DISTANCE = 10`（px。これ以下の移動はタップ）
- `WHEEL_MIN_DISTANCE = 16`（px。縦移動がこれ以上でホイール開始）
- `WHEEL_STEP_PX = 24`（px。1 ノッチあたりの移動量）
- `WHEEL_MAX_COUNT = 10`（一度のスワイプで送る最大ノッチ数）

`Terminal.tsx` の既存 padding は `8`px。

---

## Task 1: `RenderGrid` に `modes` を追加

**Files:**
- Modify: `apps/client/src/lib/render-grid.ts`
- Test: `apps/client/src/lib/__tests__/render-grid.test.ts`（既存。型のみの変更なので新規テスト不要）

- [ ] **Step 1: `RenderGrid` に `modes` フィールドを追加**

`apps/client/src/lib/render-grid.ts` の `GridCursor` 定義の下、`RenderGrid` の直前に型を追加:

```ts
export interface TerminalMode {
  code: number
  ansi: boolean
  on: boolean
}
```

`RenderGrid` インターフェースに 1 行追加（`active_screen?` の隣）:

```ts
export interface RenderGrid {
  columns: number
  rows: number
  styles: RenderStyle[]
  row_spans: RowSpan[]
  cursor?: GridCursor
  active_screen?: string
  modes?: TerminalMode[]
}
```

- [ ] **Step 2: 型チェックが通ることを確認**

Run: `cd apps/client && pnpm tsc --noEmit`
Expected: エラーなし（既存利用箇所は `modes` を読まないため影響なし）

- [ ] **Step 3: Commit**

```bash
git add apps/client/src/lib/render-grid.ts
git commit -m "feat(client): add modes field to RenderGrid type"
```

---

## Task 2: `mouse-mode.ts`（マウスモード判定）

**Files:**
- Create: `apps/client/src/lib/mouse-mode.ts`
- Test: `apps/client/src/lib/__tests__/mouse-mode.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/mouse-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { RenderGrid } from '../render-grid'
import { deriveMouseMode } from '../mouse-mode'

function gridWith(modes: { code: number; on: boolean }[]): RenderGrid {
  return {
    columns: 80,
    rows: 24,
    styles: [],
    row_spans: [],
    modes: modes.map((m) => ({ code: m.code, ansi: false, on: m.on })),
  }
}

describe('deriveMouseMode', () => {
  it('grid が null なら無効', () => {
    expect(deriveMouseMode(null)).toEqual({ mouseEnabled: false, useSgr: false })
  })

  it('modes 未定義なら無効', () => {
    const grid = gridWith([])
    grid.modes = undefined
    expect(deriveMouseMode(grid)).toEqual({ mouseEnabled: false, useSgr: false })
  })

  it('1002 と 1006 が on（mouse=a の nvim）なら有効 + SGR', () => {
    const grid = gridWith([
      { code: 1000, on: false },
      { code: 1002, on: true },
      { code: 1006, on: true },
    ])
    expect(deriveMouseMode(grid)).toEqual({ mouseEnabled: true, useSgr: true })
  })

  it('1000 が on なら有効（1006 off は useSgr false）', () => {
    const grid = gridWith([{ code: 1000, on: true }])
    expect(deriveMouseMode(grid)).toEqual({ mouseEnabled: true, useSgr: false })
  })

  it('全マウスモード off（通常シェル）なら無効', () => {
    const grid = gridWith([
      { code: 1000, on: false },
      { code: 1002, on: false },
      { code: 1003, on: false },
      { code: 1006, on: false },
    ])
    expect(deriveMouseMode(grid)).toEqual({ mouseEnabled: false, useSgr: false })
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/mouse-mode.test.ts`
Expected: FAIL（`Cannot find module '../mouse-mode'`）

- [ ] **Step 3: 実装を書く**

`apps/client/src/lib/mouse-mode.ts`:

```ts
import type { RenderGrid } from './render-grid'

export interface MouseMode {
  // 端末がマウス入力を受け付ける状態か（DECSET 1000/1002/1003 のいずれか on）。
  mouseEnabled: boolean
  // SGR 拡張座標形式（DECSET 1006）が有効か。
  useSgr: boolean
}

const TRACKING_CODES = [1000, 1002, 1003]
const SGR_CODE = 1006

export function deriveMouseMode(grid: RenderGrid | null): MouseMode {
  const modes = grid?.modes
  if (!modes) return { mouseEnabled: false, useSgr: false }
  const isOn = (code: number) => modes.some((m) => m.code === code && m.on)
  return {
    mouseEnabled: TRACKING_CODES.some(isOn),
    useSgr: isOn(SGR_CODE),
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/mouse-mode.test.ts`
Expected: PASS（5 件）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/mouse-mode.ts apps/client/src/lib/__tests__/mouse-mode.test.ts
git commit -m "feat(client): derive mouse mode from render_grid modes"
```

---

## Task 3: `sgr-mouse.ts`（SGR エンコード）

**Files:**
- Create: `apps/client/src/lib/sgr-mouse.ts`
- Test: `apps/client/src/lib/__tests__/sgr-mouse.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/sgr-mouse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { encodeMouse } from '../sgr-mouse'

describe('encodeMouse', () => {
  it('左クリック press は \\x1b[<0;col;rowM', () => {
    expect(encodeMouse({ button: 'left', action: 'press', col: 5, row: 3 })).toBe('\x1b[<0;5;3M')
  })

  it('左クリック release は小文字 m', () => {
    expect(encodeMouse({ button: 'left', action: 'release', col: 5, row: 3 })).toBe('\x1b[<0;5;3m')
  })

  it('ホイール上は code 64（press 固定）', () => {
    expect(encodeMouse({ button: 'wheelUp', action: 'press', col: 1, row: 1 })).toBe('\x1b[<64;1;1M')
  })

  it('ホイール下は code 65', () => {
    expect(encodeMouse({ button: 'wheelDown', action: 'press', col: 10, row: 20 })).toBe('\x1b[<65;10;20M')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/sgr-mouse.test.ts`
Expected: FAIL（`Cannot find module '../sgr-mouse'`）

- [ ] **Step 3: 実装を書く**

`apps/client/src/lib/sgr-mouse.ts`:

```ts
export type MouseButton = 'left' | 'wheelUp' | 'wheelDown'
export type MouseAction = 'press' | 'release'

export interface MouseEvent {
  button: MouseButton
  action: MouseAction
  // 1-based のセル座標。
  col: number
  row: number
}

const BUTTON_CODE: Record<MouseButton, number> = {
  left: 0,
  wheelUp: 64,
  wheelDown: 65,
}

// SGR 拡張マウス（DECSET 1006）の 1 イベント。press は 'M'、release は 'm'。
export function encodeMouse(ev: MouseEvent): string {
  const code = BUTTON_CODE[ev.button]
  const final = ev.action === 'press' ? 'M' : 'm'
  return `\x1b[<${code};${ev.col};${ev.row}${final}`
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/sgr-mouse.test.ts`
Expected: PASS（4 件）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/sgr-mouse.ts apps/client/src/lib/__tests__/sgr-mouse.test.ts
git commit -m "feat(client): encode SGR mouse sequences"
```

---

## Task 4: `terminal-coords.ts`（座標変換）

**Files:**
- Create: `apps/client/src/lib/terminal-coords.ts`
- Test: `apps/client/src/lib/__tests__/terminal-coords.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/terminal-coords.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { cellSize, pixelToCell } from '../terminal-coords'

describe('cellSize', () => {
  it('padding を除いた描画領域を cols/rows で割る', () => {
    // contentWidth 808 - padding*2(16) = 792 / 80 = 9.9 / 行: 408-16=392 / 24 ≒ 16.33
    expect(cellSize({ contentWidth: 808, contentHeight: 408, cols: 80, rows: 24, padding: 8 })).toEqual({
      cellWidth: 9.9,
      cellHeight: (408 - 16) / 24,
    })
  })
})

describe('pixelToCell', () => {
  const base = {
    rectLeft: 0,
    rectTop: 0,
    scrollLeft: 0,
    scrollTop: 0,
    cellWidth: 10,
    cellHeight: 20,
    padding: 8,
    cols: 80,
    rows: 24,
  }

  it('左上 padding 内は (1,1)', () => {
    expect(pixelToCell({ ...base, clientX: 8, clientY: 8 })).toEqual({ col: 1, row: 1 })
  })

  it('1 セル分進むと (2,1)', () => {
    expect(pixelToCell({ ...base, clientX: 8 + 10, clientY: 8 })).toEqual({ col: 2, row: 1 })
  })

  it('rect オフセットと scroll を差し引く', () => {
    expect(pixelToCell({ ...base, rectLeft: 100, scrollLeft: 50, clientX: 100 - 50 + 8 + 20, clientY: 8 })).toEqual({
      col: 3,
      row: 1,
    })
  })

  it('範囲外は端に clamp する', () => {
    expect(pixelToCell({ ...base, clientX: 100000, clientY: 100000 })).toEqual({ col: 80, row: 24 })
    expect(pixelToCell({ ...base, clientX: -100, clientY: -100 })).toEqual({ col: 1, row: 1 })
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/terminal-coords.test.ts`
Expected: FAIL（`Cannot find module '../terminal-coords'`）

- [ ] **Step 3: 実装を書く**

`apps/client/src/lib/terminal-coords.ts`:

```ts
export interface CellPos {
  col: number
  row: number
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

// wterm 描画要素の実寸（padding 込みの content サイズ）から 1 セルの px を求める。
export function cellSize(args: {
  contentWidth: number
  contentHeight: number
  cols: number
  rows: number
  padding: number
}): { cellWidth: number; cellHeight: number } {
  return {
    cellWidth: (args.contentWidth - args.padding * 2) / args.cols,
    cellHeight: (args.contentHeight - args.padding * 2) / args.rows,
  }
}

// クライアント座標 → 1-based セル位置（範囲 clamp）。
export function pixelToCell(args: {
  clientX: number
  clientY: number
  rectLeft: number
  rectTop: number
  scrollLeft: number
  scrollTop: number
  cellWidth: number
  cellHeight: number
  padding: number
  cols: number
  rows: number
}): CellPos {
  const x = args.clientX - args.rectLeft + args.scrollLeft - args.padding
  const y = args.clientY - args.rectTop + args.scrollTop - args.padding
  const col = clamp(Math.floor(x / args.cellWidth) + 1, 1, args.cols)
  const row = clamp(Math.floor(y / args.cellHeight) + 1, 1, args.rows)
  return { col, row }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/terminal-coords.test.ts`
Expected: PASS（6 件）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/terminal-coords.ts apps/client/src/lib/__tests__/terminal-coords.test.ts
git commit -m "feat(client): convert pixel coords to terminal cells"
```

---

## Task 5: `gesture-classify.ts`（ジェスチャー判定）

**Files:**
- Create: `apps/client/src/lib/gesture-classify.ts`
- Test: `apps/client/src/lib/__tests__/gesture-classify.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/gesture-classify.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { classifyGesture } from '../gesture-classify'

describe('classifyGesture', () => {
  it('ほぼ動かなければ tap', () => {
    expect(classifyGesture({ dx: 2, dy: -3 })).toEqual({ type: 'tap' })
  })

  it('指を上へ大きく動かすと wheel down（コンテンツが次行へ）', () => {
    // dy = -48 → count = floor(48/24) = 2
    expect(classifyGesture({ dx: 1, dy: -48 })).toEqual({ type: 'wheel', direction: 'down', count: 2 })
  })

  it('指を下へ動かすと wheel up', () => {
    expect(classifyGesture({ dx: 0, dy: 30 })).toEqual({ type: 'wheel', direction: 'up', count: 1 })
  })

  it('横移動が主なら none（タブ切替は App 側で処理）', () => {
    expect(classifyGesture({ dx: 60, dy: 5 })).toEqual({ type: 'none' })
  })

  it('ホイール数は上限で頭打ち', () => {
    expect(classifyGesture({ dx: 0, dy: -10000 })).toEqual({ type: 'wheel', direction: 'down', count: 10 })
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/gesture-classify.test.ts`
Expected: FAIL（`Cannot find module '../gesture-classify'`）

- [ ] **Step 3: 実装を書く**

`apps/client/src/lib/gesture-classify.ts`:

```ts
// フェーズ1の閾値（px）。実機で調整する（plan Task 9）。
export const TAP_MAX_DISTANCE = 10
export const WHEEL_MIN_DISTANCE = 16
export const WHEEL_STEP_PX = 24
export const WHEEL_MAX_COUNT = 10

export type Gesture =
  | { type: 'tap' }
  | { type: 'wheel'; direction: 'up' | 'down'; count: number }
  | { type: 'none' }

export function classifyGesture(args: { dx: number; dy: number }): Gesture {
  const distance = Math.hypot(args.dx, args.dy)
  if (distance <= TAP_MAX_DISTANCE) return { type: 'tap' }

  const isVertical = Math.abs(args.dy) > Math.abs(args.dx) && Math.abs(args.dy) >= WHEEL_MIN_DISTANCE
  if (isVertical) {
    // 指を上へ（dy<0）= コンテンツを上に押し上げ = 次行へ = wheel down。
    const direction = args.dy < 0 ? 'down' : 'up'
    const count = Math.min(WHEEL_MAX_COUNT, Math.max(1, Math.floor(Math.abs(args.dy) / WHEEL_STEP_PX)))
    return { type: 'wheel', direction, count }
  }
  return { type: 'none' }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/gesture-classify.test.ts`
Expected: PASS（5 件）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/gesture-classify.ts apps/client/src/lib/__tests__/gesture-classify.test.ts
git commit -m "feat(client): classify touch gesture into tap/wheel"
```

---

## Task 6: `touch-to-mouse.ts`（統合：touch → 送信文字列）

**Files:**
- Create: `apps/client/src/lib/touch-to-mouse.ts`
- Test: `apps/client/src/lib/__tests__/touch-to-mouse.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/touch-to-mouse.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { touchToMouseSequence } from '../touch-to-mouse'

const geo = {
  rectLeft: 0,
  rectTop: 0,
  scrollLeft: 0,
  scrollTop: 0,
  cellWidth: 10,
  cellHeight: 20,
  padding: 8,
  cols: 80,
  rows: 24,
}

describe('touchToMouseSequence', () => {
  it('SGR 無効なら null（送らない）', () => {
    const out = touchToMouseSequence({
      useSgr: false,
      start: { clientX: 18, clientY: 28 },
      end: { clientX: 18, clientY: 28 },
      ...geo,
    })
    expect(out).toBeNull()
  })

  it('タップは start 位置の左クリック press+release', () => {
    // x=18 → col2, y=28 → row2
    const out = touchToMouseSequence({
      useSgr: true,
      start: { clientX: 18, clientY: 28 },
      end: { clientX: 19, clientY: 27 },
      ...geo,
    })
    expect(out).toBe('\x1b[<0;2;2M\x1b[<0;2;2m')
  })

  it('上スワイプは start 位置のホイール下を count 回', () => {
    // dy=-48 → wheel down count2、start x=18→col2 y=28→row2
    const out = touchToMouseSequence({
      useSgr: true,
      start: { clientX: 18, clientY: 28 },
      end: { clientX: 18, clientY: 28 - 48 },
      ...geo,
    })
    expect(out).toBe('\x1b[<65;2;2M\x1b[<65;2;2M')
  })

  it('横移動主は null', () => {
    const out = touchToMouseSequence({
      useSgr: true,
      start: { clientX: 18, clientY: 28 },
      end: { clientX: 18 + 60, clientY: 30 },
      ...geo,
    })
    expect(out).toBeNull()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/touch-to-mouse.test.ts`
Expected: FAIL（`Cannot find module '../touch-to-mouse'`）

- [ ] **Step 3: 実装を書く**

`apps/client/src/lib/touch-to-mouse.ts`:

```ts
import { classifyGesture } from './gesture-classify'
import { encodeMouse } from './sgr-mouse'
import { pixelToCell } from './terminal-coords'

interface Point {
  clientX: number
  clientY: number
}

export interface TouchToMouseArgs {
  useSgr: boolean
  start: Point
  end: Point
  rectLeft: number
  rectTop: number
  scrollLeft: number
  scrollTop: number
  cellWidth: number
  cellHeight: number
  padding: number
  cols: number
  rows: number
}

// touch 開始/終了から cmux へ送る SGR マウス列を組み立てる。送らない場合は null。
export function touchToMouseSequence(args: TouchToMouseArgs): string | null {
  if (!args.useSgr) return null

  const gesture = classifyGesture({
    dx: args.end.clientX - args.start.clientX,
    dy: args.end.clientY - args.start.clientY,
  })
  if (gesture.type === 'none') return null

  const cell = pixelToCell({
    clientX: args.start.clientX,
    clientY: args.start.clientY,
    rectLeft: args.rectLeft,
    rectTop: args.rectTop,
    scrollLeft: args.scrollLeft,
    scrollTop: args.scrollTop,
    cellWidth: args.cellWidth,
    cellHeight: args.cellHeight,
    padding: args.padding,
    cols: args.cols,
    rows: args.rows,
  })

  if (gesture.type === 'tap') {
    return (
      encodeMouse({ button: 'left', action: 'press', col: cell.col, row: cell.row }) +
      encodeMouse({ button: 'left', action: 'release', col: cell.col, row: cell.row })
    )
  }

  const button = gesture.direction === 'down' ? 'wheelDown' : 'wheelUp'
  const notch = encodeMouse({ button, action: 'press', col: cell.col, row: cell.row })
  return notch.repeat(gesture.count)
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/touch-to-mouse.test.ts`
Expected: PASS（4 件）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/touch-to-mouse.ts apps/client/src/lib/__tests__/touch-to-mouse.test.ts
git commit -m "feat(client): assemble SGR mouse sequence from touch start/end"
```

---

## Task 7: `Terminal.tsx` に touch ハンドラを統合

**Files:**
- Modify: `apps/client/src/components/Terminal.tsx`

DOM 依存のため単体テストは行わず、型チェックと Task 9 の実機確認で検証する。

- [ ] **Step 1: import と props を追加**

`Terminal.tsx` 冒頭の import に追加:

```ts
import { cellSize } from '../lib/terminal-coords'
import { touchToMouseSequence } from '../lib/touch-to-mouse'
```

既存の `import type { CSSProperties } from 'react'` を以下に変更（React の touch イベント型を使う。DOM グローバルの `TouchEvent` と衝突しないよう別名にする）:

```ts
import type { CSSProperties, TouchEvent as ReactTouchEvent } from 'react'
```

`TerminalProps` に 3 つ追加:

```ts
interface TerminalProps {
  grid: RenderGrid | null
  content: string
  fontSize: number
  gestureRef: (el: HTMLDivElement | null) => void
  // マウス送信（render_grid.modes から App が導出）。
  mouseEnabled: boolean
  useSgr: boolean
  onSendMouse: (text: string) => void
}
```

関数シグネチャを更新:

```ts
export function Terminal({ grid, content, fontSize, gestureRef, mouseEnabled, useSgr, onSendMouse }: TerminalProps) {
```

- [ ] **Step 2: touch 開始/終了ハンドラを追加**

`Terminal` 関数内、`useGrid` 定数の定義の下に追記。`wrapperRef` で要素実測する:

```ts
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
```

`react` の named import に `TouchEvent` 型は不要（`React.TouchEvent` で参照）。既存の `useCallback`/`useRef`/`useEffect` import はそのまま使う。

- [ ] **Step 3: wrapper に ref とハンドラを配線**

`return` の wrapper `div` を更新（`gestureRef` と新しい `wrapperRef` の両方を要素に割り当てる）:

```tsx
  return (
    <div
      ref={(el) => {
        wrapperRef.current = el
        gestureRef(el)
      }}
      style={wrapperStyle}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
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
```

- [ ] **Step 4: 型チェックが通ることを確認**

Run: `cd apps/client && pnpm tsc --noEmit`
Expected: エラー。`App.tsx` が新しい必須 props（`mouseEnabled`/`useSgr`/`onSendMouse`）を渡していないため。Task 8 で解消する。

> このタスク単独では型エラーが残る。コミットは Task 8 とまとめて行う（Task 8 の Step 5）。

---

## Task 8: `App.tsx` 配線

**Files:**
- Modify: `apps/client/src/App.tsx`

- [ ] **Step 1: import を追加**

`App.tsx` の import に追加:

```ts
import { deriveMouseMode } from './lib/mouse-mode'
```

- [ ] **Step 2: マウスモードを導出**

`Main()` 内、`currentWs` を求めている付近（`const currentWs = ...` の上）に追加:

```ts
  const mouseMode = deriveMouseMode(termGrid)
```

- [ ] **Step 3: swipe ハンドラをマウス有効時に無効化**

`onSwipeLeft` / `onSwipeRight` を更新（マウス有効時はタブ切替を止めて Terminal のホイールに譲る）:

```ts
  const onSwipeLeft = useCallback(() => {
    if (mouseMode.mouseEnabled) return
    navigateSurface('next')
  }, [navigateSurface, mouseMode.mouseEnabled])

  const onSwipeRight = useCallback(() => {
    if (mouseMode.mouseEnabled) return
    navigateSurface('prev')
  }, [navigateSurface, mouseMode.mouseEnabled])
```

- [ ] **Step 4: Terminal に props を渡す**

`<Terminal ... />` を更新:

```tsx
          <Terminal
            grid={historyMode ? null : termGrid}
            content={termContent}
            fontSize={fontSize}
            gestureRef={gestureRef}
            mouseEnabled={mouseMode.mouseEnabled}
            useSgr={mouseMode.useSgr}
            onSendMouse={(text) => {
              if (currentSurface) sendText(currentSurface, text).catch((err) => console.error('[app] mouse error:', err))
            }}
          />
```

- [ ] **Step 5: 型チェック・全テスト・lint を通してコミット**

Run: `cd apps/client && pnpm tsc --noEmit && pnpm vitest run && pnpm biome check ./src`
Expected: すべて PASS（型エラーなし、全テスト緑、lint 警告なし）

```bash
git add apps/client/src/components/Terminal.tsx apps/client/src/App.tsx
git commit -m "feat(client): wire tap/wheel mouse forwarding into Terminal and App"
```

---

## Task 9: 実機検証と閾値調整

**Files:**
- 調整時のみ: `apps/client/src/lib/gesture-classify.ts`（定数）、`apps/client/src/lib/touch-to-mouse.ts`（方向）

- [ ] **Step 1: dev サーバーを起動**

Run: `pnpm dev`
Expected: server :48701 + client :5173 が起動。

- [ ] **Step 2: nvim サーフェスを開いた状態で PWA を操作**

cmux 側で `mouse=a` の nvim（neo-tree 等）を開き、選択ワークスペースにする。ブラウザ（または iPhone PWA）で `http://<host>:5173/?token=<token>` を開き、その nvim タブを表示。

確認項目:
- ツリーの項目を**タップ**してカーソル/選択が移動する（左クリックが効く）。
- バッファ上で**上下スワイプ**して内容がスクロールする（ホイールが効く）。
- スワイプ方向とスクロール方向が直感に合う（合わなければ `gesture-classify.ts` の `direction` 判定、または `touch-to-mouse.ts` の `wheelUp`/`wheelDown` 割り当てを入れ替える）。
- **通常シェルのタブ**に切り替え、タップしてもゴミ文字が入力されない（`mouseEnabled=false` で送られない）。
- 通常シェルのタブでは従来どおり水平スワイプでタブ切替できる。

- [ ] **Step 3: 必要なら閾値/方向を調整して再確認**

タップ/ホイールの感度が悪い場合は `TAP_MAX_DISTANCE` / `WHEEL_MIN_DISTANCE` / `WHEEL_STEP_PX` を調整。変更したら該当テストの期待値も更新し `pnpm vitest run` を通す。

- [ ] **Step 4: 調整があればコミット**

```bash
git add apps/client/src/lib/gesture-classify.ts apps/client/src/lib/touch-to-mouse.ts apps/client/src/lib/__tests__
git commit -m "fix(client): tune tap/wheel thresholds from device testing"
```

---

## 完了条件

- フェーズ1の純粋関数（Task 2-6）がすべてテスト緑。
- `pnpm check`（型 + lint）が両パッケージで通る。
- 実機で nvim のツリーをタップ選択でき、上下スワイプでスクロールでき、通常シェルでは誤入力が出ない。

## スコープ外（フェーズ2、別計画）

長押し＝右クリック、ドラッグ＝範囲選択。`gesture-classify.ts` に `longpress`/`drag` を足し、`sgr-mouse.ts` に `right`（code 2）とドラッグ（code +32）を追加する想定。
