# app-tab-focus-priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA リモートビューアで、アプリ側の選択(タブ/ワークスペース)を cmux 側の selected/focused への自動追従より優先させる。

**Architecture:** 選択解決ロジックを純粋関数 `resolveSelectedRef` に抽出し、`useCmux.ts` の3つのポーリング関数(`listWorkspaces`/`listPanes`/`listSurfaces`)で共通利用。優先順位は「アプリ選択 → cmux 初期選択 → 先頭フォールバック」。

**Tech Stack:** React 19 + TypeScript + Vitest

---

## File Structure

- **Create** `apps/client/src/lib/selection.ts` — 純粋関数 `resolveSelectedRef`(選択解決ロジック)
- **Create** `apps/client/src/lib/__tests__/selection.test.ts` — `resolveSelectedRef` のユニットテスト
- **Modify** `apps/client/src/hooks/useCmux.ts` — 3関数を `resolveSelectedRef` 呼び出しに置換

---

### Task 1: 選択解決の純粋関数とテスト

**Files:**
- Create: `apps/client/src/lib/selection.ts`
- Test: `apps/client/src/lib/__tests__/selection.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/client/src/lib/__tests__/selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { resolveSelectedRef } from '../selection'

interface Item {
  ref: string
  active: boolean
}

const getRef = (i: Item) => i.ref
const isActive = (i: Item) => i.active

describe('resolveSelectedRef', () => {
  it('初回(prev=null)は active な項目を採用する', () => {
    const list: Item[] = [
      { ref: 'a', active: false },
      { ref: 'b', active: true },
    ]
    expect(resolveSelectedRef(null, list, getRef, isActive)).toBe('b')
  })

  it('アプリ選択(prev)が存在する限り、active が別へ移っても上書きしない', () => {
    const list: Item[] = [
      { ref: 'a', active: false },
      { ref: 'b', active: true },
    ]
    expect(resolveSelectedRef('a', list, getRef, isActive)).toBe('a')
  })

  it('prev がリストから消えたら active へ退避する', () => {
    const list: Item[] = [
      { ref: 'b', active: true },
      { ref: 'c', active: false },
    ]
    expect(resolveSelectedRef('a', list, getRef, isActive)).toBe('b')
  })

  it('prev も active も無ければ先頭へフォールバックする', () => {
    const list: Item[] = [
      { ref: 'b', active: false },
      { ref: 'c', active: false },
    ]
    expect(resolveSelectedRef('a', list, getRef, isActive)).toBe('b')
  })

  it('空リストでは null を返す', () => {
    expect(resolveSelectedRef('a', [], getRef, isActive)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/selection.test.ts`
Expected: FAIL（`Failed to resolve import '../selection'` など、モジュール未作成エラー）

- [ ] **Step 3: Write minimal implementation**

`apps/client/src/lib/selection.ts`:

```ts
// ポーリングごとの選択解決。優先順位:
// 1. アプリが選択中(prev)で、それがまだリストに存在 → prev を維持(アプリ優先)
// 2. アプリ未選択(初回など) → cmux の selected/focused を初期選択として採用
// 3. どちらも無い → 先頭へフォールバック(リモートで閉じられた時の退避)
export function resolveSelectedRef<T>(
  prev: string | null,
  list: T[],
  getRef: (item: T) => string,
  isActive: (item: T) => boolean,
): string | null {
  if (prev && list.some((item) => getRef(item) === prev)) return prev
  const active = list.find(isActive)
  if (active) return getRef(active)
  return list[0] ? getRef(list[0]) : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/selection.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/selection.ts apps/client/src/lib/__tests__/selection.test.ts
git commit -m "app-tab-focus-priority: add resolveSelectedRef selection helper"
```

---

### Task 2: useCmux の3ポーリング関数を resolveSelectedRef へ置換

**Files:**
- Modify: `apps/client/src/hooks/useCmux.ts`

- [ ] **Step 1: import を追加**

`apps/client/src/hooks/useCmux.ts` の import 群(`import { getAuthToken } from './lib/token'` 付近、L11)に追加:

```ts
import { resolveSelectedRef } from '../lib/selection'
```

- [ ] **Step 2: `listWorkspaces` を置換**

現在(L76-83):

```ts
  const listWorkspaces = useCallback(async () => {
    const result = (await rpc('workspace.list')) as { workspaces: Workspace[] }
    const wsList = result.workspaces ?? []
    setWorkspaces(wsList)
    const active = wsList.find((w) => w.selected)
    if (active) setCurrentWorkspace(active.ref)
    return wsList
  }, [rpc])
```

置換後:

```ts
  const listWorkspaces = useCallback(async () => {
    const result = (await rpc('workspace.list')) as { workspaces: Workspace[] }
    const wsList = result.workspaces ?? []
    setWorkspaces(wsList)
    setCurrentWorkspace((prev) =>
      resolveSelectedRef(
        prev,
        wsList,
        (w) => w.ref,
        (w) => !!w.selected,
      ),
    )
    return wsList
  }, [rpc])
```

- [ ] **Step 3: `listPanes` を置換**

現在(L90-102):

```ts
  const listPanes = useCallback(
    async (workspaceRef?: string) => {
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      const result = (await rpc('pane.list', params)) as { panes: Pane[] }
      const paneList = result.panes ?? []
      setPanes(paneList)
      const active = paneList.find((p) => p.focused)
      if (active) setCurrentPane(active.selected_surface_ref)
      return paneList
    },
    [rpc],
  )
```

置換後:

```ts
  const listPanes = useCallback(
    async (workspaceRef?: string) => {
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      const result = (await rpc('pane.list', params)) as { panes: Pane[] }
      const paneList = result.panes ?? []
      setPanes(paneList)
      setCurrentPane((prev) =>
        resolveSelectedRef(
          prev,
          paneList,
          (p) => p.selected_surface_ref,
          (p) => !!p.focused,
        ),
      )
      return paneList
    },
    [rpc],
  )
```

- [ ] **Step 4: `listSurfaces` を置換**

現在(L112-130):

```ts
  const listSurfaces = useCallback(
    async (workspaceRef?: string) => {
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      const result = (await rpc('surface.list', params)) as { surfaces?: Surface[] }
      const list = result.surfaces ?? []
      setSurfaces(list)
      setCurrentSurface((prev) => {
        const active = list.find((s) => s.selected)
        if (active) return active.ref
        // Keep the user's selection if it still exists; otherwise fall back to
        // the first tab so a closed surface is never polled forever.
        if (prev && list.some((s) => s.ref === prev)) return prev
        return list[0]?.ref ?? null
      })
      return list
    },
    [rpc],
  )
```

置換後:

```ts
  const listSurfaces = useCallback(
    async (workspaceRef?: string) => {
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      const result = (await rpc('surface.list', params)) as { surfaces?: Surface[] }
      const list = result.surfaces ?? []
      setSurfaces(list)
      // アプリ側の選択を優先し、cmux の selected には初回のみ追従する。
      // 選択中サーフェスがリモートで閉じられたら先頭へ退避する。
      setCurrentSurface((prev) =>
        resolveSelectedRef(
          prev,
          list,
          (s) => s.ref,
          (s) => s.selected,
        ),
      )
      return list
    },
    [rpc],
  )
```

- [ ] **Step 5: 型チェックと lint**

Run: `pnpm check`
Expected: PASS（tsc エラーなし、biome エラーなし）

- [ ] **Step 6: クライアント全テスト**

Run: `cd apps/client && pnpm vitest run`
Expected: PASS（既存 + 新規 selection テスト全て成功）

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/hooks/useCmux.ts
git commit -m "app-tab-focus-priority: prioritize app selection over cmux follow in useCmux polling"
```

---

## Self-Review

- **Spec coverage:** 3関数すべて(`listWorkspaces`/`listPanes`/`listSurfaces`)を Task 2 で対応。純粋関数とテストは Task 1。グレースフルフォールバックは `resolveSelectedRef` の先頭フォールバックで担保。✓
- **Placeholder scan:** プレースホルダなし、全コード明記。✓
- **Type consistency:** `resolveSelectedRef(prev, list, getRef, isActive)` のシグネチャは Task 1 定義と Task 2 呼び出しで一致。`Pane.focused`/`Workspace.selected` は optional(`?`)のため `!!` で boolean 化、`Surface.selected` は必須 boolean。✓
