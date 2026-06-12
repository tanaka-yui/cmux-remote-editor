# close-workspace-feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA のサイドバー（ワークスペース一覧）からワークスペースを閉じる機能を追加し、cmux 側のワークスペースも実際に閉じる（cmux 同期型）。

**Architecture:** 既存の `closeSurface`（cmux 同期型）パターンをワークスペース単位に写し取る。`useCmux` に `closeWorkspace` RPC を追加し、`Drawer` の各ワークスペース行に2段階確認付きの close ボタンを追加、`App` で配線する。フォールバックは `listWorkspaces()` → `resolveSelectedRef` が自動処理。サーバー (`ws.ts`) は透過中継のため変更不要。

**Tech Stack:** React 19, TypeScript, vitest + @testing-library/react (jsdom), Biome。cmux JSON-RPC over WebSocket。

---

## File Structure

- **Modify** `apps/client/src/hooks/useCmux.ts` — `closeWorkspace(workspaceRef)` を追加し export。
- **Modify** `apps/client/src/hooks/__tests__/useCmux.test.ts` — `closeWorkspace` のテストを追記。
- **Modify** `apps/client/src/components/Drawer.tsx` — `WorkspaceItem` に2段階確認付き close ボタン、`onCloseWorkspace` prop を追加。
- **Create** `apps/client/src/components/__tests__/Drawer.test.tsx` — 2段階確認のテスト。
- **Modify** `apps/client/src/App.tsx` — `closeWorkspace` を取り出し `<Drawer onCloseWorkspace>` に配線。

実機プローブ済み事実: `workspace.close` RPC は cmux ソケットに存在し、パラメータ `workspace_id`、値は `workspace.select` と同じ短縮 ref を受理する。

---

## Task 1: useCmux に closeWorkspace を追加（TDD）

**Files:**
- Test: `apps/client/src/hooks/__tests__/useCmux.test.ts`（末尾に追記）
- Modify: `apps/client/src/hooks/useCmux.ts:181-189`（`closeSurface` の直後に追加）, `:266-290`（return に追加）

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/hooks/__tests__/useCmux.test.ts` の末尾（最終行 `})` の後）に追記:

```ts
describe('useCmux closeWorkspace', () => {
  const findReq = (method: string) =>
    hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, unknown> })
      .find((req) => req.method === method)

  it('workspace.close を workspace_id パラメータで送る（ref ではなく id キー）', async () => {
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.closeWorkspace('workspace:B')
    })
    const req = findReq('workspace.close')
    expect(req).toBeDefined()
    expect(req?.params).toEqual({ workspace_id: 'workspace:B' })
    expect(req?.params).not.toHaveProperty('workspace_ref')
  })

  it('現在のワークスペースを閉じると、残りの selected ワークスペースへフォールバックする', async () => {
    hoisted.responses['workspace.list'] = {
      workspaces: [
        { id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true },
        { id: 'w2', ref: 'workspace:B', title: 'B', index: 1 },
      ],
    }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.listWorkspaces()
    })
    expect(result.current.currentWorkspace).toBe('workspace:A')

    // A を閉じた後の workspace.list は B のみ（cmux が B を selected にする）。
    hoisted.responses['workspace.list'] = {
      workspaces: [{ id: 'w2', ref: 'workspace:B', title: 'B', index: 1, selected: true }],
    }
    await act(async () => {
      await result.current.closeWorkspace('workspace:A')
    })
    expect(result.current.currentWorkspace).toBe('workspace:B')
  })

  it('非現在のワークスペースを閉じても currentWorkspace は維持される', async () => {
    hoisted.responses['workspace.list'] = {
      workspaces: [
        { id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true },
        { id: 'w2', ref: 'workspace:B', title: 'B', index: 1 },
      ],
    }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.listWorkspaces()
    })
    expect(result.current.currentWorkspace).toBe('workspace:A')

    // B を閉じた後の list は A のみ（A は selected 維持）。
    hoisted.responses['workspace.list'] = {
      workspaces: [{ id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true }],
    }
    await act(async () => {
      await result.current.closeWorkspace('workspace:B')
    })
    expect(result.current.currentWorkspace).toBe('workspace:A')
  })

  it('現在のワークスペースを閉じると surfaces/currentSurface をクリアする', async () => {
    hoisted.responses['workspace.list'] = {
      workspaces: [{ id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true }],
    }
    hoisted.responses['surface.list'] = {
      surfaces: [{ index: 0, ref: 'surface:a1', selected: true, title: 'a1', type: 'terminal' }],
    }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.listWorkspaces()
      await result.current.listSurfaces('workspace:A')
    })
    expect(result.current.surfaces).toHaveLength(1)
    expect(result.current.currentSurface).toBe('surface:a1')

    // A を閉じた後の list は空（最後の WS）。
    hoisted.responses['workspace.list'] = { workspaces: [] }
    await act(async () => {
      await result.current.closeWorkspace('workspace:A')
    })
    expect(result.current.surfaces).toEqual([])
    expect(result.current.currentSurface).toBeNull()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: FAIL（`result.current.closeWorkspace is not a function`）

- [ ] **Step 3: 最小実装を書く**

`apps/client/src/hooks/useCmux.ts` の `closeSurface`（189 行目の `)` の直後、`readText` の前）に追加:

```ts
  const closeWorkspace = useCallback(
    async (workspaceRef: string) => {
      // cmux ソケットの workspace.close は `workspace_id` を読む（`workspace_ref` は無視）。
      // 値は workspace.select と同じく短縮 ref を受理する（実機プローブで確認）。
      await rpc('workspace.close', { workspace_id: workspaceRef })
      // 現在のワークスペースを閉じた場合、フォールバックが確定するまで旧 WS のタブ・
      // ターミナル内容が残らないよう即座にクリアする（selectWorkspace と同じ理由）。
      if (workspaceRef === currentWorkspace) {
        setSurfaces([])
        setCurrentSurface(null)
        setPanes([])
        setCurrentPane(null)
      }
      // listWorkspaces → resolveSelectedRef が、閉じた WS が現在だった場合は cmux が
      // auto-select した別 WS（無ければ先頭）へ、非現在なら現在維持でフォールバックする。
      return listWorkspaces()
    },
    [rpc, listWorkspaces, currentWorkspace],
  )
```

そして return オブジェクト（`closeSurface,` の行の直後）に追加:

```ts
    closeWorkspace,
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: PASS（既存テスト含め全件）

- [ ] **Step 5: コミット**

```bash
git add apps/client/src/hooks/useCmux.ts apps/client/src/hooks/__tests__/useCmux.test.ts
git commit -m "close-workspace-feature: add closeWorkspace RPC to useCmux"
```

---

## Task 2: Drawer に2段階確認付き close ボタンを追加（TDD）

**Files:**
- Create: `apps/client/src/components/__tests__/Drawer.test.tsx`
- Modify: `apps/client/src/components/Drawer.tsx:1`（import）, `:6-13`（DrawerProps）, `:84-239`（WorkspaceItem）, `:241-273`（WorkspaceList）, `:277-288`（Drawer）

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/components/__tests__/Drawer.test.tsx` を新規作成:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Workspace } from '../../lib/cmux-rpc'
import { Drawer } from '../Drawer'

const ws: Workspace = { id: 'w1', ref: 'workspace:A', title: 'Alpha', index: 0 }

function renderDrawer() {
  const onCloseWorkspace = vi.fn()
  render(
    <Drawer
      open
      workspaces={[ws]}
      currentWorkspace="workspace:A"
      notifications={[]}
      onSelect={() => {}}
      onCloseWorkspace={onCloseWorkspace}
      onClose={() => {}}
    />,
  )
  return onCloseWorkspace
}

describe('Drawer close workspace (2 段階確認)', () => {
  it('× を 1 回押しただけでは onCloseWorkspace を呼ばない', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    expect(onCloseWorkspace).not.toHaveBeenCalled()
  })

  it('× → 確定で onCloseWorkspace(ref) を呼ぶ', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    fireEvent.click(screen.getByLabelText('Confirm close'))
    expect(onCloseWorkspace).toHaveBeenCalledWith('workspace:A')
  })

  it('× → 取消で onCloseWorkspace を呼ばず、閉じるボタンへ戻る', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    fireEvent.click(screen.getByLabelText('Cancel close'))
    expect(onCloseWorkspace).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Close workspace')).toBeDefined()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/Drawer.test.tsx`
Expected: FAIL（`onCloseWorkspace` prop が未定義 / `Close workspace` ボタンが見つからない）

- [ ] **Step 3: 実装 — import に useState を追加**

`apps/client/src/components/Drawer.tsx` の 1 行目を置換:

```tsx
import { useState } from 'react'

import type { CmuxNotification, Workspace } from '../lib/cmux-rpc'
```

- [ ] **Step 4: 実装 — DrawerProps に onCloseWorkspace を追加**

`DrawerProps` interface（`onSelect` の直後）に追加:

```tsx
interface DrawerProps {
  open: boolean
  workspaces: Workspace[]
  currentWorkspace: string | null
  notifications: CmuxNotification[]
  onSelect: (id: string) => void
  onCloseWorkspace: (ref: string) => void
  onClose: () => void
}
```

- [ ] **Step 5: 実装 — WorkspaceItem をフレックス化し close ボタンを追加**

`WorkspaceItem` 関数（`function WorkspaceItem({...}) { ... }` 全体、84〜239 行）を以下に置換:

```tsx
function WorkspaceItem({
  ws,
  index,
  isCurrent,
  unreadCount,
  notification,
  onClick,
  onCloseWorkspace,
}: {
  ws: Workspace
  index: number
  isCurrent: boolean
  unreadCount: number
  notification?: CmuxNotification
  onClick: () => void
  onCloseWorkspace: (ref: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const color = ws.custom_color ?? paletteColor(index)
  const folder = folderName(ws.current_directory)
  const status = deriveStatus(notification)

  // Truncate notification body for preview
  const notifPreview = notification?.body
    ? notification.body.slice(0, 60) + (notification.body.length > 60 ? '...' : '')
    : null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: isCurrent ? 'rgba(255, 255, 255, 0.08)' : 'none',
        borderLeft: `3px solid ${isCurrent ? color || '#64ffda' : 'transparent'}`,
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
          color: '#e0e0e0',
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer',
          alignItems: 'flex-start',
        }}
      >
        {/* Color dot */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: color,
            flexShrink: 0,
            marginTop: 4,
          }}
        />

        {/* Content */}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {/* Title */}
          <span
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: isCurrent ? '#fff' : '#ccc',
              fontWeight: isCurrent ? 600 : 400,
            }}
          >
            {ws.title || ws.ref}
          </span>

          {/* Notification preview */}
          {notifPreview && (
            <span
              style={{
                display: 'block',
                fontSize: 10,
                color: '#999',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 1,
              }}
            >
              {notifPreview}
            </span>
          )}

          {/* Status badge */}
          {status && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 10,
                color: status.color,
                marginTop: 2,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: status.color,
                }}
              />
              {status.label}
            </span>
          )}

          {/* Folder path */}
          {folder && (
            <span
              style={{
                display: 'block',
                fontSize: 10,
                color: '#555',
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

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span
            style={{
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor:
                status?.label === 'Needs input' || status?.label === 'Permission' ? status.color : '#e74c3c',
              color: '#fff',
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

      {/* Close affordance: inline 2-step confirm (ワークスペース close は破壊的なため) */}
      {confirming ? (
        <>
          <button
            type="button"
            onClick={() => onCloseWorkspace(ws.ref)}
            aria-label="Confirm close"
            style={{
              background: 'none',
              border: 'none',
              color: '#e74c3c',
              fontSize: 15,
              fontWeight: 700,
              lineHeight: 1,
              padding: '0 6px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            &#10003;
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            aria-label="Cancel close"
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              fontSize: 15,
              lineHeight: 1,
              padding: '0 8px 0 2px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            &times;
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label="Close workspace"
          style={{
            background: 'none',
            border: 'none',
            color: '#777',
            fontSize: 16,
            lineHeight: 1,
            padding: '0 10px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          &times;
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 6: 実装 — WorkspaceList で onCloseWorkspace を伝播**

`WorkspaceList` 関数を以下に置換（destructure に `onCloseWorkspace` を追加し、`WorkspaceItem` へ渡す）:

```tsx
function WorkspaceList({
  workspaces,
  currentWorkspace,
  notifications,
  onSelect,
  onCloseWorkspace,
  onClose,
}: Omit<DrawerProps, 'open'>) {
  const unreadCounts = unreadCountByWorkspace(notifications)
  const latestNotifs = latestNotificationByWorkspace(notifications)

  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: '4px 0',
        flex: 1,
        overflowY: 'auto',
      }}
    >
      {workspaces.map((ws, i) => (
        <li key={ws.ref} style={{ borderBottom: '1px solid #1a2340' }}>
          <WorkspaceItem
            ws={ws}
            index={i}
            isCurrent={ws.ref === currentWorkspace}
            unreadCount={unreadCounts.get(ws.id) ?? 0}
            notification={latestNotifs.get(ws.id)}
            onClick={() => {
              onSelect(ws.ref)
              onClose()
            }}
            onCloseWorkspace={onCloseWorkspace}
          />
        </li>
      ))}
      {workspaces.length === 0 && <li style={{ padding: '12px 16px', color: '#666', fontSize: 12 }}>No workspaces</li>}
    </ul>
  )
}
```

- [ ] **Step 7: 実装 — Drawer で onCloseWorkspace を受け取り WorkspaceList へ渡す**

`Drawer` 関数のシグネチャと `sidebarContent` を以下に置換:

```tsx
export function Drawer({
  open,
  workspaces,
  currentWorkspace,
  notifications,
  onSelect,
  onCloseWorkspace,
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
    />
  )
```

（以降の desktop/mobile レンダリング部分は変更なし。）

- [ ] **Step 8: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/Drawer.test.tsx`
Expected: PASS（3 件）

- [ ] **Step 9: コミット**

```bash
git add apps/client/src/components/Drawer.tsx apps/client/src/components/__tests__/Drawer.test.tsx
git commit -m "close-workspace-feature: add 2-step confirm close button to Drawer"
```

---

## Task 3: App で closeWorkspace を配線

**Files:**
- Modify: `apps/client/src/App.tsx:44-64`（useCmux destructure）, `:261-270`（Drawer 配線）

- [ ] **Step 1: useCmux から closeWorkspace を取り出す**

`apps/client/src/App.tsx` の `useCmux()` destructure に `closeWorkspace` を追加（`closeSurface,` の直後）:

```tsx
    createSurface,
    closeSurface,
    closeWorkspace,
    focusSurface,
```

- [ ] **Step 2: Drawer に onCloseWorkspace を配線**

`<Drawer>` の `onSelect` の直後に追加:

```tsx
      <Drawer
        open={drawerOpen}
        workspaces={workspaces}
        currentWorkspace={currentWorkspace}
        notifications={notifications}
        onSelect={(ref) => {
          selectWorkspace(ref)
        }}
        onCloseWorkspace={(ref) => {
          closeWorkspace(ref).catch((err) => console.error('[app] close workspace error:', err))
        }}
        onClose={() => setDrawerOpen(false)}
      />
```

- [ ] **Step 3: 既存の App テストが通ることを確認**

`App.test.tsx` の useCmux モックには `closeWorkspace` が無いが、`onCloseWorkspace` はユーザー操作時のみ呼ばれるため初期レンダリングには影響しない。確認:

Run: `cd apps/client && pnpm vitest run src/__tests__/App.test.tsx`
Expected: PASS

- [ ] **Step 4: 型チェック・Lint・全テストを通す**

Run: `pnpm check`
Expected: tsc・biome 共にエラーなし

Run: `cd apps/client && pnpm vitest run`
Expected: 全テスト PASS

- [ ] **Step 5: コミット**

```bash
git add apps/client/src/App.tsx
git commit -m "close-workspace-feature: wire closeWorkspace into App/Drawer"
```

---

## Task 4: 実機エンドツーエンド検証（任意・非破壊）

**目的:** `workspace.close` の round-trip を実環境で確認する。実ワークスペースを誤って消さないよう、検証用のスクラッチ手段で行う。

- [ ] **Step 1: `pnpm dev` でアプリを起動し、サイドバーから検証用に作成したワークスペース（または影響の少ないもの）を × → 確定で閉じる。**

確認項目:
- 一覧から該当ワークスペースが消える。
- 現在のワークスペースを閉じた場合、別ワークスペースへ自動で切り替わり、そのタブ／ターミナルが表示される。
- 非現在のワークスペースを閉じた場合、表示中のワークスペースは変わらない。

（自動テストで論理は担保済みのため、本タスクは環境がある場合のみ実施。実施しない場合もコミット済みの実装で完了とする。）

---

## Self-Review

- **Spec coverage:** Hook (`closeWorkspace`) = Task 1。UI (close ボタン + 2段階確認) = Task 2。App 配線 = Task 3。フォールバック挙動 = Task 1 のテスト 2/3/4。サーバー変更不要 = 透過中継で対応（タスクなし）。全 spec 項目をカバー。
- **Placeholder scan:** TBD/TODO なし。全ステップに実コード・実コマンド・期待出力あり。
- **Type consistency:** `closeWorkspace(workspaceRef: string)`、`onCloseWorkspace: (ref: string) => void`、`workspace.close` の param `{ workspace_id }` は全タスクで一致。`WorkspaceItem` の新 prop `onCloseWorkspace` は Task 2 内で定義・伝播・配線が整合。
