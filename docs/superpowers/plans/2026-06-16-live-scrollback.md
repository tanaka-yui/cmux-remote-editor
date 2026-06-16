# ライブ表示のスクロールバック統合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ライブ表示のまま上スクロールで過去（スクロールバック）を遡れるようにし、別モードの「履歴」ボタンを廃止して 1 つのスクロール操作に統合する。

**Architecture:** 既存の `historyMode` state とデータ経路（`readGrid` ポーリング／`readText` scrollback 取得）をそのまま流用し、トグルの起点を「ボタン」→「スクロール位置」に置換する。ライブ上端での上方向オーバースクロールで遡りへ入り（`historyMode=true`：プレーンテキスト・更新停止）、上へ遡った後に最下部へ戻るとライブ更新を再開する（`historyMode=false`）。スクロール意図の判定は純粋関数 `lib/scroll-intent.ts` に分離して単体テストする。

**Tech Stack:** React 19 / TypeScript / Vite / `@wterm/react` / vitest / Biome

設計書: `docs/superpowers/specs/2026-06-16-live-scrollback-design.md`

---

## File Structure

| ファイル | 責務 | 区分 |
|---|---|---|
| `apps/client/src/lib/scroll-intent.ts` | スクロール意図の純粋判定（`isOverscrollUp` / `isAtBottom`） | 新規 |
| `apps/client/src/lib/__tests__/scroll-intent.test.ts` | 上記の単体テスト | 新規 |
| `apps/client/src/components/Terminal.tsx` | wheel/touch から進入検知・scroll から復帰検知 → `onEnterHistory`/`onExitHistory` 発火 | 変更 |
| `apps/client/src/App.tsx` | `onEnterHistory`/`onExitHistory` を Terminal へ。Header への `onToggleHistory` 受け渡しを削除 | 変更 |
| `apps/client/src/components/Header.tsx` | 「履歴」ボタンと `onToggleHistory` prop を削除（`historyMode` は鮮度表示用に維持） | 変更 |
| `CLAUDE.md` | 履歴ボタン廃止・スクロール遡りの記述に更新 | 変更 |

---

## Task 1: 作業ツリーの整理（土台コミット）

現在の作業ツリーには (A) 別セッションで完了済みの stale-surface 自動復帰の変更と、(B) 本対応で先に当てた「履歴モードのスクロール不能バグ修正」（`Terminal.tsx`）が未コミットで混在している。`App.tsx` をこの後さらに編集するため、まず両者を別コミットに分離して土台を整える。

> 注: (A) は別作業の成果物。内容に問題があれば、ここで止めてユーザーに確認すること。

**Files:**
- Commit A（既存変更）: `apps/client/src/App.tsx`, `apps/client/src/hooks/useCmux.ts`, `apps/client/src/hooks/__tests__/useCmux.test.ts`, `apps/client/src/main.tsx`, `apps/client/src/components/ErrorBoundary.tsx`, `apps/client/src/lib/rpc-error.ts`, `apps/client/src/lib/__tests__/rpc-error.test.ts`
- Commit B（バグ修正）: `apps/client/src/components/Terminal.tsx`

- [ ] **Step 1: 現状確認**

Run: `cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor && git status --short && git branch --show-current`
Expected: ブランチ `feat/live-scrollback`、上記ファイル群が `M`/`??` で表示される。

- [ ] **Step 2: チェックが通ることを確認**

Run: `cd apps/client && pnpm exec tsc --noEmit && cd ../.. && pnpm exec biome check apps/client/src`
Expected: 型エラー無し、biome OK。

- [ ] **Step 3: stale-surface 復帰（A）をコミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor
git add apps/client/src/App.tsx apps/client/src/hooks/useCmux.ts apps/client/src/hooks/__tests__/useCmux.test.ts apps/client/src/main.tsx apps/client/src/components/ErrorBoundary.tsx apps/client/src/lib/rpc-error.ts apps/client/src/lib/__tests__/rpc-error.test.ts
git commit -m "feat(client): 閉じた surface の terminal.replay エラーを自動復帰（RPC エラーコード伝播 + ErrorBoundary）"
```

- [ ] **Step 4: 履歴スクロール修正（B）をコミット**

```bash
git add apps/client/src/components/Terminal.tsx
git commit -m "fix(client): 履歴モードでスクロールできない問題を解消（.wterm を viewport 高に固定し wterm の scrollback で縦スクロール）"
```

- [ ] **Step 5: ツリーが clean になったことを確認**

Run: `git status --short`
Expected: 出力なし（clean）。

---

## Task 2: `lib/scroll-intent.ts`（スクロール意図の純粋判定）

**Files:**
- Create: `apps/client/src/lib/scroll-intent.ts`
- Test: `apps/client/src/lib/__tests__/scroll-intent.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/scroll-intent.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { isAtBottom, isOverscrollUp } from '../scroll-intent'

describe('isOverscrollUp', () => {
  it('上端で過去方向(負)に閾値超え → true', () => {
    expect(isOverscrollUp({ scrollTop: 0, deltaY: -20, threshold: 8 })).toBe(true)
  })
  it('上端でも下方向(正)は false', () => {
    expect(isOverscrollUp({ scrollTop: 0, deltaY: 20, threshold: 8 })).toBe(false)
  })
  it('上端でも閾値未満は false', () => {
    expect(isOverscrollUp({ scrollTop: 0, deltaY: -3, threshold: 8 })).toBe(false)
  })
  it('上端でない(scrollTop>atTopEpsilon)なら過去方向でも false', () => {
    expect(isOverscrollUp({ scrollTop: 50, deltaY: -20, threshold: 8 })).toBe(false)
  })
  it('atTopEpsilon 以内は上端扱い', () => {
    expect(isOverscrollUp({ scrollTop: 1, deltaY: -20, threshold: 8, atTopEpsilon: 1 })).toBe(true)
  })
})

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
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/scroll-intent.test.ts`
Expected: FAIL（`scroll-intent` が未作成のため import 解決エラー）。

- [ ] **Step 3: 実装を書く**

`apps/client/src/lib/scroll-intent.ts`:

```ts
// スクロール意図の純粋判定。DOM/タッチから数値を渡して判定だけ行う（副作用なし＝単体テスト可能）。
// deltaY の符号規約: 過去を見る方向（上スクロール／遡り）を負とする。
//   wheel: e.deltaY をそのまま（上スクロール時に負）。
//   touch: 指が下へ動く＝上端のコンテンツが出る＝遡り。startY - currentY を渡す（指が下=負）。

const DEFAULT_TOP_EPSILON = 1
const DEFAULT_BOTTOM_EPSILON = 2

// 上端でさらに過去方向（負）へ閾値を超えて動かそうとしたか。
export function isOverscrollUp(args: {
  scrollTop: number
  deltaY: number
  threshold: number
  atTopEpsilon?: number
}): boolean {
  const { scrollTop, deltaY, threshold, atTopEpsilon = DEFAULT_TOP_EPSILON } = args
  return scrollTop <= atTopEpsilon && deltaY <= -threshold
}

// スクロール位置が最下部（誤差 epsilon 内）に達しているか。
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

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/scroll-intent.test.ts`
Expected: PASS（8 件）。

- [ ] **Step 5: コミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor
git add apps/client/src/lib/scroll-intent.ts apps/client/src/lib/__tests__/scroll-intent.test.ts
git commit -m "feat(client): スクロール意図判定 scroll-intent を追加（isOverscrollUp / isAtBottom）"
```

---

## Task 3: `Terminal.tsx`（進入／復帰の検知）

ライブ（`grid !== null`）では wheel/touch の「上端での過去方向オーバースクロール」で `onEnterHistory` を発火。遡り（`grid === null`）では capture 段の `scroll` リスナで「一度上へ離れてから最下部復帰」を検知し `onExitHistory` を発火。ライブ色付き描画ロジック自体は無変更。TUI（`mouseEnabled`）ではドラッグを横取りしないよう進入を抑止する。

**Files:**
- Modify: `apps/client/src/components/Terminal.tsx`

- [ ] **Step 1: import に scroll-intent と WheelEvent 型を追加**

先頭の import 群（`import { cellSize, pixelToCell } from '../lib/terminal-coords'` の直後）に追加し、react の型 import に `WheelEvent` を加える。

変更前（2 行目と 8 行目付近）:
```ts
import type { CSSProperties, TouchEvent as ReactTouchEvent } from 'react'
...
import { cellSize, pixelToCell } from '../lib/terminal-coords'
```
変更後:
```ts
import type { CSSProperties, TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from 'react'
...
import { cellSize, pixelToCell } from '../lib/terminal-coords'
import { isAtBottom, isOverscrollUp } from '../lib/scroll-intent'
```

- [ ] **Step 2: props 型とコンポーネント引数に進入/復帰ハンドラを追加**

`interface TerminalProps` の末尾（`onAdjustFontSize: (delta: number) => void` の後）に追加:
```ts
  // ライブ上端での上方向オーバースクロールで遡り（履歴）へ入る。
  onEnterHistory: () => void
  // 遡り中、上へ遡った後に最下部へ戻ったらライブへ復帰する。
  onExitHistory: () => void
```

コンポーネント引数の分割代入（`onAdjustFontSize,` の後）に追加:
```ts
  onEnterHistory,
  onExitHistory,
```

- [ ] **Step 3: 進入/復帰の閾値定数を追加**

`const PINCH_STEP_PX = 32` の直後に追加:
```ts
// ライブ上端での「過去方向オーバースクロール」で遡りへ入る閾値。wheel は deltaY(px 相当)、
// touch はジェスチャー開始からの指の下方向移動量(px)。
const WHEEL_ENTER_THRESHOLD = 8
const TOUCH_ENTER_THRESHOLD = 48
```

- [ ] **Step 4: touchmove の単指分岐に進入検知を追加**

`onTouchMove` 内の単指分岐を以下に置換する。

変更前:
```ts
      if (state.kind === 'single') {
        // 一本指の縦横スクロールはブラウザのネイティブに任せる（preventDefault しないので慣性が残る）。
        // 閾値を超えて動いたらタップではなくスクロールと判定する。
        if (a && !isTap(a.clientX - state.startX, a.clientY - state.startY)) state.moved = true
        return
      }
```
変更後:
```ts
      if (state.kind === 'single') {
        // 一本指の縦横スクロールはブラウザのネイティブに任せる（preventDefault しないので慣性が残る）。
        // 閾値を超えて動いたらタップではなくスクロールと判定する。
        if (a && !isTap(a.clientX - state.startX, a.clientY - state.startY)) state.moved = true
        // ライブ中（TUI でマウス取得中は横取りしない）、上端で下方向ドラッグ（=過去を遡る方向）が閾値を
        // 超えたら遡りへ。deltaY は startY - 現在Y（指が下に動く=負）。
        if (a && useGrid && !mouseEnabled) {
          const el = wrapperRef.current
          if (el && isOverscrollUp({ scrollTop: el.scrollTop, deltaY: state.startY - a.clientY, threshold: TOUCH_ENTER_THRESHOLD })) {
            onEnterHistory()
          }
        }
        return
      }
```

`onTouchMove` の依存配列を更新。

変更前:
```ts
    [onAdjustFontSize],
  )
```
変更後:
```ts
    [onAdjustFontSize, useGrid, mouseEnabled, onEnterHistory],
  )
```

> 注: `useGrid` は本体内で `const useGrid = grid !== null`（既存）として定義済み。`onTouchMove` は `useGrid` 定義より後方にあるためクロージャで参照可能。

- [ ] **Step 5: wheel ハンドラ（デスクトップの進入検知）を追加**

`onTouchCancel` の定義直後に追加:
```ts
  // デスクトップ: ライブ上端での上方向ホイールで遡りへ。
  const onWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      if (!useGrid || mouseEnabled) return
      const el = wrapperRef.current
      if (el && isOverscrollUp({ scrollTop: el.scrollTop, deltaY: e.deltaY, threshold: WHEEL_ENTER_THRESHOLD })) {
        onEnterHistory()
      }
    },
    [useGrid, mouseEnabled, onEnterHistory],
  )
```

- [ ] **Step 6: 復帰検知（capture 段の scroll リスナ）を追加**

`measure` 関連の `useEffect` 群の後（`useGrid` 定義より前後どちらでもよいが、`useGrid` を参照するので定義後）に追加する。`const useGrid = grid !== null` の直後に置く:
```ts
  // 遡り（grid なし）中の「最下部復帰 → ライブ再開」検知。進入直後は wterm が末尾へ自動追従して
  // 最下部にいるため、一度上へ離れて（hasScrolledUp）から最下部へ戻った時のみ発火させ即バウンドを防ぐ。
  // scroll は bubble しないが capture 段なら子（.wterm）の scroll も拾える。実際にスクロールする要素
  //（.wterm が height:100%+has-scrollback のときは .wterm、伸びた場合は wrapper）の双方に対応できる。
  const hasScrolledUpRef = useRef(false)
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (useGrid || !wrapper) {
      hasScrolledUpRef.current = false
      return
    }
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null
      if (!el || typeof el.scrollTop !== 'number') return
      const atBottom = isAtBottom({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight })
      if (!atBottom) hasScrolledUpRef.current = true
      else if (hasScrolledUpRef.current) onExitHistory()
    }
    wrapper.addEventListener('scroll', onScroll, true)
    return () => wrapper.removeEventListener('scroll', onScroll, true)
  }, [useGrid, onExitHistory])
```

- [ ] **Step 7: wrapper に onWheel を配線**

`return` 内の wrapper `<div>` の `onTouchCancel={onTouchCancel}` の後に `onWheel={onWheel}` を追加:

変更前:
```tsx
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
```
変更後:
```tsx
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onWheel={onWheel}
    >
```

- [ ] **Step 8: 型チェック・lint**

Run: `cd apps/client && pnpm exec tsc --noEmit && cd ../.. && pnpm exec biome check apps/client/src/components/Terminal.tsx apps/client/src/lib/scroll-intent.ts`
Expected: 型エラー無し、biome OK。
（このタスクは App 側の prop 追加まで完了しないと App.tsx が型エラーになるため、`tsc --noEmit` でのプロジェクト全体エラーは Task 4 完了後に解消する。Terminal.tsx 単体の構文/型は biome と本コマンドの Terminal 関連出力で確認する。）

> このタスクのコミットは Task 4 と合わせて行う（App.tsx の prop 追加まで揃わないと型が通らないため）。

---

## Task 4: `App.tsx`（ハンドラ配線・Header への履歴トグル受け渡し削除）

**Files:**
- Modify: `apps/client/src/App.tsx`

- [ ] **Step 1: enterHistory / exitHistory を useCallback で定義**

`adjustFontSize` の定義（`const adjustFontSize = useCallback(...)`）の直後に追加:
```ts
  // ライブ上端での上スクロールで遡り（履歴）へ、遡り後の最下部復帰でライブへ。Terminal から呼ばれる。
  const enterHistory = useCallback(() => setHistoryMode(true), [])
  const exitHistory = useCallback(() => setHistoryMode(false), [])
```

- [ ] **Step 2: Terminal に onEnterHistory / onExitHistory を渡す**

`<Terminal ... />` の `onAdjustFontSize={adjustFontSize}` の後に追加:

変更前:
```tsx
            onAdjustFontSize={adjustFontSize}
          />
```
変更後:
```tsx
            onAdjustFontSize={adjustFontSize}
            onEnterHistory={enterHistory}
            onExitHistory={exitHistory}
          />
```

- [ ] **Step 3: Header への onToggleHistory 受け渡しを削除**

`<Header ... />` から `onToggleHistory` 行を削除（`historyMode={historyMode}` は残す）。

変更前:
```tsx
          historyMode={historyMode}
          onToggleHistory={currentSurface && !isBrowserSurface ? () => setHistoryMode((h) => !h) : undefined}
          onOpenSettings={() => setSettingsOpen(true)}
```
変更後:
```tsx
          historyMode={historyMode}
          onOpenSettings={() => setSettingsOpen(true)}
```

- [ ] **Step 4: 型チェック・lint**

Run: `cd apps/client && pnpm exec tsc --noEmit && cd ../.. && pnpm exec biome check apps/client/src/App.tsx`
Expected: 型エラー無し（Header の `onToggleHistory` は次タスクで削除するが optional なので未指定でも型は通る）、biome OK。

- [ ] **Step 5: Terminal.tsx と App.tsx をまとめてコミット**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor
git add apps/client/src/components/Terminal.tsx apps/client/src/App.tsx
git commit -m "feat(client): ライブ上スクロールで遡り・最下部復帰でライブ再開（履歴モードをスクロール起点に）"
```

---

## Task 5: `Header.tsx`（「履歴」ボタンと onToggleHistory を削除）

**Files:**
- Modify: `apps/client/src/components/Header.tsx`

- [ ] **Step 1: props 型から onToggleHistory を削除**

変更前:
```ts
  // 履歴(スクロールバック)モードのトグル。undefined のときボタンを出さない（例: ブラウザサーフェス）。
  historyMode?: boolean
  onToggleHistory?: () => void
  // 設定モーダルを開く。
  onOpenSettings: () => void
```
変更後:
```ts
  // 履歴(スクロールバック)を遡っている間の鮮度表示（「履歴 · HH:MM時点」）に使う。
  historyMode?: boolean
  // 設定モーダルを開く。
  onOpenSettings: () => void
```

- [ ] **Step 2: 分割代入から onToggleHistory を削除**

変更前:
```ts
  historyMode,
  onToggleHistory,
  onOpenSettings,
```
変更後:
```ts
  historyMode,
  onOpenSettings,
```

- [ ] **Step 3: 「履歴」ボタンの JSX を削除**

変更前:
```tsx
      {/* 右側グループ: 接続状態＋鮮度(旧 footer)と履歴トグル。 */}
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <ConnectionIndicator status={status} lastUpdated={lastUpdated} historyMode={historyMode} />
        {onToggleHistory && (
          <button
            type="button"
            onClick={onToggleHistory}
            aria-label="Toggle history"
            aria-pressed={historyMode}
            style={{
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
        {/* 設定（履歴バッファ等）。履歴ボタンの隣の歯車。 */}
```
変更後:
```tsx
      {/* 右側グループ: 接続状態＋鮮度(旧 footer)と設定。 */}
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <ConnectionIndicator status={status} lastUpdated={lastUpdated} historyMode={historyMode} />
        {/* 設定（履歴バッファ等）。 */}
```

- [ ] **Step 4: 型チェック・lint・コミット**

Run: `cd apps/client && pnpm exec tsc --noEmit && cd ../.. && pnpm exec biome check apps/client/src/components/Header.tsx`
Expected: 型エラー無し、biome OK。

```bash
git add apps/client/src/components/Header.tsx
git commit -m "feat(client): ヘッダーの「履歴」ボタンを廃止（スクロール起点の遡りに統合）"
```

---

## Task 6: 全体検証とドキュメント更新

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 全体チェックとテスト**

Run: `cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor && pnpm check`
Expected: tsc + biome（両パッケージ）OK。

Run: `cd apps/client && pnpm vitest run`
Expected: 既存 + `scroll-intent` テストすべて PASS。

- [ ] **Step 2: ビルドが通ることを確認**

Run: `cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor && pnpm build`
Expected: 成功。

- [ ] **Step 3: CLAUDE.md を更新**

`components/Header.tsx` 周辺と `components/Terminal.tsx`／`SettingsModal` の記述を、「履歴ボタン廃止・ライブを上スクロールで遡る・遡り中は更新停止・最下部復帰でライブ再開」に合わせて更新する。少なくとも以下を反映:
- Header の「履歴」ボタン記述を削除し、「遡りはライブ上端での上スクロールで自動的に入る（`ConnectionIndicator` の鮮度表示は維持）」へ。
- Terminal の記述に「ライブ上端の上方向オーバースクロールで `onEnterHistory`、遡り中の最下部復帰で `onExitHistory`。判定は `lib/scroll-intent.ts`」を追記。
- `SettingsModal`/`settings.ts` の「履歴モード `readText(..., { scrollback, lines })` に渡る」を「ライブの遡り（スクロールバック）で取得する行数」に読み替え。

- [ ] **Step 4: コミット**

```bash
git add CLAUDE.md
git commit -m "docs: ライブ上スクロール遡り統合に合わせて CLAUDE.md を更新"
```

- [ ] **Step 5: 実機確認（手動・自動化対象外）**

iPhone Safari / PWA（または `pnpm dev` のモバイル幅）で:
1. 通常シェルのライブ表示で上端からさらに上へスクロール → 遡り（色なしテキスト）に入り、上方向へ過去を読めること。
2. 上へ遡った後、最下部へ戻ると自動でライブ（色付き・更新再開）に戻ること。進入直後の即バウンドが無いこと。
3. 横スクロール（全角・長行）・一本指タップ＝左クリック・二本指タップ＝右クリック・二本指ピンチが従来どおり動き、遡り進入と競合しないこと。
4. デスクトップ幅でホイール上スクロールでも遡りに入れること。

---

## Self-Review メモ

- **Spec coverage:** 上スクロール進入（Task 3 touch/wheel）、最下部復帰でライブ再開（Task 3 scroll + hasScrolledUp）、履歴ボタン廃止（Task 5）、バッファ設定維持（変更なし＝既存 effect 流用）、`scroll-intent` 単体テスト（Task 2）、cmux 制約＝遡りは色なし（既存 read_text 経路流用で自動的に満たす）。すべて対応タスクあり。
- **型整合:** `onEnterHistory`/`onExitHistory`（Terminal props・App 受け渡し・useCallback）一致。`isOverscrollUp`/`isAtBottom` の引数名は Task 2 定義と Task 3 呼び出しで一致。
- **プレースホルダ:** なし（全コード提示済み）。
