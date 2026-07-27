# 履歴モード廃止・常時スクロールバック連続ビュー Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「ライブ ⇄ 履歴」のモード切替を廃止し、常に「スクロールバック `<pre>`（プレーン）＋色付きライブグリッド」が 1 つのスクロール領域に連続するモードレス表示にする。

**Architecture:** App のポーリングを「`readGrid` 常時＋`readText(scrollback)` は最下部ピン留め中のみ」に統合し、Terminal は `<pre>`（履歴）と wterm（ライブ）を常時縦積みで描画する。ピン留め判定はスクロールコンテナを持つ Terminal が `isAtBottom` で行い `onPinnedChange` で App へ通知。scrollback 末尾の可視画面ぶんは純粋関数（`lib/scrollback.ts`）で削って二重表示を防ぐ。

**Tech Stack:** React 19 + Vite（apps/client）、vitest + @testing-library/react（jsdom）、Biome。

**Spec:** `docs/superpowers/specs/2026-07-27-modeless-scrollback-design.md`

## 実機プローブで確定済みの cmux ソケット仕様（2026-07-27、プラン作成時に検証済み）

実装者は再検証不要。以下を前提としてよい:

1. `surface.read_text { surface_id, scrollback: true, lines: N }` は「履歴＋**現在の可視画面**」を連結したテキストの**末尾 N 行**を返す。可視画面は必ず末尾に含まれる（静止中サーフェスで `read_text`（画面のみ）と末尾が完全一致することを 20+ サーフェスで確認）。
2. 返るテキストの**末尾空行はソケット側でトリム済み**。そのため可視画面ぶんの行数は `grid.rows` **ではなく**「`render_grid` の最終非空行＋1」に一致する（例: rows=58 の端末で画面テキストが 56 行のケースあり。rows で削ると履歴を削りすぎる）。
3. 「末尾空行を除いた grid 由来の行数」と「`read_text`（画面）の行数」は全検証ケースで一致（折返し行も視覚行単位で一致。全画面 TUI・短い画面・空行入りの両方で確認）。
4. 未起動の停止端末は `terminal.replay` の `render_grid` が欠落し、`read_text` は `internal_error` を返す（既存の null-grid 経路で処理済み。scrollback フェッチは grid がある時のみ行えばよい）。
5. 出力が高速に流れている最中は 2 回の RPC 間で画面がずれ、seam が一時的に数行ズレることがある。毎秒ポーリングで自己修復されるため許容（spec 記載のエッジ）。

## Global Constraints

- Biome: シングルクォート・セミコロンなし（asNeeded）・行幅 120。各タスクの最後に `pnpm check` を通すこと。
- TypeScript: `any` / `unknown`（単体）型・`class` の新規使用禁止（既存の `Record<string, unknown>` パターンは可）。
- コードコメントは既存コードに合わせ日本語で書く。
- 既存挙動の温存: ライブ描画（`renderGridToAnsi`・`[2J[3J[H`）、タップ/ピンチ/横スクロール、幅実測（`measuredWidth`）、オフラインキャッシュ形式（`CachedScreen`）は変更しない。
- 設定範囲は据え置き: `HISTORY_LINES_MIN=1000` / `MAX=100000` / `DEFAULT=2000`（`cmux:history-lines`）。
- コマンドはリポジトリルート `/Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor` から実行（単一テストは `cd apps/client`）。

---

### Task 1: ブランチ作成＋ `lib/scrollback.ts`（seam 除去の純粋関数、TDD）

**Files:**
- Create: `apps/client/src/lib/scrollback.ts`
- Test: `apps/client/src/lib/__tests__/scrollback.test.ts`

**Interfaces:**
- Consumes: `RenderGrid`（`apps/client/src/lib/render-grid.ts` の既存型。`row_spans: { row, column, style_id, cell_width, text }[]`）
- Produces（Task 2 の App が使う）:
  - `visibleLineCount(grid: RenderGrid): number` — grid の「内容がある最終行＋1」（内容行なしなら 0）
  - `stripVisibleScreen(text: string, visibleLines: number): string` — scrollback テキストの末尾から可視画面ぶんを削った履歴のみを返す（履歴が無ければ `''`）

- [ ] **Step 1: ブランチ作成**

```bash
git switch -c feat/modeless-scrollback
```

- [ ] **Step 2: 失敗するテストを書く**

`apps/client/src/lib/__tests__/scrollback.test.ts` を以下の内容で作成:

```ts
import { describe, expect, it } from 'vitest'

import type { RenderGrid } from '../render-grid'
import { stripVisibleScreen, visibleLineCount } from '../scrollback'

// row ごとのテキストだけ指定して RenderGrid を作るヘルパ（他フィールドは判定に関与しない）。
function gridWith(spans: { row: number; text: string }[]): RenderGrid {
  return {
    columns: 80,
    rows: 24,
    styles: [],
    row_spans: spans.map((s) => ({ row: s.row, column: 0, style_id: 0, cell_width: s.text.length, text: s.text })),
  }
}

describe('visibleLineCount', () => {
  it('span が無い空グリッドは 0', () => {
    expect(visibleLineCount(gridWith([]))).toBe(0)
  })

  it('内容の最終行+1 を返す（rows=24 でも下部が空なら小さくなる）', () => {
    // read_text は末尾空行をトリムするため、画面ぶんの行数は rows でなく「最終非空行+1」。
    expect(visibleLineCount(gridWith([{ row: 0, text: 'a' }, { row: 16, text: 'status' }]))).toBe(17)
  })

  it('空白のみの span は内容行とみなさない', () => {
    expect(visibleLineCount(gridWith([{ row: 2, text: 'x' }, { row: 10, text: '   ' }]))).toBe(3)
  })

  it('span の順序に依存しない', () => {
    expect(visibleLineCount(gridWith([{ row: 5, text: 'b' }, { row: 1, text: 'a' }]))).toBe(6)
  })
})

describe('stripVisibleScreen', () => {
  it('末尾の可視画面ぶんを削り履歴のみ返す', () => {
    expect(stripVisibleScreen('h1\nh2\ns1\ns2\ns3', 3)).toBe('h1\nh2')
  })

  it('全行が画面（履歴なし）なら空文字', () => {
    expect(stripVisibleScreen('s1\ns2', 2)).toBe('')
  })

  it('行数が visibleLines 未満でも空文字（負にならない）', () => {
    expect(stripVisibleScreen('s1', 5)).toBe('')
  })

  it('末尾に空行があっても画面ぶんを正しく削る（ソケットはトリム済みだが保険）', () => {
    expect(stripVisibleScreen('h1\ns1\ns2\n\n', 2)).toBe('h1')
  })

  it('visibleLines=0 は末尾空行だけ落とした全文を返す', () => {
    expect(stripVisibleScreen('h1\nh2\n', 0)).toBe('h1\nh2')
  })

  it('空文字は空文字のまま', () => {
    expect(stripVisibleScreen('', 3)).toBe('')
  })
})
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/scrollback.test.ts`
Expected: FAIL（`Cannot find module '../scrollback'` 相当のモジュール解決エラー）

- [ ] **Step 4: 実装を書く**

`apps/client/src/lib/scrollback.ts` を以下の内容で作成:

```ts
// ライブ表示に常時併記するスクロールバック（履歴）の seam 処理。
//
// 実機プローブで確定した cmux ソケットの仕様（docs/superpowers/plans/2026-07-27-modeless-scrollback.md）:
// - surface.read_text { scrollback: true, lines: N } は「履歴 + 現在の可視画面」を連結した
//   テキストの末尾 N 行を返す（可視画面は必ず末尾に含まれる）。
// - テキストの末尾空行はソケット側でトリム済みのため、可視画面ぶんの行数は grid.rows でなく
//   「render_grid の最終非空行 + 1」と一致する（rows で削ると下部が空の端末で履歴を削りすぎる）。
import type { RenderGrid } from './render-grid'

// render_grid の「内容がある最終行 + 1」= read_text が画面ぶんとして返す行数。内容が無ければ 0。
export function visibleLineCount(grid: RenderGrid): number {
  let last = -1
  for (const span of grid.row_spans) {
    if (span.row > last && span.text.trim() !== '') last = span.row
  }
  return last + 1
}

// scrollback テキストから末尾の可視画面ぶん（visibleLines 行）を削り、履歴のみを返す。
// 下に色付きグリッド（可視画面）を併記するため、削らないと画面が二重に見える。
export function stripVisibleScreen(text: string, visibleLines: number): string {
  if (text === '') return ''
  const lines = text.split('\n')
  // 末尾の空行を除いてから削る（ソケット側でトリム済みのはずだが保険）。
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--
  const cut = Math.max(0, end - visibleLines)
  return lines.slice(0, cut).join('\n')
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/scrollback.test.ts`
Expected: PASS（10 tests）

- [ ] **Step 6: check を通してコミット**

```bash
pnpm check
git add apps/client/src/lib/scrollback.ts apps/client/src/lib/__tests__/scrollback.test.ts
git commit -m "feat(client): scrollback の seam 除去純粋関数を追加"
```

---

### Task 2: Terminal のモードレス化＋App のポーリング統合（中核）

**Files:**
- Modify: `apps/client/src/components/Terminal.tsx`（全面書き換え。完成形を下に掲載）
- Modify: `apps/client/src/App.tsx`（ハンク単位の編集。下に old→new を掲載）
- Test: `apps/client/src/components/__tests__/Terminal.test.tsx`（全面書き換え）

**Interfaces:**
- Consumes: Task 1 の `visibleLineCount(grid)` / `stripVisibleScreen(text, visibleLines)`、既存 `isAtBottom({ scrollTop, clientHeight, scrollHeight })`（`lib/scroll-intent.ts`）、既存 `readText(surfaceRef, { scrollback: true, lines })`（`hooks/useCmux.ts`）
- Produces: `Terminal` の新 props 契約（Task 4 以降は触らない）:
  - `grid: RenderGrid | null` / `scrollback: string`（seam 除去済み。grid=null 時は全文）/ `fontSize` / `mouseEnabled` / `useSgr` / `onSendMouse` / `onAdjustFontSize` / `onPinnedChange: (pinned: boolean) => void` / `resetKey: string | null`
  - 旧 props `content` / `onEnterHistory` / `onExitHistory` は削除

**設計メモ（実装者向け）:**
- 「据え置き」は **state を凍結することで実現**する。App は非ピン中に scrollback をフェッチしない → `termHistory` state が変わらない → `<pre>` が動かない。grid は毎秒更新されるが `<pre>` の描画には使わないため、レンダー時に削り直してはいけない（削り直すと凍結中の `<pre>` が動いてしまう）。削りは**フェッチ時に同ポーリングの grid で 1 回だけ**行う。
- Terminal 内の layout effect は**宣言順が重要**: resetKey リセット（ピン留め復帰）→ 末尾追従、の順に置く。
- タップ座標は `<pre>` が上に積まれるため wrapper でなく `.wterm` 要素の rect 基準にする。rect はスクロール済み位置を反映するので `scrollLeft/scrollTop` は 0 を渡す。

- [ ] **Step 1: Terminal.test.tsx を新契約で全面書き換え（失敗するテスト）**

`apps/client/src/components/__tests__/Terminal.test.tsx` を以下の内容で置き換え:

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import type { CSSProperties } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderGrid } from '../../lib/render-grid'

// @wterm/react をモックし、ルート要素 (.wterm) へ渡る style prop を捕捉する。
// 実機の横スクロールは jsdom がレイアウトを計算しない（scrollWidth=0）ため検証不能。
// 実装はタップ座標の基準に .wterm を querySelector するため、モックもクラス付き要素を実 DOM に出す。
const { wtermProps } = vi.hoisted(() => ({
  wtermProps: { current: {} as Record<string, unknown> },
}))

vi.mock('@wterm/react', () => ({
  useTerminal: () => ({ ref: { current: null }, write: () => {} }),
  Terminal: (props: Record<string, unknown>) => {
    wtermProps.current = props
    return <div className="wterm" style={props.style as CSSProperties} />
  },
}))

import { Terminal } from '../Terminal'

const grid: RenderGrid = {
  columns: 120,
  rows: 40,
  styles: [],
  row_spans: [],
}

const baseProps = {
  scrollback: '',
  fontSize: 14,
  mouseEnabled: false,
  useSgr: false,
  onSendMouse: () => {},
  onAdjustFontSize: () => {},
  onPinnedChange: () => {},
  resetKey: 'surface:1',
}

// jsdom はレイアウト非計算のため、スクロール寸法を明示定義して「代入の配線」を回帰ガードする。
function defineScrollMetrics(
  el: HTMLElement,
  init: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {},
) {
  let scrollTopVal = init.scrollTop ?? 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTopVal,
    set: (v: number) => {
      scrollTopVal = v
    },
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => init.scrollHeight ?? 1000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => init.clientHeight ?? 100 })
}

describe('Terminal width sizing', () => {
  afterEach(cleanup)

  it('grid モードでは幅を max(100%, 実測 px) にし、未計測時はコンテナ(100%)を満たす', () => {
    render(<Terminal grid={grid} {...baseProps} />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.width).toBe('max(100%, 0px)')
  })

  it('grid なし(プレーンテキストのみ)では幅を固定せずコンテナに合わせる', () => {
    render(<Terminal grid={null} {...baseProps} scrollback="hello" />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.width).toBeUndefined()
  })

  it('grid が undefined（停止端末で replay が空）でも落ちず、グリッド無し扱いにする', () => {
    // 型は RenderGrid | null だが、実機では undefined が混入し得るためキャストで再現する。
    const undefinedGrid = undefined as unknown as RenderGrid | null
    render(<Terminal grid={undefinedGrid} {...baseProps} scrollback="hello" />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.width).toBeUndefined()
  })
})

describe('Terminal scrollback rendering', () => {
  afterEach(cleanup)

  // モードレスの核: ライブ(grid)中も scrollback が pre として「上に」常時併記される。
  it('ライブ(grid)中も scrollback を pre で wterm の上に併記する', () => {
    const { container } = render(<Terminal grid={grid} {...baseProps} scrollback={'h1\nh2'} />)
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('h1')
    // wterm(色付きライブ)は隠されない
    const style = wtermProps.current.style as CSSProperties
    expect(style.display).not.toBe('none')
    // pre は wterm より前(上)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.firstElementChild?.tagName).toBe('PRE')
  })

  it('scrollback が空なら pre を描画しない', () => {
    const { container } = render(<Terminal grid={grid} {...baseProps} />)
    expect(container.querySelector('pre')).toBeNull()
  })

  // wterm の WASM スクロールバックは 1000 行でハードコード頭打ちのため、プレーンテキストは
  // wterm に流さず pre へ全行直描画する（historyLines>1000 でも欠けない）。
  it('grid なしでは wterm を隠し scrollback 全文を pre に描画する（1000 行超も欠けない）', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}`)
    const { container } = render(<Terminal grid={null} {...baseProps} scrollback={lines.join('\n')} />)
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toContain('line-0')
    expect(pre?.textContent).toContain('line-2999')
    const style = wtermProps.current.style as CSSProperties
    expect(style.display).toBe('none')
  })
})

describe('Terminal pinned follow', () => {
  afterEach(cleanup)

  it('ピン留め中(既定)は内容更新で最下部(scrollHeight)へ追従する', () => {
    const { container, rerender } = render(<Terminal grid={grid} {...baseProps} scrollback="a" />)
    const wrapper = container.firstChild as HTMLElement
    defineScrollMetrics(wrapper)
    rerender(<Terminal grid={grid} {...baseProps} scrollback={'a\nb'} />)
    expect(wrapper.scrollTop).toBe(1000)
  })

  it('上へスクロールすると onPinnedChange(false)、以後の内容更新では scrollTop を触らない(据え置き)', () => {
    const onPinnedChange = vi.fn()
    const { container, rerender } = render(
      <Terminal grid={grid} {...baseProps} scrollback="a" onPinnedChange={onPinnedChange} />,
    )
    const wrapper = container.firstChild as HTMLElement
    defineScrollMetrics(wrapper, { scrollTop: 500 })
    fireEvent.scroll(wrapper)
    expect(onPinnedChange).toHaveBeenLastCalledWith(false)
    rerender(<Terminal grid={grid} {...baseProps} scrollback={'a\nb'} onPinnedChange={onPinnedChange} />)
    expect(wrapper.scrollTop).toBe(500)
  })

  it('最下部へ戻ると onPinnedChange(true) を通知する', () => {
    const onPinnedChange = vi.fn()
    const { container } = render(<Terminal grid={grid} {...baseProps} scrollback="a" onPinnedChange={onPinnedChange} />)
    const wrapper = container.firstChild as HTMLElement
    defineScrollMetrics(wrapper, { scrollTop: 500 })
    fireEvent.scroll(wrapper)
    // scrollHeight(1000) - (900 + clientHeight(100)) = 0 <= epsilon → 最下部
    wrapper.scrollTop = 900
    fireEvent.scroll(wrapper)
    expect(onPinnedChange).toHaveBeenLastCalledWith(true)
  })

  it('resetKey 変化(サーフェス切替)でピン留めへ戻し最下部へスクロールする', () => {
    const { container, rerender } = render(<Terminal grid={grid} {...baseProps} scrollback="a" />)
    const wrapper = container.firstChild as HTMLElement
    defineScrollMetrics(wrapper, { scrollTop: 500 })
    fireEvent.scroll(wrapper) // ピン解除
    rerender(<Terminal grid={grid} {...baseProps} scrollback="b" resetKey="surface:2" />)
    expect(wrapper.scrollTop).toBe(1000)
  })
})

describe('Terminal tap handling', () => {
  afterEach(cleanup)

  // jsdom はレイアウト非計算のため着弾セルは検証できないが、合成 click の抑止
  // (preventDefault) は検証できる。これが無いと wterm が画面外 textarea を focus() し、
  // 仮想キーボードが出てパン位置も左端へ戻る。fireEvent は default 抑止時に false を返す。
  it('一本指タップは合成 click(仮想キーボード)を抑止しつつ左クリックを送る', () => {
    const onSendMouse = vi.fn()
    const { container } = render(<Terminal grid={grid} {...baseProps} mouseEnabled useSgr onSendMouse={onSendMouse} />)
    const wrapper = container.firstChild as HTMLElement
    fireEvent.touchStart(wrapper, { touches: [{ clientX: 20, clientY: 20 }] })
    const notPrevented = fireEvent.touchEnd(wrapper, {
      touches: [],
      changedTouches: [{ clientX: 20, clientY: 20 }],
    })
    expect(notPrevented).toBe(false)
    expect(onSendMouse).toHaveBeenCalledTimes(1)
  })

  it('マウスモード無効でもタップは合成 click を抑止する(無機能なキーボードを出さない)', () => {
    const onSendMouse = vi.fn()
    const { container } = render(<Terminal grid={grid} {...baseProps} onSendMouse={onSendMouse} />)
    const wrapper = container.firstChild as HTMLElement
    fireEvent.touchStart(wrapper, { touches: [{ clientX: 20, clientY: 20 }] })
    const notPrevented = fireEvent.touchEnd(wrapper, {
      touches: [],
      changedTouches: [{ clientX: 20, clientY: 20 }],
    })
    expect(notPrevented).toBe(false)
    expect(onSendMouse).not.toHaveBeenCalled()
  })

  // 一本指ドラッグはネイティブスクロール。閾値超えの移動があれば click は送らず、default も
  // 抑止しない（preventDefault するとスクロール慣性が止まるため）。fireEvent は非抑止時 true を返す。
  it('一本指ドラッグ(スクロール)は click を送らず default も抑止しない', () => {
    const onSendMouse = vi.fn()
    const { container } = render(<Terminal grid={grid} {...baseProps} mouseEnabled useSgr onSendMouse={onSendMouse} />)
    const wrapper = container.firstChild as HTMLElement
    fireEvent.touchStart(wrapper, { touches: [{ clientX: 20, clientY: 20 }] })
    fireEvent.touchMove(wrapper, { touches: [{ clientX: 20, clientY: 90 }] })
    const notPrevented = fireEvent.touchEnd(wrapper, {
      touches: [],
      changedTouches: [{ clientX: 20, clientY: 90 }],
    })
    expect(notPrevented).toBe(true)
    expect(onSendMouse).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/Terminal.test.tsx`
Expected: FAIL（新 props `scrollback`/`onPinnedChange`/`resetKey` が未実装。tsx の型エラーまたはアサーション失敗）

- [ ] **Step 3: Terminal.tsx を全面書き換え**

`apps/client/src/components/Terminal.tsx` を以下の内容で置き換え:

```tsx
import { useTerminal, Terminal as WTerminal } from '@wterm/react'
import type { CSSProperties, TouchEvent as ReactTouchEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '@wterm/react/css'
import { centroid, isTap, touchDistance } from '../lib/multitouch'
import { type RenderGrid, renderGridToAnsi } from '../lib/render-grid'
import { isAtBottom } from '../lib/scroll-intent'
import { encodeClick } from '../lib/sgr-mouse'
import { cellSize, pixelToCell } from '../lib/terminal-coords'

interface TerminalProps {
  // ライブ表示用の描画グリッド。null のとき scrollback(プレーンテキスト)のみを描く。
  grid: RenderGrid | null
  // グリッドの上へ常時併記するスクロールバック(履歴・プレーンテキスト、seam 除去済み)。
  // grid=null(停止端末/オフライン)のときは画面込みの全文が渡る。空文字なら描画しない。
  scrollback: string
  fontSize: number
  // マウス送信（render_grid.modes から App が導出）。
  mouseEnabled: boolean
  useSgr: boolean
  onSendMouse: (text: string) => void
  // 二本指ピンチでのフォントサイズ増減（+1 = 拡大 / -1 = 縮小）。
  onAdjustFontSize: (delta: number) => void
  // 最下部ピン留め状態の変化通知。App が scrollback フェッチの可否（据え置き）に使う。
  onPinnedChange: (pinned: boolean) => void
  // サーフェス切替でピン留め＋最下部へリセットするためのキー。
  resetKey: string | null
}

// スクロールバックの <pre> 描画用整形。末尾空白を落として横幅の無駄な肥大
// （read_text は行を cols 幅まで空白で埋める）を防ぐ。行頭インデントは保持する。
function cleanScreen(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
}

const PADDING = 8
// Latin/CJK の両方をこの 2:1 等幅フォントで描き、全角を確実に 2×Latin にする(セル=cmux と一致)。
// 未ロード時のフォールバックに Menlo 系を残す。wterm(--term-font-family)とスクロールバックの <pre> で共用する。
const TERM_FONT_FAMILY = "'M PLUS 1 Code', Menlo, Consolas, 'DejaVu Sans Mono', 'Courier New', monospace"
// ピンチでフォントを 1 段変えるのに必要な指間距離の変化（px）。
const PINCH_STEP_PX = 32

// アクティブなタッチジェスチャーの状態。スクロールはブラウザのネイティブに任せ、ここでは
// タップ/ピンチ/右クリックだけを判定する。閾値を超えて動いた or ピンチした場合は moved=true で、
// touchend のクリック（タップ）送信を抑止する。
type GestureState =
  | { kind: 'single'; startX: number; startY: number; moved: boolean }
  | { kind: 'double'; centerX: number; centerY: number; lastDistance: number; zoomAccum: number; moved: boolean }

export function Terminal({
  grid,
  scrollback,
  fontSize,
  mouseEnabled,
  useSgr,
  onSendMouse,
  onAdjustFontSize,
  onPinnedChange,
  resetKey,
}: TerminalProps) {
  const { ref, write } = useTerminal()
  const gridRef = useRef<RenderGrid | null>(null)
  const readyRef = useRef(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // grid モードの横幅に使う実測コンテンツ幅(px)。0 のうちは下の termStyle が cols*ch フォールバック。
  const [measuredWidth, setMeasuredWidth] = useState(0)

  // wterm に書くのは grid のみ。プレーンテキスト(スクロールバック/オフライン)は wterm の WASM
  // スクロールバックが 1000 行でハードコード頭打ち(変更 API なし)のため wterm に流さず、
  // <pre> に全行を直描画する。これが無いと設定の履歴バッファ(historyLines)を 1000 超に
  // 上げても遡れる範囲が変わらない。
  const repaint = useCallback(
    (g: RenderGrid | null) => {
      if (g) write(renderGridToAnsi(g))
    },
    [write],
  )

  useEffect(() => {
    gridRef.current = grid
    if (readyRef.current) repaint(grid)
  }, [grid, repaint])

  const onReady = useCallback(() => {
    readyRef.current = true
    // wterm は click で画面外(left:-9999px)の textarea を focus() する。本ビューアは onData を捨てる
    // ためキーボード入力は無機能で、focus は (1) モバイル仮想キーボード表示 (2) その textarea を見せ
    // ようと wrapper を左端へスクロールさせる、という害しか生まない。textarea を disabled にして
    // フォーカス自体を無効化し、合成 click が漏れても副作用を断つ。
    const textarea = wrapperRef.current?.querySelector('textarea')
    if (textarea) textarea.disabled = true
    repaint(gridRef.current)
  }, [repaint])

  // grid モードの実コンテンツ幅を計測する。wterm は通常文字をセル幅非固定の素 span で描くため
  // 全角(日本語/絵文字)を含む行は cols*ch を超える。行コンテナ .term-grid の scrollWidth が(制約幅
  // より広い)実最長行幅を反映するのでそれを採る。grow-only(既存以下は無視)にして、wterm が再描画で
  // grid DOM を一瞬空にするフレームや縮小フレームでも明示幅を絶対に潰さない=左へ飛ぶチラつきを断つ。
  const measure = useCallback(() => {
    // grid モード時のみ。プレーンテキスト(grid=null)は termStyle が width を付けず measuredWidth を
    // 使わないので、長いスクロールバック行で値を肥大(=grid 復帰時の過剰確保)させないよう測らない。
    if (!gridRef.current) return
    const gridEl = wrapperRef.current?.querySelector('.term-grid')
    if (!gridEl) return
    // 寸法変化直後の「空行だけ(setup の innerHTML='' 後)」フレームは無視する — 空行は span を持たない。
    // これを測ると幅が誤って潰れ/膨らみ、scrollLeft が左へ飛ぶ(チラつき)。
    if (!gridEl.querySelector('.term-row > span')) return
    // 実コンテンツ幅 = 「末尾空白を除いた最右の文字位置」。端末は行を cols 幅まで空白で埋めるため、行全体や
    // .term-grid を測ると「内容より右の空セル」まで含め、grid が pane より広いと右に余白/横スクロールが出る。
    // 各テキストノードで末尾空白を除いた Range の right を取り、その最大を content 幅とする(全角は実ジオメトリ
    // で正しく反映)。Range はコンテナ幅に依存しないのでフィードバックも無い。allow-shrink で現在画面にフィット。
    const gridLeft = gridEl.getBoundingClientRect().left
    const range = document.createRange()
    const walker = document.createTreeWalker(gridEl, NodeFilter.SHOW_TEXT)
    let maxRight = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const end = (node.nodeValue ?? '').replace(/\s+$/, '').length
      if (end === 0) continue
      range.setStart(node, 0)
      range.setEnd(node, end)
      const right = range.getBoundingClientRect().right
      if (right > maxRight) maxRight = right
    }
    if (maxRight === 0) return
    // .wterm は border-box。コンテンツ幅に padding(2*PADDING) を足したものが必要な .wterm 幅。
    setMeasuredWidth(Math.ceil(maxRight - gridLeft) + PADDING * 2)
  }, [])

  // wterm は write 後に setTimeout(0)+rAF で非同期に行を再描画する。その DOM 変化を MutationObserver
  // で捉え、rAF でデバウンスして実幅を計測する(.term-grid は WTerm コンストラクタで同期生成済み)。
  useEffect(() => {
    const gridEl = wrapperRef.current?.querySelector('.term-grid')
    if (!gridEl) return
    let raf = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    observer.observe(gridEl, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [measure])

  // フォント増減はセル寸法を変えるため積み上げた実幅をリセットして再計測する(縮小時の過剰確保を防ぐ)。
  // フォント変更は CSS 反映のみで DOM mutation を起こさず MutationObserver が発火しないので明示再計測。
  // 寸法(cols/rows)変化ではリセットしない: floor=cols*ch が現寸法に追従し measuredWidth は grow-only で
  // 据え置くため幅が下がらず、リモートのペイン再サイズ(自動イベント)でもチラつかない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: fontSize は再計測トリガーで本体では未参照。
  useEffect(() => {
    setMeasuredWidth(0)
    const raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [fontSize, measure])

  // grid モードはネイティブ寸法に固定（autoResize 廃止）。@wterm は cols/rows prop 変化時に
  // 自動で resize() するため、グリッドの幅・行数どおりに表示しデスクトップ cmux と一致させる。
  // `!= null` で null と undefined の両方を「グリッド無し」とする。`!== null` だと停止端末で
  // render_grid 欠落→undefined になった grid が cols={grid.columns} まで到達して落ちる。
  const useGrid = grid != null

  // 最下部ピン留め。wrapper の scroll（capture 段＝子要素がスクロールする構成でも拾える）で
  // isAtBottom を判定し、変化時のみ App へ通知する。App はピン留め中のみ scrollback をフェッチする
  // ため、上へ遡って読んでいる間は <pre> が据え置きになる（読んでいる行が流れない）。
  const pinnedRef = useRef(true)
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null
      if (!el || typeof el.scrollTop !== 'number') return
      const pinned = isAtBottom({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      })
      if (pinned !== pinnedRef.current) {
        pinnedRef.current = pinned
        onPinnedChange(pinned)
      }
    }
    wrapper.addEventListener('scroll', onScroll, true)
    return () => wrapper.removeEventListener('scroll', onScroll, true)
  }, [onPinnedChange])

  // サーフェス切替(resetKey 変化)時はピン留めへ戻し最下部から再開する。下の追従 effect より
  // 先に宣言し、同一コミットで両方発火しても「リセット→追従」の順で整合させる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey は切替検知トリガーで本体では未参照。
  useLayoutEffect(() => {
    pinnedRef.current = true
    const el = wrapperRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [resetKey])

  // ピン留め中の末尾追従。<pre>(scrollback)/grid の高さ変化・フォント変更のたびに最下部へ合わせる。
  // 非ピン中は一切触らない（ネイティブ慣性・読取位置を維持）。プログラム的な scrollTop 代入も
  // scroll イベントを発火するが、最下部への代入は isAtBottom=true → pinned 変化なしで無害。
  // biome-ignore lint/correctness/useExhaustiveDependencies: grid/scrollback/fontSize は高さ変化のトリガーで本体では未参照。
  useLayoutEffect(() => {
    if (!pinnedRef.current) return
    const el = wrapperRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [grid, scrollback, fontSize])

  const gestureStateRef = useRef<GestureState | null>(null)

  // クリック送信が有効なのは「マウス入力 + SGR + grid（cols/rows 既知）」が揃ったときだけ。
  // スクロールはマウスモードに関係なくネイティブで常に効く。
  const clickActive = mouseEnabled && useSgr && grid !== null

  // クライアント座標 → 1-based セル位置。grid 不在なら null。
  // 上に <pre>(スクロールバック) が積まれるため wrapper でなく .wterm(グリッド描画要素) を基準にする。
  // rect はスクロール済み位置を反映するので scrollLeft/scrollTop の補正は不要(0 を渡す)。
  const pointToCell = useCallback(
    (clientX: number, clientY: number) => {
      const el = wrapperRef.current?.querySelector<HTMLElement>('.wterm')
      if (!el || !grid) return null
      const rect = el.getBoundingClientRect()
      const { cellWidth, cellHeight } = cellSize({
        contentWidth: el.offsetWidth,
        contentHeight: el.offsetHeight,
        cols: grid.columns,
        rows: grid.rows,
        padding: PADDING,
      })
      return pixelToCell({
        clientX,
        clientY,
        rectLeft: rect.left,
        rectTop: rect.top,
        scrollLeft: 0,
        scrollTop: 0,
        cellWidth,
        cellHeight,
        padding: PADDING,
        cols: grid.columns,
        rows: grid.rows,
      })
    },
    [grid],
  )

  const onTouchStart = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    const a = e.touches[0]
    const b = e.touches[1]
    if (a && b) {
      const c = centroid(a, b)
      gestureStateRef.current = {
        kind: 'double',
        centerX: c.x,
        centerY: c.y,
        lastDistance: touchDistance(a, b),
        zoomAccum: 0,
        moved: false,
      }
    } else if (a) {
      gestureStateRef.current = { kind: 'single', startX: a.clientX, startY: a.clientY, moved: false }
    }
  }, [])

  const onTouchMove = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      const state = gestureStateRef.current
      if (!state) return
      const a = e.touches[0]
      const b = e.touches[1]

      if (state.kind === 'single') {
        // 一本指の縦横スクロールはブラウザのネイティブに任せる（preventDefault しないので慣性が残る）。
        // 閾値を超えて動いたらタップではなくスクロールと判定する。
        if (a && !isTap(a.clientX - state.startX, a.clientY - state.startY)) state.moved = true
        return
      }

      if (!a || !b) return
      // 二本指: 指間距離の変化を貯め 1 段ごとにフォント増減（ピンチズーム）。中心の平行移動は
      // ネイティブの二本指スクロールに任せる。距離変化=ピンチ／中心移動=スクロールのいずれでも
      // タップではないので moved=true にし、touchend での右クリック送信を抑止する。
      const c = centroid(a, b)
      const d = touchDistance(a, b)
      state.zoomAccum += d - state.lastDistance
      state.lastDistance = d
      while (state.zoomAccum >= PINCH_STEP_PX) {
        onAdjustFontSize(1)
        state.zoomAccum -= PINCH_STEP_PX
        state.moved = true
      }
      while (state.zoomAccum <= -PINCH_STEP_PX) {
        onAdjustFontSize(-1)
        state.zoomAccum += PINCH_STEP_PX
        state.moved = true
      }
      if (!isTap(c.x - state.centerX, c.y - state.centerY)) state.moved = true
    },
    [onAdjustFontSize],
  )

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      // 指がすべて離れたタイミングでジェスチャーを確定する（多指は最後の touchend で評価）。
      if (e.touches.length > 0) return
      const state = gestureStateRef.current
      gestureStateRef.current = null
      // 動いた = ドラッグ（スクロール）。クリックも preventDefault もしない（ネイティブ慣性を維持）。
      if (!state || state.moved) return

      // タップ確定: 合成 click を抑止し、wterm の textarea focus 由来のキーボード/スクロール副作用を断つ。
      e.preventDefault()
      if (!clickActive) return

      if (state.kind === 'single') {
        const t = e.changedTouches[0]
        if (!t) return
        const cell = pointToCell(t.clientX, t.clientY)
        if (cell) onSendMouse(encodeClick('left', cell.col, cell.row))
        return
      }

      // 二本指タップ → 右クリック（開始時の中心位置へ）。
      const cell = pointToCell(state.centerX, state.centerY)
      if (cell) onSendMouse(encodeClick('right', cell.col, cell.row))
    },
    [clickActive, onSendMouse, pointToCell],
  )

  const onTouchCancel = useCallback(() => {
    gestureStateRef.current = null
  }, [])

  const wrapperStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    width: '100%',
    // <pre>(スクロールバック)＋wterm(ライブ) の縦積みを縦に、cols がスマホ幅を超える grid や
    // 長いスクロールバック行を横に、ひとつのネイティブスクロールで扱う。
    overflow: 'auto',
    // 一本指でブラウザのネイティブ縦横スクロール（慣性付き）。タップ/右クリックは touchend で判定する。
    touchAction: 'pan-x pan-y',
    backgroundColor: 'var(--color-terminal-bg)',
  }

  // wterm reads font/colors from CSS custom properties on the terminal element.
  const termStyle = {
    padding: PADDING,
    borderRadius: 0,
    boxShadow: 'none',
    // grid モードの横幅。wterm の renderer は通常文字を「セル幅非固定の素の <span>」で描く
    // (width:1ch が付くのは罫線/ブロック文字 0x2580-0x259f 専用)ため、行幅は自然グリフ幅で決まり、
    // 全角(日本語/絵文字)を含む行は cols*ch を超える。固定 cols*ch + .wterm(overflow:hidden) だと
    // 超過分が永久にクリップされ wrapper の scrollWidth にも入らない=右が見切れてスクロールしても届かない。
    // そこで上の measure() で実測した measuredWidth(px) まで広げてクリップを無くす。max-content 等の
    // intrinsic 値は wterm が再描画で grid DOM を一瞬空にする(renderer.setup の innerHTML='')間に潰れて
    // scrollLeft が左へ飛ぶ(チラつき)ため使わない。明示 px(measuredWidth)＋floor cols*ch の max() は
    // どちらも確定値=空フレームでも潰れず無チラつき。floor は初回(measuredWidth=0)と現寸法への追従を担う。
    // box-sizing:border-box なので padding 分を加算。
    // .wterm 幅: まずコンテナ(100%)を満たし(右に app 背景の隙間を作らない)、実コンテンツ(末尾空白除外)が
    // それを超える(モバイル/内容が pane より広い)なら実測幅まで広げて横スクロール可能に。cols*ch は使わない
    // (末尾の空セルまで含み grid が pane より広いと右に余白が出るため)。未計測(0)時は 100% = pane を満たす。
    width: grid ? `max(100%, ${measuredWidth}px)` : undefined,
    '--term-font-family': TERM_FONT_FAMILY,
    '--term-bg': '#1e1e1e',
    '--term-fg': '#e0e0e0',
    '--term-cursor': '#e0e0e0',
    '--term-font-size': `${fontSize}px`,
    // grid が無い(停止端末/オフライン)ときは wterm を隠し、上の <pre> だけが全文を描画する。
    // grid モードは WTerminal が rows 由来の固定高(mergedStyle)を付けるため display キーを
    // 入れない条件付きスプレッドにする。
    ...(useGrid ? {} : { display: 'none' }),
  } as CSSProperties

  // スクロールバック(プレーンテキスト)の <pre>。wterm と同じ見た目(フォント/余白/前景色)に合わせる。
  // ターミナルのビューポートは全テーマでダーク固定のため配色は wterm の --term-* と同じ実値。
  // 長行は折り返さず width:max-content で最長行まで箱を広げ、wrapper の横スクロールで見る。
  // 下に wterm(padding 8) が続くため paddingBottom は 0 にして seam の隙間を二重にしない。
  const preStyle: CSSProperties = {
    margin: 0,
    padding: `${PADDING}px ${PADDING}px 0 ${PADDING}px`,
    fontFamily: TERM_FONT_FAMILY,
    fontSize: `${fontSize}px`,
    lineHeight: 1.2,
    color: '#e0e0e0',
    whiteSpace: 'pre',
    width: 'max-content',
    minWidth: '100%',
  }

  return (
    <div
      ref={wrapperRef}
      style={wrapperStyle}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {scrollback !== '' && <pre style={preStyle}>{cleanScreen(scrollback)}</pre>}
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

- [ ] **Step 4: Terminal のテストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/Terminal.test.tsx`
Expected: PASS（13 tests）。ただしこの時点で `pnpm check` は App.tsx の型エラーで落ちる（次 Step で解消）。

- [ ] **Step 5: App.tsx を統合ポーリングへ書き換え**

以下のハンクを順に適用する（old → new は完全一致で置換）。

**(a) import 追加** — `render-grid` import の下、`rpc-error` の行の後に 1 行挿入:

```ts
import { isStaleSurfaceError } from './lib/rpc-error'
import { stripVisibleScreen, visibleLineCount } from './lib/scrollback'
import { loadHistoryLines, loadPushEnabled, saveHistoryLines, savePushEnabled } from './lib/settings'
```

**(b) state 整理** — old:

```ts
  const [termContent, setTermContent] = useState('')
  const [termGrid, setTermGrid] = useState<RenderGrid | null>(null)
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  // 履歴(スクロールバック)モードと、表示中内容の取得時刻(オフライン保持の鮮度表示用)。
  const [historyMode, setHistoryMode] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
```

new:

```ts
  // グリッドの上へ常時併記するスクロールバック(履歴・seam 除去済み)と、
  // 表示中内容の取得時刻(オフライン保持の鮮度表示用)。
  const [termHistory, setTermHistory] = useState('')
  const [termGrid, setTermGrid] = useState<RenderGrid | null>(null)
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
```

**(c) ref 追加** — `staleResyncRef` の宣言（`const staleResyncRef = useRef<string | null>(null)`）の直後に挿入:

```ts
  // 最下部ピン留め(Terminal から通知)。ピン留め中のみ scrollback を取得する＝上へ遡って
  // 読んでいる間はフェッチ自体を止めて表示据え置き(読んでいる行が流れない)＋帯域節約。
  const pinnedRef = useRef(true)
  const onPinnedChange = useCallback((pinned: boolean) => {
    pinnedRef.current = pinned
  }, [])
  // localStorage への scrollback 書込を「内容が変わった時のみ」にするための前回値
  // (毎秒 200KB 級の JSON 書込によるジャンク防止)。
  const lastScrollbackRef = useRef<string | null>(null)
```

**(d) ハイドレート effect 置換** — old（「Surface 切替時はまずキャッシュから…」の effect 全体）:

```ts
  // Surface 切替時はまずキャッシュから即座にハイドレートし、切断/リロード直後でも
  // 「直前までの履歴」を空白にせず表示する。ライブポーリングが繋がれば上書きされる。
  // タブを切り替えたら履歴モードはライブへ戻す。
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

new:

```ts
  // Surface 切替時はまずキャッシュから即座にハイドレートし、切断/リロード直後でも
  // 「直前までの履歴」を空白にせず表示する。ライブポーリングが繋がれば上書きされる。
  // 切替時はピン留め(最下部＝最新)へ戻す。grid があるキャッシュは scrollback から画面ぶんを
  // 削って併記用の履歴に、grid が無ければ(停止端末/旧キャッシュ) scrollback→text を全文表示する。
  useEffect(() => {
    pinnedRef.current = true
    lastScrollbackRef.current = null
    if (!currentSurface) {
      setTermGrid(null)
      setTermHistory('')
      setLastUpdated(null)
      return
    }
    const cached = loadSurfaceScreen(currentSurface)
    const grid = cached?.grid ?? null
    setTermGrid(grid)
    setTermHistory(
      grid
        ? stripVisibleScreen(cached?.scrollback ?? '', visibleLineCount(grid))
        : (cached?.scrollback ?? cached?.text ?? ''),
    )
    setLastUpdated(cached?.updatedAt ?? null)
  }, [currentSurface])
```

**(e) ポーリング effect 統合** — old のガード行:

```ts
    if (status !== 'connected' || !currentSurface || isBrowserSurface || historyMode) {
```

new:

```ts
    if (status !== 'connected' || !currentSurface || isBrowserSurface) {
```

old の poll 本体 try ブロック:

```ts
      try {
        const grid = await readGrid(currentSurface)
        if (cancelled) return
        setTermGrid(grid)
        const now = Date.now()
        setLastUpdated(now)
        // オフライン保持用に最後のグリッドを永続化（text/scrollback は引き継がれる）。
        // 停止端末で grid が null のときは undefined を渡し、直近の正常グリッドを潰さず引き継ぐ。
        saveSurfaceScreen(currentSurface, { grid: grid ?? undefined, updatedAt: now })
        staleResyncRef.current = null
      } catch (err) {
```

new:

```ts
      try {
        const grid = await readGrid(currentSurface)
        if (cancelled) return
        setTermGrid(grid)
        const now = Date.now()
        setLastUpdated(now)
        // オフライン保持用に最後のグリッドを永続化（text/scrollback は引き継がれる）。
        // 停止端末で grid が null のときは undefined を渡し、直近の正常グリッドを潰さず引き継ぐ。
        saveSurfaceScreen(currentSurface, { grid: grid ?? undefined, updatedAt: now })
        staleResyncRef.current = null

        // スクロールバック(履歴)は最下部ピン留め中のみ取得する。上へ遡って読んでいる間は
        // フェッチ自体をスキップ＝<pre> の内容が凍結され、読んでいる行が流れない(最下部復帰で
        // 次ポーリングが追いつく)。alternate screen(TUI)にスクロールバックの概念はなく、停止端末
        // (grid なし)は read_text 自体が失敗するため、いずれも取得しない。seam の削りは
        // 「同ポーリングの grid」で行う(レンダー時に削り直すと凍結中の表示が動いてしまう)。
        if (pinnedRef.current && grid && grid.active_screen !== 'alternate') {
          const text = await readText(currentSurface, { scrollback: true, lines: historyLines })
          if (cancelled) return
          setTermHistory(stripVisibleScreen(text, visibleLineCount(grid)))
          if (text !== lastScrollbackRef.current) {
            lastScrollbackRef.current = text
            saveSurfaceScreen(currentSurface, { scrollback: text, updatedAt: now })
          }
        }
      } catch (err) {
```

old の effect 依存配列:

```ts
  }, [status, currentSurface, currentWorkspace, isBrowserSurface, historyMode, readGrid, listSurfaces])
```

new:

```ts
  }, [status, currentSurface, currentWorkspace, isBrowserSurface, historyLines, readGrid, readText, listSurfaces])
```

**(f) 履歴モード effect を削除** — 以下のブロック全体（コメント含む）を削除:

```ts
  // 履歴モード: スクロールバックを 1 回取得して固定表示。取得分はオフライン閲覧用に
  // キャッシュする。切断中は取得済みキャッシュ(scrollback→text)へフォールバックする。
  useEffect(() => {
    if (!historyMode || !currentSurface) return

    if (status !== 'connected') {
      const cached = loadSurfaceScreen(currentSurface)
      if (cached) {
        setTermContent(cached.scrollback ?? cached.text ?? '')
        setLastUpdated(cached.updatedAt)
      }
      return
    }

    let cancelled = false
    readText(currentSurface, { scrollback: true, lines: historyLines })
      .then((text) => {
        if (cancelled) return
        setTermContent(text)
        const now = Date.now()
        setLastUpdated(now)
        saveSurfaceScreen(currentSurface, { text, scrollback: text, updatedAt: now })
      })
      .catch((err) => console.error('[app] History fetch error:', err))

    return () => {
      cancelled = true
    }
  }, [historyMode, currentSurface, status, readText, historyLines])
```

**(g) マウスモード導出と enter/exit の削除** — old:

```ts
  // Mouse mode (from the live grid's DECSET modes) gates tap/click forwarding.
  // History mode shows static text, so treat it as no live grid (mouse off).
  const mouseMode = deriveMouseMode(historyMode ? null : termGrid)
  // 方向キーの \x1b[ / \x1bO 出し分け用（DECCKM）。履歴モードはライブグリッド無し扱い。
  const appCursor = isAppCursorMode(historyMode ? null : termGrid)
```

new:

```ts
  // Mouse mode (from the live grid's DECSET modes) gates tap/click forwarding.
  const mouseMode = deriveMouseMode(termGrid)
  // 方向キーの \x1b[ / \x1bO 出し分け用（DECCKM）。
  const appCursor = isAppCursorMode(termGrid)
```

old:

```ts
  // ライブ上端での上スクロールで遡り（履歴）へ、遡り後の最下部復帰でライブへ。Terminal から呼ばれる。
  const enterHistory = useCallback(() => setHistoryMode(true), [])
  const exitHistory = useCallback(() => setHistoryMode(false), [])
```

new: （ブロックごと削除）

**(h) Header から historyMode を外す** — old:

```ts
          status={status}
          lastUpdated={lastUpdated}
          historyMode={historyMode}
          onOpenSettings={() => setSettingsOpen(true)}
```

new:

```ts
          status={status}
          lastUpdated={lastUpdated}
          onOpenSettings={() => setSettingsOpen(true)}
```

**(i) Terminal JSX 置換** — old:

```tsx
            <Terminal
              grid={historyMode ? null : termGrid}
              content={termContent}
              fontSize={fontSize}
              mouseEnabled={mouseMode.mouseEnabled}
              useSgr={mouseMode.useSgr}
              onSendMouse={(text) => {
                if (currentSurface)
                  sendText(currentSurface, text).catch((err) => console.error('[app] mouse error:', err))
              }}
              onAdjustFontSize={adjustFontSize}
              onEnterHistory={enterHistory}
              onExitHistory={exitHistory}
            />
```

new:

```tsx
            <Terminal
              grid={termGrid}
              // alternate screen(TUI) 中は履歴を出さない(スクロールバックの概念がなく、上に
              // primary の履歴が見えると混乱する)。state は保持し primary 復帰で即再表示する。
              scrollback={termGrid?.active_screen === 'alternate' ? '' : termHistory}
              fontSize={fontSize}
              mouseEnabled={mouseMode.mouseEnabled}
              useSgr={mouseMode.useSgr}
              onSendMouse={(text) => {
                if (currentSurface)
                  sendText(currentSurface, text).catch((err) => console.error('[app] mouse error:', err))
              }}
              onAdjustFontSize={adjustFontSize}
              onPinnedChange={onPinnedChange}
              resetKey={currentSurface}
            />
```

- [ ] **Step 6: 全テスト＋check を通す**

Run: `pnpm check && pnpm test`
Expected: check PASS。test はクライアント側で `scroll-intent.test.ts` 含め全 PASS（`isOverscrollUp` は Task 3 まで残っているため）。サーバーテストも PASS（変更なし）。

- [ ] **Step 7: コミット**

```bash
git add apps/client/src/components/Terminal.tsx apps/client/src/components/__tests__/Terminal.test.tsx apps/client/src/App.tsx
git commit -m "feat(client): 履歴モードを廃止しスクロールバック常時併記のモードレス表示へ"
```

---

### Task 3: `scroll-intent.ts` から `isOverscrollUp` を削除

**Files:**
- Modify: `apps/client/src/lib/scroll-intent.ts`
- Test: `apps/client/src/lib/__tests__/scroll-intent.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `isAtBottom(args: { scrollTop: number; clientHeight: number; scrollHeight: number; epsilon?: number }): boolean` のみ（シグネチャ不変。Terminal が使用中）

- [ ] **Step 1: テストから isOverscrollUp を削除**

`apps/client/src/lib/__tests__/scroll-intent.test.ts` を以下の内容で置き換え:

```ts
import { describe, expect, it } from 'vitest'

import { isAtBottom } from '../scroll-intent'

describe('isAtBottom', () => {
  it('最下部 → true', () => {
    expect(isAtBottom({ scrollTop: 980, clientHeight: 20, scrollHeight: 1000 })).toBe(true)
  })
  it('途中 → false', () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 20, scrollHeight: 1000 })).toBe(false)
  })
  it('epsilon 以内は最下部扱い', () => {
    expect(isAtBottom({ scrollTop: 979, clientHeight: 20, scrollHeight: 1000, epsilon: 2 })).toBe(true)
  })
  it('epsilon を狭めると同じ位置でも最下部扱いにならない', () => {
    expect(isAtBottom({ scrollTop: 979, clientHeight: 20, scrollHeight: 1000, epsilon: 0 })).toBe(false)
  })
  it('epsilon 省略時はデフォルト 2 が使われる', () => {
    expect(isAtBottom({ scrollTop: 978, clientHeight: 20, scrollHeight: 1000 })).toBe(true)
  })
})
```

- [ ] **Step 2: 実装から isOverscrollUp を削除**

`apps/client/src/lib/scroll-intent.ts` を以下の内容で置き換え:

```ts
// スクロール位置の純粋判定。DOM から数値を渡して判定だけ行う（副作用なし＝単体テスト可能）。

const DEFAULT_BOTTOM_EPSILON = 2

// スクロール位置が最下部（誤差 epsilon 内）に達しているか。ピン留め（末尾追従）判定に使う。
export function isAtBottom(args: {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  epsilon?: number
}): boolean {
  const { scrollTop, clientHeight, scrollHeight, epsilon = DEFAULT_BOTTOM_EPSILON } = args
  return scrollHeight - (scrollTop + clientHeight) <= epsilon
}
```

- [ ] **Step 3: テスト＋check を通す**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/scroll-intent.test.ts && cd ../.. && pnpm check`
Expected: PASS（5 tests）、check PASS（他に `isOverscrollUp` の参照が残っていればここで型エラーになる）

- [ ] **Step 4: コミット**

```bash
git add apps/client/src/lib/scroll-intent.ts apps/client/src/lib/__tests__/scroll-intent.test.ts
git commit -m "refactor(client): 不要になった isOverscrollUp(遡り進入判定) を削除"
```

---

### Task 4: Header / ConnectionIndicator から historyMode を削除

**Files:**
- Modify: `apps/client/src/components/Header.tsx`
- Modify: `apps/client/src/components/ConnectionIndicator.tsx`

**Interfaces:**
- Consumes: なし（App は Task 2 で既に `historyMode` を渡していない。prop がオプショナルのため型は通っている）
- Produces: `Header` props から `historyMode?: boolean` を削除。`ConnectionIndicator` props から `historyMode?: boolean` を削除（オフライン鮮度表示 `lastUpdated` は不変）

- [ ] **Step 1: ConnectionIndicator から履歴表示を削除**

`apps/client/src/components/ConnectionIndicator.tsx` に以下の編集を適用:

props interface — old:

```ts
interface ConnectionIndicatorProps {
  status: ConnectionStatus
  // 表示中の内容が取得された時刻(epoch ms)。切断/履歴モード時に「いつの内容か」を示す。
  lastUpdated?: number | null
  historyMode?: boolean
}
```

new:

```ts
interface ConnectionIndicatorProps {
  status: ConnectionStatus
  // 表示中の内容が取得された時刻(epoch ms)。切断中に「いつの内容か」を示す。
  lastUpdated?: number | null
}
```

コンポーネント宣言 — old:

```tsx
// 接続状態（ドット＋ラベル）とオフライン/履歴の鮮度表示。Header の右側に置く。
export function ConnectionIndicator({ status, lastUpdated, historyMode }: ConnectionIndicatorProps) {
```

new:

```tsx
// 接続状態（ドット＋ラベル）とオフラインの鮮度表示。Header の右側に置く。
export function ConnectionIndicator({ status, lastUpdated }: ConnectionIndicatorProps) {
```

notice 導出 — old:

```ts
  // 切断中（オフライン保持）や履歴モードでは、表示内容がいつ時点のものかを明示する。
  let notice: string | null = null
  if (historyMode) {
    notice = lastUpdated ? `履歴 · ${formatClock(lastUpdated)}時点` : '履歴'
  } else if (shownStatus !== 'connected' && lastUpdated) {
    notice = `オフライン · 最終 ${formatClock(lastUpdated)}`
  }
```

new:

```ts
  // 切断中（オフライン保持）は、表示内容がいつ時点のものかを明示する。
  let notice: string | null = null
  if (shownStatus !== 'connected' && lastUpdated) {
    notice = `オフライン · 最終 ${formatClock(lastUpdated)}`
  }
```

notice 描画 — old:

```tsx
      {notice && <span style={{ color: historyMode ? 'var(--color-accent)' : 'var(--color-warning)' }}>{notice}</span>}
```

new:

```tsx
      {notice && <span style={{ color: 'var(--color-warning)' }}>{notice}</span>}
```

- [ ] **Step 2: Header から historyMode を削除**

`apps/client/src/components/Header.tsx` に以下の編集を適用:

props interface — old:

```ts
  status: ConnectionStatus
  lastUpdated?: number | null
  historyMode?: boolean
  onOpenSettings: () => void
```

new:

```ts
  status: ConnectionStatus
  lastUpdated?: number | null
  onOpenSettings: () => void
```

destructure — old:

```ts
export function Header({
  workspaceName,
  onMenuToggle,
  showMenuButton = true,
  status,
  lastUpdated,
  historyMode,
  onOpenSettings,
}: HeaderProps) {
```

new:

```ts
export function Header({
  workspaceName,
  onMenuToggle,
  showMenuButton = true,
  status,
  lastUpdated,
  onOpenSettings,
}: HeaderProps) {
```

pass-through — old:

```tsx
        <ConnectionIndicator status={status} lastUpdated={lastUpdated} historyMode={historyMode} />
```

new:

```tsx
        <ConnectionIndicator status={status} lastUpdated={lastUpdated} />
```

- [ ] **Step 3: check＋テストを通す**

Run: `pnpm check && pnpm test`
Expected: すべて PASS

- [ ] **Step 4: コミット**

```bash
git add apps/client/src/components/Header.tsx apps/client/src/components/ConnectionIndicator.tsx
git commit -m "refactor(client): Header/ConnectionIndicator から履歴モード表示を削除"
```

---

### Task 5: SettingsModal / settings.ts の文言をモードレスに合わせる

**Files:**
- Modify: `apps/client/src/components/SettingsModal.tsx`
- Modify: `apps/client/src/lib/settings.ts`

**Interfaces:**
- Consumes / Produces: なし（表示文言とコメントのみ。props/関数シグネチャ不変）

- [ ] **Step 1: SettingsModal の説明文を更新**

old:

```tsx
          <div style={{ fontSize: 12, color: 'var(--color-text-subtle)', marginTop: 6 }}>
            {HISTORY_LINES_MIN.toLocaleString()}〜{HISTORY_LINES_MAX.toLocaleString()} 行（履歴モードで取得する
            スクロールバック行数。大きいほど重くなります）
          </div>
```

new:

```tsx
          <div style={{ fontSize: 12, color: 'var(--color-text-subtle)', marginTop: 6 }}>
            {HISTORY_LINES_MIN.toLocaleString()}〜{HISTORY_LINES_MAX.toLocaleString()} 行（ライブ表示で上へ
            遡れるスクロールバック行数。大きいほど重くなります）
          </div>
```

- [ ] **Step 2: settings.ts の先頭コメントを更新**

old:

```ts
// 履歴(スクロールバック)で取得する行数の設定。localStorage に永続化する。値は readText の
// scrollback lines に渡る。多すぎると取得/描画が重くなるため下限・上限でクランプする。
```

new:

```ts
// ライブ表示で上へ遡れるスクロールバック行数の設定。localStorage に永続化する。値は毎秒
// ポーリングの readText scrollback lines に渡る。多すぎると取得/描画が重くなるためクランプする。
```

- [ ] **Step 3: check＋テストを通す**

Run: `pnpm check && pnpm test`
Expected: すべて PASS（SettingsModal.test.tsx は文言をアサートしていないことを確認済み）

- [ ] **Step 4: コミット**

```bash
git add apps/client/src/components/SettingsModal.tsx apps/client/src/lib/settings.ts
git commit -m "docs(client): 履歴バッファ設定の説明をモードレス表示に合わせて更新"
```

---

### Task 6: CLAUDE.md 更新＋全体検証＋手動確認

**Files:**
- Modify: `CLAUDE.md`（リポジトリルート）

**Interfaces:**
- Consumes: Task 1〜5 の完成状態
- Produces: なし（ドキュメントと検証）

- [ ] **Step 1: CLAUDE.md の Terminal.tsx 記述を更新**

`CLAUDE.md` の `components/Terminal.tsx` の項の中で、以下の文（1 文単位で完全一致置換）を書き換える。

old:

```
**ライブ表示は上端でさらに上スクロール（wheel／一本指の下方向ドラッグ。`mouseEnabled` の TUI では横取りしない）すると履歴（スクロールバック）へ入り（`onEnterHistory`）、遡った後に最下部へ戻ると自動でライブへ復帰する（`onExitHistory`）。** 復帰は capture 段の `scroll` 監視で「一度上へ離れてから最下部へ戻った時のみ」発火させ、進入直後の末尾追従での即バウンドを防ぐ。**別モード／「履歴」ボタンは廃止し、スクロール位置で `historyMode` をトグルする**（履歴中は `grid=null` でプレーンテキスト＝色なし・更新停止）。
```

new:

```
**履歴モードは廃止（モードレス）。同一スクロールコンテナに「スクロールバック `<pre>`（プレーン・色なし）＋色付きライブグリッド」を常時縦積みし、上へのネイティブスクロールだけで過去へ遡れる。** 最下部ピン留め（capture 段の `scroll` 監視で `isAtBottom`、`onPinnedChange` で App へ通知）中のみ App が `read_text(scrollback, lines=historyLines)` を毎秒取得して `<pre>` を更新し末尾へ追従。上へ遡っている間はフェッチ自体をスキップして表示据え置き（読んでいる行が流れない）、最下部復帰で次ポーリング（≤1秒）が追いつく。scrollback は末尾に可視画面を含むため `lib/scrollback.ts`（`visibleLineCount`＝grid の最終非空行+1、`stripVisibleScreen`。**`grid.rows` で削ると下部が空の端末で履歴を削りすぎる**）で画面ぶんを削って二重表示を防ぐ。`active_screen='alternate'`（TUI）中は `<pre>` 非表示＋フェッチ停止。サーフェス切替は `resetKey` でピン留めへリセット。タップ→セル座標変換は `<pre>` が上に積まれるため wrapper でなく `.wterm` の rect 基準。
```

old:

```
**プレーンテキスト（履歴/オフライン）は wterm に書かず `<pre>`（同フォント・行高 1.2・`width:max-content`）へ全行直描画し、wterm は `display:none` で隠して wrapper のネイティブスクロールに任せる** — wterm の WASM コアはスクロールバックを **1000 行でハードコード頭打ち**（変更 API なし）にするため、wterm に流すと設定の履歴バッファ（`historyLines`）を 1000 超に上げても遡れる範囲が変わらない。進入時・履歴到着時は wrapper を最下部（最新）へ自前スクロールする（`hasScrolledUp` をリセットし強制スクロールでの即ライブ復帰を防ぐ）。
```

new:

```
**プレーンテキスト（スクロールバック/オフライン）は wterm に書かず `<pre>`（同フォント・行高 1.2・`width:max-content`）へ全行直描画する（grid が無いときは wterm を `display:none`）** — wterm の WASM コアはスクロールバックを **1000 行でハードコード頭打ち**（変更 API なし）にするため、wterm に流すと設定の履歴バッファ（`historyLines`）を 1000 超に上げても遡れる範囲が変わらない。
```

old:

```
純粋ロジックは `lib/multitouch.ts`（`centroid`/`isTap`）・`lib/sgr-mouse.ts`（`encodeClick`）・`lib/terminal-coords.ts`（座標変換）・`lib/mouse-mode.ts`（`modes` 判定）・`lib/terminal-keys.ts`（特殊キー→生シーケンス）・`lib/scroll-intent.ts`（`isOverscrollUp`/`isAtBottom`＝遡り進入/復帰判定）に分離。
```

new:

```
純粋ロジックは `lib/multitouch.ts`（`centroid`/`isTap`）・`lib/sgr-mouse.ts`（`encodeClick`）・`lib/terminal-coords.ts`（座標変換）・`lib/mouse-mode.ts`（`modes` 判定）・`lib/terminal-keys.ts`（特殊キー→生シーケンス）・`lib/scroll-intent.ts`（`isAtBottom`＝ピン留め判定）・`lib/scrollback.ts`（`visibleLineCount`/`stripVisibleScreen`＝seam 除去）に分離。
```

- [ ] **Step 2: CLAUDE.md の ConnectionIndicator / SettingsModal 記述を更新**

old:

```
接続状態（ドット＋ラベル、`connected→切断` のみ 2 秒猶予でチラつき防止）とオフライン/履歴の鮮度表示（「最終 HH:MM」/「履歴 · HH:MM時点」）を `ConnectionIndicator` に抽出（`historyMode` を受け取り表示）。**「履歴」ボタンは廃止**し、遡り（履歴）はライブ上端での上スクロールで自動進入する（`Terminal.tsx` が検知）。
```

new:

```
接続状態（ドット＋ラベル、`connected→切断` のみ 2 秒猶予でチラつき防止）とオフラインの鮮度表示（「オフライン · 最終 HH:MM」）を `ConnectionIndicator` に抽出。履歴の別表示は廃止（遡りはモードレスで常時可能、`Terminal.tsx` 参照）。
```

old:

```
履歴行数は `localStorage`(`cmux:history-lines`) に永続し、App のライブ遡り取得 `readText(..., { scrollback: true, lines })` に渡る＝**ライブで上スクロールして遡れる行数**。
```

new:

```
履歴行数は `localStorage`(`cmux:history-lines`) に永続し、App の毎秒ポーリング（最下部ピン留め中のみ）の `readText(..., { scrollback: true, lines })` に渡る＝**ライブ表示で上へ遡れる行数**。
```

- [ ] **Step 3: 全体検証**

Run: `pnpm check && pnpm test && pnpm build`
Expected: すべて PASS

- [ ] **Step 4: 手動確認（実機）**

`pnpm dev` を起動し、ブラウザ（可能なら iPhone Safari/PWA も）で <http://localhost:5173> を開いて確認:

1. 最下部でライブ追従（色付き）。出力が流れると自動で末尾に追従する。
2. そのまま上スクロールで `<pre>` の履歴へ**切替感なく連続的に**遡れる（慣性維持・モード表示なし）。
3. 遡り読取中に別途出力を流し（例: 対象端末で `seq 1 100`）、読んでいる行が**流れない**こと。
4. 最下部へ戻ると ≤1 秒で最新に追いつくこと。
5. seam（`<pre>` 末尾とグリッド先頭）に行の重複・欠落がないこと（`seq 1 50` などの連番で目視確認）。
6. 設定モーダルの履歴行数を変えると遡れる範囲が変わること。
7. nvim / lazygit（alternate screen）では履歴が出ず、タップ→クリックが従来どおり効くこと。
8. 全角・長行での横スクロール、ピンチでのフォント増減が従来どおり動くこと。
9. タブ（サーフェス）切替で最下部（最新）から始まること。

- [ ] **Step 5: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md をモードレス・スクロールバック表示に追随"
```

- [ ] **Step 6: 仕上げ**

すべて完了したら superpowers:finishing-a-development-branch スキルで main への統合方法（merge / PR）をユーザーに確認する。
