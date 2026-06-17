# radix 再スキン＋ダークモード対応 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/client` を radix プリミティブ＋lucide-react に再スキンし、CSS 変数で system/light/dark テーマを設定ダイアログから切替できるようにする（既存レイアウト・挙動は維持）。

**Architecture:** 配色を意味ベースの CSS 変数（トークン）へ集約し、`<html data-theme="light|dark">` で値を切替。`'system'` は `matchMedia` で解決し OS 設定に追従。テーマ層は `lib/theme.ts`＋`hooks/useTheme.ts` に分離。ダイアログ/スイッチ/スライダー/セグメントは radix のアンスタイルドプリミティブに置換し、アイコンは lucide-react に統一。`Terminal.tsx` の描画ロジックは不可侵（ビューポート背景のトークン化のみ）。

**Tech Stack:** React 19 / TypeScript / Vite / vitest + @testing-library/react / Biome / `@radix-ui/react-{dialog,alert-dialog,switch,slider,toggle-group}` / lucide-react

## Global Constraints

- TypeScript で `any` / `unknown` を使わない。
- React のエラーバウンダリ以外で `class` を新規に使わない。
- Biome 規約: シングルクォート、セミコロンなし（asNeeded）、行幅 120。各タスク完了前に `pnpm check`（tsc + biome）を通す。
- 既存挙動・レイアウト・操作感は維持（忠実な再スキン）。`Terminal.tsx` の描画ロジック（実測幅・MutationObserver・タッチ→マウス変換・フォント）には触れない。
- 色の単一情報源は `apps/client/src/styles/theme.css` のトークン。新たな `#rrggbb` / `rgba()` 直書きを増やさない。
- dark テーマのトークン値は現状の配色を 1:1 維持（dark の見た目は変えない）。light は派生値。
- ターミナルのビューポート背景は全テーマでダーク固定（`--color-terminal-bg`）。ANSI/wterm の描画には触れない。
- テストは `cd apps/client && pnpm vitest run <path>` で個別実行。全体は `pnpm test`。

---

## Task 1: 依存追加と jsdom テストシム

**Files:**
- Modify: `apps/client/package.json`（依存追加。コマンドで実施）
- Modify: `apps/client/vitest.setup.ts`（末尾にシム追加）

**Interfaces:**
- Produces: radix プリミティブ各種と `lucide-react` がインストール済み。テスト環境に `window.matchMedia` / `ResizeObserver` / pointer capture / `scrollIntoView` のモックが存在し、後続タスクの radix コンポーネントテストが jsdom で動く。

- [ ] **Step 1: 依存をインストール**

```bash
cd apps/client
pnpm add @radix-ui/react-dialog @radix-ui/react-alert-dialog @radix-ui/react-switch @radix-ui/react-slider @radix-ui/react-toggle-group lucide-react
```

- [ ] **Step 2: `vitest.setup.ts` の末尾にシムを追加**

`apps/client/vitest.setup.ts` の末尾（`installStorage(window, storage)` の後）に以下を追記する。

```ts
// jsdom には matchMedia が無い。theme（'system' 解決）と radix が参照するため最小モックを入れる。
// 既定は light（matches:false）。テーマ系テストは window.matchMedia を各自で差し替える。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// radix Slider/一部プリミティブが要求する ResizeObserver を補う。
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// radix Slider/Dialog が使う pointer capture と scrollIntoView を no-op で補う。
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
}
```

- [ ] **Step 3: 既存テストと型チェックが通ることを確認**

```bash
cd apps/client && pnpm vitest run && pnpm exec tsc --noEmit
```
Expected: 既存の全テスト PASS、tsc エラーなし。

- [ ] **Step 4: Commit**

```bash
git add apps/client/package.json apps/client/vitest.setup.ts ../../pnpm-lock.yaml
git commit -m "chore(client): radix/lucide 依存追加と jsdom テストシムを整備"
```

---

## Task 2: テーマ解決ロジック `lib/theme.ts`

**Files:**
- Create: `apps/client/src/lib/theme.ts`
- Test: `apps/client/src/lib/__tests__/theme.test.ts`

**Interfaces:**
- Produces:
  - `type ThemeSetting = 'system' | 'light' | 'dark'`
  - `type ResolvedTheme = 'light' | 'dark'`
  - `loadTheme(): ThemeSetting`（既定 `'system'`）
  - `saveTheme(setting: ThemeSetting): void`
  - `resolveTheme(setting: ThemeSetting): ResolvedTheme`
  - `applyTheme(resolved: ResolvedTheme): void`（`document.documentElement` の `data-theme` 属性と `<meta name="theme-color">` を更新）

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/theme.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, loadTheme, resolveTheme, saveTheme } from '../theme'

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
})

function mockPrefersDark(matches: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

describe('loadTheme / saveTheme', () => {
  it('未設定は system を返す', () => {
    expect(loadTheme()).toBe('system')
  })

  it('保存した値を読み戻す', () => {
    saveTheme('dark')
    expect(loadTheme()).toBe('dark')
  })

  it('不正値は system にフォールバック', () => {
    localStorage.setItem('cmux:theme', 'bogus')
    expect(loadTheme()).toBe('system')
  })
})

describe('resolveTheme', () => {
  it('light/dark はそのまま返す', () => {
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('system は prefers-color-scheme: dark に従う', () => {
    mockPrefersDark(true)
    expect(resolveTheme('system')).toBe('dark')
    mockPrefersDark(false)
    expect(resolveTheme('system')).toBe('light')
  })
})

describe('applyTheme', () => {
  it('data-theme 属性と theme-color メタを更新する', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('content', '#000000')
    document.head.appendChild(meta)

    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(meta.getAttribute('content')).toBe('#f4f5f7')

    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(meta.getAttribute('content')).toBe('#1a1a2e')

    meta.remove()
  })
})
```

- [ ] **Step 2: テストが落ちることを確認**

```bash
cd apps/client && pnpm vitest run src/lib/__tests__/theme.test.ts
```
Expected: FAIL（`../theme` が解決できない / 関数未定義）。

- [ ] **Step 3: `lib/theme.ts` を実装**

```ts
// テーマ設定の永続化・実テーマ解決・DOM 反映。設定値は 'system'|'light'|'dark' の 3 択で、
// 'system' のときだけ OS の prefers-color-scheme を参照する。lib/settings.ts と同じ流儀で
// localStorage ガードを置く。
export type ThemeSetting = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'cmux:theme'

// data-theme ごとの theme-color（PWA/iOS ステータスバー色）。各 --color-bg と一致させる。
const THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: '#1a1a2e',
  light: '#f4f5f7',
}

export function loadTheme(): ThemeSetting {
  if (typeof localStorage === 'undefined') return 'system'
  const raw = localStorage.getItem(KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

export function saveTheme(setting: ThemeSetting): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, setting)
}

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting === 'light' || setting === 'dark') return setting
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolved)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved])
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
cd apps/client && pnpm vitest run src/lib/__tests__/theme.test.ts
```
Expected: PASS（全ケース）。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/theme.ts apps/client/src/lib/__tests__/theme.test.ts
git commit -m "feat(client): テーマ解決ロジック(lib/theme)を追加"
```

---

## Task 3: `hooks/useTheme.ts`

**Files:**
- Create: `apps/client/src/hooks/useTheme.ts`
- Test: `apps/client/src/hooks/__tests__/useTheme.test.tsx`

**Interfaces:**
- Consumes: `lib/theme.ts` の `loadTheme`/`saveTheme`/`resolveTheme`/`applyTheme`/`ThemeSetting`
- Produces: `useTheme(): { setting: ThemeSetting; resolved: ResolvedTheme; setTheme: (t: ThemeSetting) => void }`。マウント時と `setting` 変更時に `applyTheme(resolveTheme(setting))` を呼び、`'system'` の間は `matchMedia` の `change` を購読して OS 切替に追従する。

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/hooks/__tests__/useTheme.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTheme } from '../useTheme'

type Listener = () => void

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
})

// change を発火できる matchMedia モック。matches は可変。
function installMatchMedia(initialDark: boolean) {
  const state = { matches: initialDark, listeners: new Set<Listener>() }
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return state.matches
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: Listener) => state.listeners.add(cb),
        removeEventListener: (_: string, cb: Listener) => state.listeners.delete(cb),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
  return {
    emit(dark: boolean) {
      state.matches = dark
      for (const cb of state.listeners) cb()
    },
  }
}

describe('useTheme', () => {
  it('setTheme で data-theme を更新し localStorage に永続する', () => {
    installMatchMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setTheme('dark'))
    expect(result.current.setting).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('cmux:theme')).toBe('dark')
  })

  it("setting=system の間は OS の変更に追従する", () => {
    const mq = installMatchMedia(false)
    renderHook(() => useTheme()) // 既定 system
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    act(() => mq.emit(true))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
```

- [ ] **Step 2: テストが落ちることを確認**

```bash
cd apps/client && pnpm vitest run src/hooks/__tests__/useTheme.test.tsx
```
Expected: FAIL（`../useTheme` 未定義）。

- [ ] **Step 3: `hooks/useTheme.ts` を実装**

```ts
import { useCallback, useEffect, useState } from 'react'

import { applyTheme, loadTheme, resolveTheme, saveTheme, type ThemeSetting } from '../lib/theme'

// テーマ設定の状態を保持し、DOM への反映と OS 設定追従を担う。アプリ全体で 1 回だけ使う。
export function useTheme() {
  const [setting, setSetting] = useState<ThemeSetting>(loadTheme)

  useEffect(() => {
    applyTheme(resolveTheme(setting))
    // 'system' のときだけ OS 変更を購読して即追従する。light/dark 固定時は購読不要。
    if (setting !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(resolveTheme('system'))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [setting])

  const setTheme = useCallback((next: ThemeSetting) => {
    saveTheme(next)
    setSetting(next)
  }, [])

  return { setting, resolved: resolveTheme(setting), setTheme }
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
cd apps/client && pnpm vitest run src/hooks/__tests__/useTheme.test.tsx
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/hooks/useTheme.ts apps/client/src/hooks/__tests__/useTheme.test.tsx
git commit -m "feat(client): useTheme フックを追加(OS 追従/永続)"
```

---

## Task 4: カラートークン CSS・FOUC 防止・global.css

**Files:**
- Create: `apps/client/src/styles/theme.css`
- Modify: `apps/client/src/styles/global.css`
- Modify: `apps/client/index.html`

**Interfaces:**
- Produces: `:root[data-theme="dark"]` / `:root[data-theme="light"]` に全カラートークンが定義され、`global.css` が `theme.css` を import して body の色をトークン化。Drawer 用スライド/フェードのアニメーションクラスを `global.css` に用意。`index.html` の `<head>` で React マウント前に `data-theme` を確定（FOUC 防止）。

- [ ] **Step 1: `styles/theme.css` を作成**

```css
/* 配色の単一情報源。dark は現状の配色を 1:1 維持、light は派生値。data-theme は html(:root)。 */
:root[data-theme='dark'] {
  --color-bg: #1a1a2e;
  --color-surface: #16213e;
  --color-sidebar: #0f1729;
  --color-control-bg: #1a1a2e;
  --color-border: #2a2a4e;
  --color-border-subtle: #1e2a42;
  --color-tab-group-border: #4a4a6e;
  --color-text: #e0e0e0;
  --color-text-muted: #aaaaaa;
  --color-text-subtle: #777777;
  --color-accent: #4caf50;
  --color-accent-contrast: #ffffff;
  --color-accent-strong: #2e5cb8;
  --color-danger: #e74c3c;
  --color-warning: #f39c12;
  --color-scrim: rgba(0, 0, 0, 0.6);
  --color-selected: rgba(255, 255, 255, 0.08);
  --color-key-armed-bg: #4a5a9a;
  --color-key-armed-border: #6a7ace;
  --color-key-armed-text: #ffffff;
  --color-terminal-bg: #1a1a2e;
  --color-link: #4fc3f7;
  --color-link-bg: #0f3460;
}

:root[data-theme='light'] {
  --color-bg: #f4f5f7;
  --color-surface: #ffffff;
  --color-sidebar: #f0f1f4;
  --color-control-bg: #ffffff;
  --color-border: #d8dbe0;
  --color-border-subtle: #e6e8ec;
  --color-tab-group-border: #c4c8d0;
  --color-text: #1a1a2e;
  --color-text-muted: #5b6370;
  --color-text-subtle: #8a909a;
  --color-accent: #43a047;
  --color-accent-contrast: #ffffff;
  --color-accent-strong: #2e5cb8;
  --color-danger: #d32f2f;
  --color-warning: #e08600;
  --color-scrim: rgba(0, 0, 0, 0.35);
  --color-selected: rgba(0, 0, 0, 0.06);
  --color-key-armed-bg: #dbe2ff;
  --color-key-armed-border: #9db0ff;
  --color-key-armed-text: #1a1a2e;
  --color-terminal-bg: #1a1a2e;
  --color-link: #1565c0;
  --color-link-bg: #e3f0fc;
}
```

- [ ] **Step 2: `global.css` を更新**

冒頭に import を 1 行追加（ファイル先頭）:

```css
@import './theme.css';
```

`html, body` ブロック内の以下 2 行を置換:

```css
  background-color: var(--color-bg);
  color: var(--color-text);
```

ファイル末尾に Drawer 用アニメーションを追加（Task 9 のモバイル Drawer が使用）:

```css
/* radix Dialog 化したモバイル Drawer のスライド/フェード（data-state 駆動）。 */
.drawer-overlay[data-state='open'] {
  animation: cmux-fade-in 0.2s ease-out;
}
.drawer-overlay[data-state='closed'] {
  animation: cmux-fade-out 0.2s ease-out;
}
.drawer-content[data-state='open'] {
  animation: cmux-drawer-in 0.2s ease-out;
}
.drawer-content[data-state='closed'] {
  animation: cmux-drawer-out 0.2s ease-out;
}
@keyframes cmux-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes cmux-fade-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes cmux-drawer-in {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(0);
  }
}
@keyframes cmux-drawer-out {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-100%);
  }
}
```

- [ ] **Step 3: `index.html` に FOUC 防止スクリプトを追加**

`<head>` 内、`<title>` の直前に以下を追加する（`resolveTheme` と同じ判定: 設定が light/dark ならそれ、無ければ matchMedia、matchMedia 不在は dark）:

```html
    <script>
      (function () {
        try {
          var t = localStorage.getItem('cmux:theme')
          var resolved =
            t === 'light' || t === 'dark'
              ? t
              : !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light'
          document.documentElement.setAttribute('data-theme', resolved)
        } catch (e) {}
      })()
    </script>
```

- [ ] **Step 4: ビルドと型チェックで壊れていないことを確認**

```bash
cd apps/client && pnpm build && pnpm exec tsc --noEmit
```
Expected: ビルド成功、tsc エラーなし。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/styles/theme.css apps/client/src/styles/global.css apps/client/index.html
git commit -m "feat(client): カラートークンCSSとFOUC防止/global.cssのトークン化"
```

---

## Task 5: SettingsModal を radix 化＋テーマ切替を追加

**Files:**
- Modify: `apps/client/src/components/SettingsModal.tsx`（全面置換）
- Test: `apps/client/src/components/__tests__/SettingsModal.test.tsx`（新規）

**Interfaces:**
- Consumes: `lib/settings.ts`（`clampHistoryLines`/`HISTORY_LINES_MIN`/`HISTORY_LINES_MAX`）、`lib/theme.ts`（`ThemeSetting`）、`@radix-ui/react-{dialog,switch,slider,toggle-group}`、`lucide-react`（`Monitor`/`Sun`/`Moon`/`X`）
- Produces: `SettingsModal` の新 props
  ```ts
  interface SettingsModalProps {
    open: boolean
    themeSetting: ThemeSetting
    onThemeChange: (t: ThemeSetting) => void
    historyLines: number
    pushSupported: boolean
    pushEnabled: boolean
    onTogglePush: (enabled: boolean) => void
    onSave: (lines: number) => void
    onClose: () => void
  }
  ```

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/components/__tests__/SettingsModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../SettingsModal'

function setup(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const props = {
    open: true,
    themeSetting: 'system' as const,
    onThemeChange: vi.fn(),
    historyLines: 2000,
    pushSupported: true,
    pushEnabled: false,
    onTogglePush: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<SettingsModal {...props} />)
  return props
}

describe('SettingsModal', () => {
  it('テーマセグメントの選択で onThemeChange を呼ぶ', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(props.onThemeChange).toHaveBeenCalledWith('dark')
  })

  it('通知 Switch の操作で onTogglePush を呼ぶ', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('switch'))
    expect(props.onTogglePush).toHaveBeenCalledWith(true)
  })

  it('保存で現在の履歴行数を onSave して閉じる', () => {
    const props = setup()
    fireEvent.click(screen.getByText('保存'))
    expect(props.onSave).toHaveBeenCalledWith(2000)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('open=false では中身を描画しない', () => {
    setup({ open: false })
    expect(screen.queryByText('保存')).toBeNull()
  })
})
```

注: radix ToggleGroup(type="single") の各 Item は `role="radio"` を持つ。Switch は `role="switch"`。

- [ ] **Step 2: テストが落ちることを確認**

```bash
cd apps/client && pnpm vitest run src/components/__tests__/SettingsModal.test.tsx
```
Expected: FAIL（新 props / role 不一致）。

- [ ] **Step 3: `SettingsModal.tsx` を全面置換**

```tsx
import * as Dialog from '@radix-ui/react-dialog'
import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Monitor, Moon, Sun, X } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'
import { clampHistoryLines, HISTORY_LINES_MAX, HISTORY_LINES_MIN } from '../lib/settings'
import type { ThemeSetting } from '../lib/theme'

interface SettingsModalProps {
  open: boolean
  themeSetting: ThemeSetting
  onThemeChange: (t: ThemeSetting) => void
  historyLines: number
  pushSupported: boolean
  pushEnabled: boolean
  onTogglePush: (enabled: boolean) => void
  onSave: (lines: number) => void
  onClose: () => void
}

const THEME_OPTIONS: { value: ThemeSetting; label: string; Icon: typeof Monitor }[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

const labelStyle: CSSProperties = { display: 'block', fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6 }

// 設定モーダル。テーマ/通知は即時反映、履歴行数は draft→保存で確定（従来挙動）。
export function SettingsModal({
  open,
  themeSetting,
  onThemeChange,
  historyLines,
  pushSupported,
  pushEnabled,
  onTogglePush,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [draft, setDraft] = useState(String(historyLines))
  useEffect(() => {
    if (open) setDraft(String(historyLines))
  }, [open, historyLines])

  const parsed = Number.parseInt(draft, 10)
  const valid = Number.isFinite(parsed) && parsed >= HISTORY_LINES_MIN && parsed <= HISTORY_LINES_MAX
  const save = () => {
    onSave(clampHistoryLines(parsed))
    onClose()
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          style={{ position: 'fixed', inset: 0, background: 'var(--color-scrim)', zIndex: 100 }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'calc(100% - 32px)',
            maxWidth: 360,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 10,
            color: 'var(--color-text)',
            padding: 20,
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
            zIndex: 101,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <Dialog.Title style={{ fontSize: 16, fontWeight: 600 }}>設定</Dialog.Title>
            <Dialog.Close
              aria-label="閉じる"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
                display: 'flex',
                padding: 4,
              }}
            >
              <X size={18} />
            </Dialog.Close>
          </div>

          {/* テーマ（即時反映） */}
          <div style={{ marginBottom: 18 }}>
            <span style={labelStyle}>テーマ</span>
            <ToggleGroup.Root
              type="single"
              value={themeSetting}
              onValueChange={(v) => {
                if (v) onThemeChange(v as ThemeSetting)
              }}
              style={{ display: 'flex', gap: 6 }}
            >
              {THEME_OPTIONS.map(({ value, label, Icon }) => {
                const active = themeSetting === value
                return (
                  <ToggleGroup.Item
                    key={value}
                    value={value}
                    aria-label={label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      flex: 1,
                      padding: '8px 0',
                      fontSize: 13,
                      borderRadius: 6,
                      border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                      background: active ? 'var(--color-accent)' : 'transparent',
                      color: active ? 'var(--color-accent-contrast)' : 'var(--color-text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <Icon size={16} />
                    {label}
                  </ToggleGroup.Item>
                )
              })}
            </ToggleGroup.Root>
          </div>

          {/* 通知（Web Push） */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>通知（Web Push）</span>
              <Switch.Root
                checked={pushEnabled}
                disabled={!pushSupported}
                onCheckedChange={onTogglePush}
                style={{
                  width: 42,
                  height: 24,
                  borderRadius: 12,
                  border: 'none',
                  position: 'relative',
                  background: pushEnabled ? 'var(--color-accent)' : 'var(--color-border)',
                  cursor: pushSupported ? 'pointer' : 'default',
                  opacity: pushSupported ? 1 : 0.5,
                  flexShrink: 0,
                }}
              >
                <Switch.Thumb
                  style={{
                    display: 'block',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'transform 0.15s',
                    transform: pushEnabled ? 'translateX(21px)' : 'translateX(3px)',
                  }}
                />
              </Switch.Root>
            </div>
            {!pushSupported && (
              <div style={{ fontSize: 12, color: 'var(--color-text-subtle)', marginTop: 6 }}>
                この環境では利用できません（HTTPS のホーム画面追加 PWA・iOS 16.4+ が必要です）。
              </div>
            )}
          </div>

          {/* 履歴バッファ（行数）。draft→保存で確定。 */}
          <span style={labelStyle}>履歴バッファ（行数）</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Slider.Root
              min={HISTORY_LINES_MIN}
              max={HISTORY_LINES_MAX}
              step={1000}
              value={[valid ? parsed : HISTORY_LINES_MIN]}
              onValueChange={([v]) => setDraft(String(v))}
              style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, height: 20 }}
            >
              <Slider.Track
                style={{ position: 'relative', flexGrow: 1, height: 4, borderRadius: 2, background: 'var(--color-border)' }}
              >
                <Slider.Range
                  style={{ position: 'absolute', height: '100%', borderRadius: 2, background: 'var(--color-accent)' }}
                />
              </Slider.Track>
              <Slider.Thumb
                aria-label="履歴バッファ"
                style={{ display: 'block', width: 16, height: 16, borderRadius: '50%', background: 'var(--color-accent)' }}
              />
            </Slider.Root>
            <input
              type="number"
              min={HISTORY_LINES_MIN}
              max={HISTORY_LINES_MAX}
              step={1000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{
                width: 90,
                background: 'var(--color-control-bg)',
                border: `1px solid ${valid ? 'var(--color-border)' : 'var(--color-danger)'}`,
                borderRadius: 4,
                color: 'var(--color-text)',
                fontSize: 14,
                padding: '6px 8px',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-subtle)', marginTop: 6 }}>
            {HISTORY_LINES_MIN.toLocaleString()}〜{HISTORY_LINES_MAX.toLocaleString()} 行（履歴モードで取得する
            スクロールバック行数。大きいほど重くなります）
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text-muted)',
                fontSize: 14,
                padding: '8px 14px',
                cursor: 'pointer',
              }}
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!valid}
              style={{
                background: valid ? 'var(--color-accent)' : 'var(--color-border)',
                border: 'none',
                borderRadius: 6,
                color: 'var(--color-accent-contrast)',
                fontSize: 14,
                fontWeight: 600,
                padding: '8px 16px',
                cursor: valid ? 'pointer' : 'default',
              }}
            >
              保存
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
cd apps/client && pnpm vitest run src/components/__tests__/SettingsModal.test.tsx
```
Expected: PASS（4 ケース）。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/components/SettingsModal.tsx apps/client/src/components/__tests__/SettingsModal.test.tsx
git commit -m "feat(client): SettingsModalをradix化しテーマ切替を追加"
```

---

## Task 6: App/Main に useTheme を配線

**Files:**
- Modify: `apps/client/src/App.tsx`

**Interfaces:**
- Consumes: `hooks/useTheme.ts` の `useTheme`、Task 5 の `SettingsModal` 新 props
- Produces: アプリ全体（TokenGate 画面含む）でテーマが適用され、設定ダイアログでテーマ切替できる。

- [ ] **Step 1: `App.tsx` を修正**

import を追加（既存 import 群の並びに合わせる）:

```tsx
import { useTheme } from './hooks/useTheme'
```

`App()` を以下に変更（`useTheme` を条件付き return より前で呼び、`Main` に渡す）:

```tsx
export function App() {
  // テーマはトークンゲート画面でも効かせるため、token 判定より前で適用する。
  const theme = useTheme()
  const [token, setToken] = useState(getAuthToken)

  if (!token) {
    return (
      <TokenGate
        onSubmit={(t) => {
          saveAuthToken(t)
          setToken(t)
        }}
      />
    )
  }

  return <Main theme={theme} />
}
```

`Main` のシグネチャを変更し、テーマ props を受ける:

```tsx
function Main({ theme }: { theme: ReturnType<typeof useTheme> }) {
```

`<SettingsModal ... />` に theme props を追加（既存の props はそのまま、`open` の直後に 2 行追加）:

```tsx
      <SettingsModal
        open={settingsOpen}
        themeSetting={theme.setting}
        onThemeChange={theme.setTheme}
        historyLines={historyLines}
        pushSupported={pushSupported}
        pushEnabled={pushEnabled}
        onTogglePush={togglePush}
        onSave={(lines) => {
          setHistoryLines(lines)
          saveHistoryLines(lines)
        }}
        onClose={() => setSettingsOpen(false)}
      />
```

`Main` の最外 `div` の色をトークン化（`backgroundColor: '#1a1a2e'` → `'var(--color-bg)'`、`color: '#e0e0e0'` → `'var(--color-text)'`）:

```tsx
    <div
      style={{
        display: 'flex',
        height: 'var(--app-height)',
        backgroundColor: 'var(--color-bg)',
        color: 'var(--color-text)',
        overflow: 'hidden',
      }}
    >
```

- [ ] **Step 2: 型チェックと既存テストを確認**

```bash
cd apps/client && pnpm exec tsc --noEmit && pnpm vitest run src/__tests__/App.test.tsx
```
Expected: tsc エラーなし、App テスト PASS。

- [ ] **Step 3: Commit**

```bash
git add apps/client/src/App.tsx
git commit -m "feat(client): App/Main に useTheme を配線しテーマ切替を有効化"
```

---

## Task 7: Header の lucide 化＋トークン化

**Files:**
- Modify: `apps/client/src/components/Header.tsx`（全面置換）

**Interfaces:**
- Consumes: `lucide-react`（`Menu`/`Settings`）。props は不変。

- [ ] **Step 1: `Header.tsx` を全面置換**

```tsx
import { Menu, Settings } from 'lucide-react'
import type { ConnectionStatus } from '../hooks/useWebSocket'
import { ConnectionIndicator } from './ConnectionIndicator'

interface HeaderProps {
  workspaceName: string | null
  onMenuToggle: () => void
  showMenuButton?: boolean
  status: ConnectionStatus
  lastUpdated?: number | null
  historyMode?: boolean
  onOpenSettings: () => void
}

export function Header({
  workspaceName,
  onMenuToggle,
  showMenuButton = true,
  status,
  lastUpdated,
  historyMode,
  onOpenSettings,
}: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 44,
        padding: '0 12px',
        backgroundColor: 'var(--color-surface)',
        color: 'var(--color-text)',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}
    >
      {showMenuButton && (
        <button
          type="button"
          onClick={onMenuToggle}
          aria-label="Menu"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text)',
            padding: '4px 8px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Menu size={22} />
        </button>
      )}
      <span
        style={{
          marginLeft: showMenuButton ? 8 : 4,
          flex: 1,
          minWidth: 0,
          fontSize: 15,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {workspaceName ?? 'cmux Remote'}
      </span>
      <div style={{ marginLeft: 8, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <ConnectionIndicator status={status} lastUpdated={lastUpdated} historyMode={historyMode} />
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="設定"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-muted)',
            padding: '4px 6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Settings size={19} />
        </button>
      </div>
    </header>
  )
}
```

- [ ] **Step 2: 型チェック**

```bash
cd apps/client && pnpm exec tsc --noEmit
```
Expected: エラーなし。

- [ ] **Step 3: Commit**

```bash
git add apps/client/src/components/Header.tsx
git commit -m "feat(client): Header を lucide アイコン化＋トークン化"
```

---

## Task 8: TabBar の lucide 化＋トークン化

**Files:**
- Modify: `apps/client/src/components/TabBar.tsx`

**Interfaces:**
- Consumes: `lucide-react`（`Plus`/`X`）。props・挙動は不変。

- [ ] **Step 1: import 追加**

`TabBar.tsx` 先頭に追加:

```tsx
import { Plus, X } from 'lucide-react'
```

- [ ] **Step 2: 色を以下のとおりトークンへ置換**

- コンテナ `backgroundColor: '#16213e'` → `'var(--color-surface)'`
- コンテナ `borderBottom: '1px solid #2a2a4e'` → `'1px solid var(--color-border)'`
- タブ `borderRight: '1px solid #2a2a4e'` → `'1px solid var(--color-border)'`
- タブ `borderLeft: newPaneGroup ? '2px solid #4a4a6e' : undefined` → `newPaneGroup ? '2px solid var(--color-tab-group-border)' : undefined`
- タブ `backgroundColor: active ? '#1a1a2e' : 'transparent'` → `active ? 'var(--color-bg)' : 'transparent'`
- タブ `borderBottom: active ? '2px solid #4caf50' : '2px solid transparent'` → `active ? '2px solid var(--color-accent)' : '2px solid transparent'`
- タブ名ボタン `color: active ? '#e0e0e0' : '#aaa'` → `active ? 'var(--color-text)' : 'var(--color-text-muted)'`
- 閉じるボタン `color: '#777'` → `'var(--color-text-subtle)'`
- 新規タブボタン `color: '#aaa'` → `'var(--color-text-muted)'`

- [ ] **Step 3: glyph をアイコンへ置換**

閉じるボタンの中身 `&times;` を `<X size={14} />` に、`fontSize: 16, lineHeight: 1` の指定は削除して `display: 'flex', alignItems: 'center'` を追加。
新規タブボタンの中身 `+` を `<Plus size={18} />` に、`fontSize: 20, lineHeight: 1` を削除して `display: 'flex', alignItems: 'center'` を追加。

- [ ] **Step 4: 型チェック**

```bash
cd apps/client && pnpm exec tsc --noEmit
```
Expected: エラーなし。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/components/TabBar.tsx
git commit -m "feat(client): TabBar を lucide アイコン化＋トークン化"
```

---

## Task 9: Drawer を radix Dialog/AlertDialog 化＋トークン化

**Files:**
- Modify: `apps/client/src/components/Drawer.tsx`（全面置換）
- Modify: `apps/client/src/components/__tests__/Drawer.test.tsx`（confirm→AlertDialog）

**Interfaces:**
- Consumes: `@radix-ui/react-dialog`、`@radix-ui/react-alert-dialog`、`lucide-react`（`Plus`/`X`）。`DrawerProps` は不変。
- Produces: `DESKTOP_BREAKPOINT`/`SIDEBAR_WIDTH` の export は不変。

- [ ] **Step 1: 既存テストを AlertDialog 仕様に書き換える（失敗させる）**

`Drawer.test.tsx` の冒頭 `describe('Drawer close workspace ...')` ブロック（行 37〜53 相当）を以下に置換。`window.confirm` モックを廃し、AlertDialog の確認ボタン（`aria-label="閉じる"` のワークスペース閉じる確認アクション、ラベル「閉じる」）を押す流れにする。

```tsx
describe('Drawer close workspace (確認ダイアログ)', () => {
  it('× → 確認ダイアログで「閉じる」を押すと onCloseWorkspace(ref) を呼ぶ', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    // AlertDialog の確認アクション
    fireEvent.click(screen.getByRole('button', { name: 'ワークスペースを閉じる' }))
    expect(onCloseWorkspace).toHaveBeenCalledWith('workspace:A')
  })

  it('× → 確認ダイアログでキャンセルすると onCloseWorkspace を呼ばない', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCloseWorkspace).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: テストが落ちることを確認**

```bash
cd apps/client && pnpm vitest run src/components/__tests__/Drawer.test.tsx
```
Expected: FAIL（確認ボタンが存在しない）。

- [ ] **Step 3: `Drawer.tsx` を全面置換**

```tsx
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import * as Dialog from '@radix-ui/react-dialog'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'

import type { CmuxNotification, Workspace } from '../lib/cmux-rpc'

const SIDEBAR_WIDTH = 220
const DESKTOP_BREAKPOINT = 768

interface DrawerProps {
  open: boolean
  workspaces: Workspace[]
  currentWorkspace: string | null
  notifications: CmuxNotification[]
  onSelect: (id: string) => void
  onCloseWorkspace: (ref: string) => void
  onNewWorkspace: () => Promise<void>
  onClose: () => void
}

/** Default palette for workspaces without custom_color (matches cmux desktop) */
const DEFAULT_PALETTE = [
  '#4A5C18',
  '#C0392B',
  '#1565C0',
  '#32A06D',
  '#8E44AD',
  '#D35400',
  '#2980B9',
  '#27AE60',
  '#E74C3C',
  '#16A085',
  '#F39C12',
  '#3498DB',
  '#2ECC71',
  '#E67E22',
  '#9B59B6',
]

function paletteColor(index: number): string {
  return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length] ?? '#3E4B5E'
}

/** Extract folder name from path */
function folderName(path?: string): string | null {
  if (!path) return null
  const parts = path.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || null
}

/** Get latest notification per workspace */
function latestNotificationByWorkspace(notifications: CmuxNotification[]): Map<string, CmuxNotification> {
  const latest = new Map<string, CmuxNotification>()
  for (const n of notifications) {
    latest.set(n.workspace_id, n)
  }
  return latest
}

/** Count unread notifications per workspace */
function unreadCountByWorkspace(notifications: CmuxNotification[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const n of notifications) {
    if (!n.is_read) {
      counts.set(n.workspace_id, (counts.get(n.workspace_id) ?? 0) + 1)
    }
  }
  return counts
}

/** Derive status from notification */
function deriveStatus(n?: CmuxNotification): { label: string; color: string } | null {
  if (!n) return null
  const body = n.body.toLowerCase()
  const subtitle = n.subtitle.toLowerCase()

  if (!n.is_read) {
    if (body.includes('waiting for your input') || subtitle === 'waiting') {
      return { label: 'Needs input', color: 'var(--color-warning)' }
    }
    if (body.includes('permission')) {
      return { label: 'Permission', color: 'var(--color-danger)' }
    }
  }
  if (subtitle.includes('completed') || body.includes('完了')) {
    return { label: 'Idle', color: 'var(--color-text-subtle)' }
  }
  return null
}

function WorkspaceItem({
  ws,
  index,
  isCurrent,
  unreadCount,
  notification,
  onClick,
  onRequestClose,
}: {
  ws: Workspace
  index: number
  isCurrent: boolean
  unreadCount: number
  notification?: CmuxNotification
  onClick: () => void
  onRequestClose: () => void
}) {
  const color = ws.custom_color ?? paletteColor(index)
  const folder = folderName(ws.current_directory)
  const status = deriveStatus(notification)

  const notifPreview = notification?.body
    ? notification.body.slice(0, 60) + (notification.body.length > 60 ? '...' : '')
    : null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: isCurrent ? 'var(--color-selected)' : 'none',
        borderLeft: `3px solid ${isCurrent ? color || 'var(--color-accent)' : 'transparent'}`,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        style={{
          display: 'flex',
          gap: 8,
          flex: 1,
          minWidth: 0,
          padding: '8px 10px',
          background: 'none',
          border: 'none',
          color: 'var(--color-text)',
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer',
          alignItems: 'flex-start',
        }}
      >
        <span
          style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0, marginTop: 4 }}
        />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <span
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: isCurrent ? 'var(--color-text)' : 'var(--color-text-muted)',
              fontWeight: isCurrent ? 600 : 400,
            }}
          >
            {ws.title || ws.ref}
          </span>
          {notifPreview && (
            <span
              style={{
                display: 'block',
                fontSize: 10,
                color: 'var(--color-text-subtle)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 1,
              }}
            >
              {notifPreview}
            </span>
          )}
          {status && (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: status.color, marginTop: 2 }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: status.color }} />
              {status.label}
            </span>
          )}
          {folder && (
            <span
              style={{
                display: 'block',
                fontSize: 10,
                color: 'var(--color-text-subtle)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 1,
              }}
            >
              ~/git/{folder}
            </span>
          )}
        </span>
        {unreadCount > 0 && (
          <span
            style={{
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor:
                status?.label === 'Needs input' || status?.label === 'Permission' ? status.color : 'var(--color-danger)',
              color: 'var(--color-accent-contrast)',
              fontSize: 10,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 4px',
              flexShrink: 0,
              marginTop: 2,
            }}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {/* 閉じる: AlertDialog で確認（破壊的操作）。 */}
      <button
        type="button"
        onClick={onRequestClose}
        aria-label="Close workspace"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          background: 'none',
          border: 'none',
          color: 'var(--color-text-subtle)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <X size={18} />
      </button>
    </div>
  )
}

function WorkspaceList({
  workspaces,
  currentWorkspace,
  notifications,
  onSelect,
  onCloseWorkspace,
  onClose,
  isDesktop,
}: Omit<DrawerProps, 'open' | 'onNewWorkspace'> & { isDesktop: boolean }) {
  const unreadCounts = unreadCountByWorkspace(notifications)
  const latestNotifs = latestNotificationByWorkspace(notifications)
  // 閉じる確認の対象ワークスペース（null=ダイアログ非表示）。
  const [closing, setClosing] = useState<Workspace | null>(null)

  return (
    <>
      <ul style={{ listStyle: 'none', margin: 0, padding: '4px 0', flex: 1, overflowY: 'auto' }}>
        {workspaces.map((ws, i) => (
          <li key={ws.ref} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <WorkspaceItem
              ws={ws}
              index={i}
              isCurrent={ws.ref === currentWorkspace}
              unreadCount={unreadCounts.get(ws.id) ?? 0}
              notification={latestNotifs.get(ws.id)}
              onClick={() => {
                onSelect(ws.ref)
                if (!isDesktop) onClose()
              }}
              onRequestClose={() => setClosing(ws)}
            />
          </li>
        ))}
        {workspaces.length === 0 && (
          <li style={{ padding: '12px 16px', color: 'var(--color-text-subtle)', fontSize: 12 }}>No workspaces</li>
        )}
      </ul>

      <AlertDialog.Root open={closing !== null} onOpenChange={(o) => !o && setClosing(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay style={{ position: 'fixed', inset: 0, background: 'var(--color-scrim)', zIndex: 110 }} />
          <AlertDialog.Content
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'calc(100% - 32px)',
              maxWidth: 320,
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 10,
              color: 'var(--color-text)',
              padding: 20,
              zIndex: 111,
            }}
          >
            <AlertDialog.Title style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              ワークスペースを閉じる
            </AlertDialog.Title>
            <AlertDialog.Description style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 18 }}>
              「{closing?.title || closing?.ref}」を閉じますか？
            </AlertDialog.Description>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <AlertDialog.Cancel
                style={{
                  background: 'none',
                  border: '1px solid var(--color-border)',
                  borderRadius: 6,
                  color: 'var(--color-text-muted)',
                  fontSize: 14,
                  padding: '8px 14px',
                  cursor: 'pointer',
                }}
              >
                キャンセル
              </AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  if (closing) onCloseWorkspace(closing.ref)
                }}
                style={{
                  background: 'var(--color-danger)',
                  border: 'none',
                  borderRadius: 6,
                  color: 'var(--color-accent-contrast)',
                  fontSize: 14,
                  fontWeight: 600,
                  padding: '8px 16px',
                  cursor: 'pointer',
                }}
              >
                ワークスペースを閉じる
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  )
}

function NewWorkspaceButton({ onNewWorkspace }: { onNewWorkspace: () => Promise<void> }) {
  const [creating, setCreating] = useState(false)
  return (
    <button
      type="button"
      aria-label="New workspace"
      disabled={creating}
      onClick={async () => {
        if (creating) return
        setCreating(true)
        try {
          await onNewWorkspace()
        } finally {
          setCreating(false)
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        padding: '10px 12px',
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        background: 'none',
        border: 'none',
        borderTop: '1px solid var(--color-border-subtle)',
        color: creating ? 'var(--color-text-subtle)' : 'var(--color-text)',
        fontSize: 12,
        fontWeight: 600,
        textAlign: 'left',
        cursor: creating ? 'default' : 'pointer',
        flexShrink: 0,
      }}
    >
      <Plus size={15} />
      {creating ? '作成中…' : '新規ワークスペース'}
    </button>
  )
}

export { DESKTOP_BREAKPOINT, SIDEBAR_WIDTH }

export function Drawer({
  open,
  workspaces,
  currentWorkspace,
  notifications,
  onSelect,
  onCloseWorkspace,
  onNewWorkspace,
  onClose,
}: DrawerProps) {
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT

  const sidebarContent = (
    <WorkspaceList
      workspaces={workspaces}
      currentWorkspace={currentWorkspace}
      notifications={notifications}
      onSelect={onSelect}
      onCloseWorkspace={onCloseWorkspace}
      onClose={onClose}
      isDesktop={isDesktop}
    />
  )

  // Desktop/タブレット: ピン留めサイドバー（非モーダル）。開閉でスライドし本文が全幅になる。
  if (isDesktop) {
    return (
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: SIDEBAR_WIDTH,
          backgroundColor: 'var(--color-sidebar)',
          borderRight: '1px solid var(--color-border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          paddingTop: 'env(safe-area-inset-top)',
          zIndex: 50,
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.2s ease-out',
        }}
      >
        <div
          style={{
            padding: '0 12px',
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--color-text-subtle)',
            height: 44,
            display: 'flex',
            alignItems: 'center',
            borderBottom: '1px solid var(--color-border-subtle)',
          }}
        >
          cmux Remote
        </div>
        {sidebarContent}
        <NewWorkspaceButton onNewWorkspace={onNewWorkspace} />
      </nav>
    )
  }

  // Mobile: radix Dialog によるモーダルオーバーレイ（フォーカストラップ/Escape/スクロールロック）。
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="drawer-overlay"
          style={{ position: 'fixed', inset: 0, backgroundColor: 'var(--color-scrim)', zIndex: 90 }}
        />
        <Dialog.Content
          className="drawer-content"
          aria-describedby={undefined}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            bottom: 0,
            width: 260,
            backgroundColor: 'var(--color-sidebar)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            paddingTop: 'env(safe-area-inset-top)',
          }}
        >
          <Dialog.Title
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          >
            ワークスペース
          </Dialog.Title>
          {sidebarContent}
          <NewWorkspaceButton onNewWorkspace={onNewWorkspace} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

- [ ] **Step 4: Drawer テストが通ることを確認**

```bash
cd apps/client && pnpm vitest run src/components/__tests__/Drawer.test.tsx
```
Expected: PASS（confirm/select/badge/new-workspace の全ケース）。デスクトップ幅テストは `<nav>` 経路、モバイル幅テストは Dialog 経路（`screen.getByText('Alpha')` は Portal 内でも取得可）。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/components/Drawer.tsx apps/client/src/components/__tests__/Drawer.test.tsx
git commit -m "feat(client): Drawer をradix Dialog/AlertDialog化＋トークン化"
```

---

## Task 10: InputBar のトークン化＋Keyboard アイコン

**Files:**
- Modify: `apps/client/src/components/InputBar.tsx`

**Interfaces:**
- Consumes: `lucide-react`（`Keyboard`）。props・挙動・`aria-label` は不変（既存 InputBar テストはそのまま通る）。

- [ ] **Step 1: import 追加と label 型の拡張**

`InputBar.tsx` 先頭の import に `ReactNode` と `Keyboard` を追加:

```tsx
import { type CSSProperties, type ReactNode, useState } from 'react'
import { Keyboard } from 'lucide-react'
```

`KeyButton` と `ToggleButton` の props の `label: string` を `label: ReactNode` に変更（両コンポーネントとも）。

- [ ] **Step 2: 色トークンへ置換**

- `keyButtonStyle`: `background: '#1a1a2e'` → `'var(--color-control-bg)'`、`border: '1px solid #2a2a4e'` → `'1px solid var(--color-border)'`、`color: '#ccc'` → `'var(--color-text-muted)'`
- `KeyButton` の `style` 内: `background: pressed ? '#4a5a9a' : keyButtonStyle.background` → `pressed ? 'var(--color-key-armed-bg)' : keyButtonStyle.background`、`borderColor: pressed ? '#6a7ace' : '#2a2a4e'` → `pressed ? 'var(--color-key-armed-border)' : 'var(--color-border)'`、`color: pressed ? '#fff' : keyButtonStyle.color` → `pressed ? 'var(--color-key-armed-text)' : keyButtonStyle.color`
- `ToggleButton` の `style` 内: `background: active ? '#4a5a9a' : keyButtonStyle.background` → `active ? 'var(--color-key-armed-bg)' : keyButtonStyle.background`、`borderColor: active ? '#6a7ace' : '#2a2a4e'` → `active ? 'var(--color-key-armed-border)' : 'var(--color-border)'`、`color: active ? '#fff' : keyButtonStyle.color` → `active ? 'var(--color-key-armed-text)' : keyButtonStyle.color`
- 最外コンテナ: `backgroundColor: '#16213e'` → `'var(--color-surface)'`、`borderTop: '1px solid #2a2a4e'` → `'1px solid var(--color-border)'`
- テキスト入力: `background: '#1a1a2e'` → `'var(--color-control-bg)'`、`border: '1px solid #2a2a4e'` → `'1px solid var(--color-border)'`、`color: '#e0e0e0'` → `'var(--color-text)'`
- Send ボタン: `background: disabled ? '#2a2a4e' : '#4caf50'` → `disabled ? 'var(--color-border)' : 'var(--color-accent)'`、`color: '#fff'` → `'var(--color-accent-contrast)'`

- [ ] **Step 3: ⌨ を Keyboard アイコンへ**

`ToggleButton label="⌨" ariaLabel="キーボード表示切替" ...` の `label="⌨"` を `label={<Keyboard size={16} />}` に変更（`ariaLabel` は維持）。

- [ ] **Step 4: 型チェックと既存 InputBar テストを確認**

```bash
cd apps/client && pnpm exec tsc --noEmit && pnpm vitest run src/components/__tests__/InputBar.test.tsx
```
Expected: tsc エラーなし、InputBar テスト PASS（`aria-label` 参照のため不変）。

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/components/InputBar.tsx
git commit -m "feat(client): InputBar をトークン化＋Keyboardアイコン"
```

---

## Task 11: 残り（ConnectionIndicator / TokenGate / ErrorBoundary / BrowserView / Terminal）のトークン化

**Files:**
- Modify: `apps/client/src/components/ConnectionIndicator.tsx`
- Modify: `apps/client/src/components/TokenGate.tsx`
- Modify: `apps/client/src/components/ErrorBoundary.tsx`
- Modify: `apps/client/src/components/BrowserView.tsx`
- Modify: `apps/client/src/components/Terminal.tsx`

**Interfaces:** いずれも props・挙動不変。色のみトークン化。

- [ ] **Step 1: ConnectionIndicator**

`STATUS_CONFIG` を以下に置換:

```tsx
const STATUS_CONFIG: Record<ConnectionStatus, { label: string; color: string }> = {
  connected: { label: 'Connected', color: 'var(--color-accent)' },
  connecting: { label: 'Connecting...', color: 'var(--color-warning)' },
  disconnected: { label: 'Disconnected', color: 'var(--color-danger)' },
}
```

最後の `return` の span: `color: '#aaa'` → `'var(--color-text-muted)'`。notice の `color: historyMode ? '#4caf50' : '#ff9800'` → `historyMode ? 'var(--color-accent)' : 'var(--color-warning)'`。

- [ ] **Step 2: TokenGate**

色を置換: フォーム `backgroundColor: '#1a1a2e'` → `'var(--color-bg)'`、`color: '#e0e0e0'` → `'var(--color-text)'`。`<p>` の `color: '#888'` → `'var(--color-text-subtle)'`。input の `color: '#e0e0e0'` → `'var(--color-text)'`、`backgroundColor: '#16213e'` → `'var(--color-surface)'`、`border: '1px solid #2a2a4e'` → `'1px solid var(--color-border)'`。button の `color: '#e0e0e0'` → `'var(--color-accent-contrast)'`、`backgroundColor: '#2e5cb8'` → `'var(--color-accent-strong)'`。

- [ ] **Step 3: ErrorBoundary**

`containerStyle` の `backgroundColor: '#1a1a2e'` → `'var(--color-bg)'`、`color: '#e0e0e0'` → `'var(--color-text)'`。再読み込みボタンの `color: '#e0e0e0'` → `'var(--color-text)'`、`backgroundColor: '#2a2a4a'` → `'var(--color-surface)'`、`border: '1px solid #44446a'` → `'1px solid var(--color-border)'`。（アイコン追加は YAGNI のため行わない。）

- [ ] **Step 4: BrowserView**

`wrapperStyle.backgroundColor: '#1a1a2e'` → `'var(--color-bg)'`。`'URL を取得できませんでした'` の `color: '#8a8aa0'` → `'var(--color-text-muted)'`。title `color: '#e0e0e0'` → `'var(--color-text)'`。URL 行 `color: '#8a8aa0'` → `'var(--color-text-muted)'`。リンク `backgroundColor: '#0f3460'` → `'var(--color-link-bg)'`、`color: '#4fc3f7'` → `'var(--color-link)'`。

- [ ] **Step 5: Terminal（ビューポート背景のみ）**

`Terminal.tsx` の `wrapperStyle`（外側 wrapper の style オブジェクト）に背景色トークンを 1 つ追加する。`--term-bg`/`--term-fg`/`--term-cursor`（wterm 内部のターミナル配色）は**変更しない**（ターミナル本文は全テーマでダーク維持）。wrapper の style に以下を追加:

```tsx
    backgroundColor: 'var(--color-terminal-bg)',
```

（`wrapperRef` を持つ最外 `<div>` の style。`width`/`height` 等の既存指定は触らない。）

- [ ] **Step 6: 型チェックと全テスト**

```bash
cd apps/client && pnpm exec tsc --noEmit && pnpm vitest run
```
Expected: tsc エラーなし、全テスト PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/components/ConnectionIndicator.tsx apps/client/src/components/TokenGate.tsx apps/client/src/components/ErrorBoundary.tsx apps/client/src/components/BrowserView.tsx apps/client/src/components/Terminal.tsx
git commit -m "feat(client): 残りコンポーネントの配色をトークン化"
```

---

## Task 12: 直書き色の洗い出しと最終検証

**Files:** （検証のみ。漏れがあれば該当ファイルを修正）

- [ ] **Step 1: 残存する直書き色を洗い出す**

```bash
cd apps/client
grep -rn "#[0-9a-fA-F]\{3,6\}\|rgba\?(" src --include="*.tsx" --include="*.ts" \
  | grep -v "__tests__" | grep -v "render-grid" | grep -v "styles/theme.css" \
  | grep -v "DEFAULT_PALETTE" | grep -v "term-bg\|term-fg\|term-cursor" | grep -v "background: '#fff'"
```
Expected: テーマ非依存として意図的に残すもの（`DEFAULT_PALETTE`、wterm の `--term-*`、Switch サムの `#fff`、box-shadow の `rgba(0,0,0,…)`）以外に**アプリ枠の色が残っていないこと**。残っていれば対応するトークンへ置換し、該当ファイルを別途コミットする。

- [ ] **Step 2: 型チェック・lint・全テスト**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor && pnpm check && pnpm test
```
Expected: `pnpm check`（tsc + biome）グリーン、`pnpm test` 全 PASS。

- [ ] **Step 3: ビルド確認**

```bash
cd apps/client && pnpm build
```
Expected: ビルド成功。

- [ ] **Step 4: 手動確認チェックリスト（`pnpm dev` で実機/ブラウザ）**

- [ ] 設定ダイアログで System / Light / Dark を切替でき、即座に反映される。
- [ ] Light/Dark を選んでリロードしても選択が保持され、初回描画で別テーマがちらつかない（FOUC 無し）。
- [ ] System 選択時、OS のダーク/ライト切替に追従する。
- [ ] iOS PWA でステータスバー周りの色（theme-color）がテーマに追従する。
- [ ] モバイル幅で Drawer がオーバーレイ表示され、Escape/背景タップ/フォーカストラップが効く。
- [ ] ワークスペースの × で確認ダイアログ（AlertDialog）が出て、閉じる/キャンセルが正しく動く。
- [ ] Light テーマでもターミナルのビューポートはダークのまま、本文表示が崩れない。
- [ ] Header/TabBar/Drawer/Settings/InputBar のアイコンが lucide で表示される。

- [ ] **Step 5: 漏れ修正があればコミット**

```bash
git add -A
git commit -m "fix(client): テーマトークン化の漏れを修正"
```
（漏れが無ければこのステップはスキップ。）

---

## Self-Review メモ（spec との突き合わせ）

- spec「テーマ層 `lib/theme.ts`＋`useTheme`」→ Task 2/3。
- spec「FOUC 防止スクリプト」→ Task 4 Step 3。
- spec「theme-color 追従」→ Task 2（`applyTheme`）＋テスト。
- spec「カラートークン表（dark 1:1 / light 派生）」→ Task 4 Step 1（追加で `--color-accent-strong`/`--color-tab-group-border`/`--color-link`/`--color-link-bg` を実コードから補完）。
- spec「SettingsModal=Dialog＋テーマ ToggleGroup＋Switch＋Slider」→ Task 5。
- spec「Header/TabBar/InputBar/ConnectionIndicator/TokenGate/ErrorBoundary/BrowserView/Terminal のトークン化＋lucide」→ Task 7/8/10/11。
- spec「モバイル Drawer=Dialog、閉じる確認=AlertDialog」→ Task 9。
- spec「テスト: theme/SettingsModal/AlertDialog 新規、既存更新、jsdom シム」→ Task 1/2/3/5/9。
- spec「完了条件: pnpm check / pnpm test グリーン、手動確認」→ Task 12。
- 型整合: `ThemeSetting`/`ResolvedTheme`（theme.ts）→ useTheme/SettingsModal/App で一貫。`useTheme()` 戻り値 `{ setting, resolved, setTheme }` を App→Main→SettingsModal(`themeSetting`/`onThemeChange`)で受け渡し、命名一致を確認済み。
- spec との差異: ErrorBoundary の `AlertTriangle` アイコンは spec で「任意」のため YAGNI で不採用（Task 11 Step 3 に明記）。
