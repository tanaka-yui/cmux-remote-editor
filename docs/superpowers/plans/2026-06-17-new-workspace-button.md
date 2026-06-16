# New Workspace Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cmux リモートビューア (PWA) のドロワー下部に「新規ワークスペース」ボタンを追加し、タップで cmux に新WSを作成・自動追従表示する。

**Architecture:** `workspace.create` RPC（実機プローブ確認済み・空パラメータで動作）を `useCmux` に `createWorkspace()` として追加。返り値 `workspace_ref` を既存 `selectWorkspace` で追従選択。`Drawer` に固定フッターボタン `NewWorkspaceButton`（連打防止の `creating` state 付き）を追加し、`App` で配線。サーバー (`ws.ts`) は透過中継のため改変なし。

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, Biome（シングルクォート・セミコロンなし・120幅）。

---

## File Structure

- `apps/client/src/hooks/useCmux.ts` — 修正: `createWorkspace()` を追加し return に含める。
- `apps/client/src/hooks/__tests__/useCmux.test.ts` — 追記: `createWorkspace` の RPC 検証。
- `apps/client/src/components/Drawer.tsx` — 修正: `NewWorkspaceButton` 追加、`DrawerProps` に `onNewWorkspace` 追加、両 `<nav>` ブランチへ配置。
- `apps/client/src/components/__tests__/Drawer.test.tsx` — 追記: フッターボタンの描画とクリック検証（既存 `renderDrawer` に必須 prop 追加）。
- `apps/client/src/App.tsx` — 修正: `createWorkspace` を destructure し `<Drawer onNewWorkspace=...>` を配線。

---

## Task 1: `useCmux` に `createWorkspace` を追加

**Files:**
- Test: `apps/client/src/hooks/__tests__/useCmux.test.ts`（`describe('useCmux closeWorkspace')` ブロックの後ろに追記）
- Modify: `apps/client/src/hooks/useCmux.ts`

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/hooks/__tests__/useCmux.test.ts` の末尾（最後の `describe(...)` の閉じ `})` の後）に追記:

```ts
describe('useCmux createWorkspace', () => {
  const findReq = (method: string) =>
    hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, unknown> })
      .find((req) => req.method === method)

  it('workspace.create を送り、返り値 workspace_ref で workspace.select を送る', async () => {
    hoisted.responses['workspace.create'] = { workspace_ref: 'workspace:NEW' }
    hoisted.responses['workspace.list'] = {
      workspaces: [
        { id: 'old', ref: 'workspace:OLD', title: 'Old', index: 0, selected: true },
        { id: 'new', ref: 'workspace:NEW', title: 'New', index: 1, selected: false },
      ],
    }

    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.createWorkspace()
    })

    // workspace.create は空パラメータで送る（既定ディレクトリの新規WSを作る）
    const createReq = findReq('workspace.create')
    expect(createReq).toBeDefined()
    expect(createReq?.params).toEqual({})

    // 返り値 workspace_ref を使い cmux 側も追従選択する
    const selectReq = findReq('workspace.select')
    expect(selectReq?.params).toEqual({ workspace_id: 'workspace:NEW' })

    // アプリ側の currentWorkspace も新WSへ切り替わる
    expect(result.current.currentWorkspace).toBe('workspace:NEW')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: FAIL（`result.current.createWorkspace is not a function`）

- [ ] **Step 3: `createWorkspace` を実装**

`apps/client/src/hooks/useCmux.ts` の `selectWorkspace` の `useCallback` 閉じ（`)` の行、現状 117 行目あたり）の直後に追加:

```ts
  const createWorkspace = useCallback(async () => {
    // workspace.create は ws.ts が透過中継する。空パラメータで既定ディレクトリの新規WS
    // (+ターミナル surface 1つ)を作る。cmux 側は新WSを自動選択しないため、返り値の
    // workspace_ref を既存 selectWorkspace で追従選択する(非選択WSは read_text 不可)。
    const result = (await rpc('workspace.create')) as { workspace_ref?: string }
    const list = await listWorkspaces()
    if (result.workspace_ref) selectWorkspace(result.workspace_ref)
    return list
  }, [rpc, listWorkspaces, selectWorkspace])
```

そして return オブジェクト（現状 304 行目以降）の `selectWorkspace,` の直後に `createWorkspace,` を追加:

```ts
    listWorkspaces,
    selectWorkspace,
    createWorkspace,
    listPanes,
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: PASS（全ケース）

- [ ] **Step 5: コミット**

```bash
git add apps/client/src/hooks/useCmux.ts apps/client/src/hooks/__tests__/useCmux.test.ts
git commit -m "feat(client): useCmux に createWorkspace を追加（workspace.create→select 追従）"
```

---

## Task 2: `Drawer` に `NewWorkspaceButton` を追加

**Files:**
- Test: `apps/client/src/components/__tests__/Drawer.test.tsx`
- Modify: `apps/client/src/components/Drawer.tsx`

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/components/__tests__/Drawer.test.tsx` を修正する。

(1) import 行に `act` を追加:

```ts
import { act, fireEvent, render, screen } from '@testing-library/react'
```

(2) 既存 `renderDrawer` に必須 prop `onNewWorkspace` を追加（既存テストを壊さないためのデフォルトモック）:

```ts
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
      onNewWorkspace={vi.fn().mockResolvedValue(undefined)}
      onClose={() => {}}
    />,
  )
  return onCloseWorkspace
}
```

(3) ファイル末尾に新しい describe を追記:

```ts
describe('Drawer new workspace button', () => {
  function renderWithNewWorkspace(onNewWorkspace: () => Promise<void>) {
    render(
      <Drawer
        open
        workspaces={[ws]}
        currentWorkspace="workspace:A"
        notifications={[]}
        onSelect={() => {}}
        onCloseWorkspace={() => {}}
        onNewWorkspace={onNewWorkspace}
        onClose={() => {}}
      />,
    )
  }

  it('フッターに新規ワークスペースボタンを描画する', () => {
    renderWithNewWorkspace(vi.fn().mockResolvedValue(undefined))
    expect(screen.getByLabelText('New workspace')).toBeDefined()
  })

  it('クリックで onNewWorkspace を呼ぶ', async () => {
    const onNewWorkspace = vi.fn().mockResolvedValue(undefined)
    renderWithNewWorkspace(onNewWorkspace)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('New workspace'))
    })
    expect(onNewWorkspace).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/Drawer.test.tsx`
Expected: FAIL（型エラー `onNewWorkspace` が `DrawerProps` に無い／`getByLabelText('New workspace')` が見つからない）

- [ ] **Step 3: `Drawer.tsx` を実装**

`apps/client/src/components/Drawer.tsx` を修正する。

(1) `DrawerProps` に `onNewWorkspace` を追加（`onCloseWorkspace` の下）:

```ts
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
```

(2) `WorkspaceList` 関数定義の閉じ `}` の直後（`export { DESKTOP_BREAKPOINT, SIDEBAR_WIDTH }` の前）に `NewWorkspaceButton` を追加:

```tsx
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
        borderTop: '1px solid #1e2a42',
        color: creating ? '#888' : '#e0e0e0',
        fontSize: 12,
        fontWeight: 600,
        textAlign: 'left',
        cursor: creating ? 'default' : 'pointer',
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
      {creating ? '作成中…' : '新規ワークスペース'}
    </button>
  )
}
```

(3) `Drawer` の引数 destructure に `onNewWorkspace` を追加:

```tsx
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
```

(4) デスクトップブランチの `<nav>` 内、`{sidebarContent}` の直後にボタンを追加:

```tsx
        {sidebarContent}
        <NewWorkspaceButton onNewWorkspace={onNewWorkspace} />
      </nav>
```

(5) モバイルブランチの `<nav>` 内、`{sidebarContent}` の直後にも同じく追加:

```tsx
        {sidebarContent}
        <NewWorkspaceButton onNewWorkspace={onNewWorkspace} />
      </nav>
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/Drawer.test.tsx`
Expected: PASS（既存の2段階確認テスト＋新規ボタンテスト全て）

- [ ] **Step 5: コミット**

```bash
git add apps/client/src/components/Drawer.tsx apps/client/src/components/__tests__/Drawer.test.tsx
git commit -m "feat(client): ドロワー下部に新規ワークスペースボタンを追加"
```

---

## Task 3: `App.tsx` で配線

**Files:**
- Modify: `apps/client/src/App.tsx`

App は単体テストを持たないため、TDD ではなく `tsc`/ビルドで検証する。

- [ ] **Step 1: `createWorkspace` を destructure に追加**

`apps/client/src/App.tsx` の `useCmux()` destructure（`closeWorkspace,` の行）の直後に追加:

```tsx
    closeWorkspace,
    createWorkspace,
    focusSurface,
```

- [ ] **Step 2: `<Drawer>` に `onNewWorkspace` を配線**

`<Drawer ...>` の `onCloseWorkspace={...}` の直後に追加:

```tsx
        onCloseWorkspace={(ref) => {
          closeWorkspace(ref).catch((err) => console.error('[app] close workspace error:', err))
        }}
        onNewWorkspace={() =>
          createWorkspace()
            .then(() => setDrawerOpen(false))
            .catch((err) => console.error('[app] create workspace error:', err))
        }
        onClose={() => setDrawerOpen(false)}
```

- [ ] **Step 3: 型チェックと Lint を通す**

Run: `pnpm check`
Expected: PASS（tsc --noEmit + biome、エラー 0）

- [ ] **Step 4: クライアントの全テストを実行**

Run: `cd apps/client && pnpm vitest run`
Expected: PASS（全テストファイル）

- [ ] **Step 5: コミット**

```bash
git add apps/client/src/App.tsx
git commit -m "feat(client): App に新規ワークスペースボタンを配線"
```

---

## Task 4: 最終検証

- [ ] **Step 1: ルートで型チェック＋Lint**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 2: ビルド確認（PWA バンドル）**

Run: `pnpm --filter @cmux-remote/client build`
Expected: ビルド成功（型エラー無し）

> 注: フィルタ名はパッケージ名に依存。失敗したら `pnpm build` をルートで実行する。

- [ ] **Step 3: 差分レビュー**

Run: `git diff main --stat` および `git log --oneline main..HEAD`
Expected: 変更は `useCmux.ts` / `useCmux.test.ts` / `Drawer.tsx` / `Drawer.test.tsx` / `App.tsx` / 設計ドキュメントのみ。

---

## Self-Review（計画作成者による確認）

**1. Spec coverage:**
- ✅ `workspace.create` RPC・空パラメータ → Task 1
- ✅ 自動追従選択（`selectWorkspace`）→ Task 1
- ✅ 固定フッターボタン配置（両ブランチ）→ Task 2
- ✅ 連打防止（`creating` state）→ Task 2
- ✅ 作成後ドロワーを閉じる → Task 3
- ✅ エラーは `.catch` でログ → Task 3
- ✅ サーバー改変なし（透過中継）→ 全タスクで cmux ソケットへ素通し
- ✅ テスト（useCmux RPC 検証 / Drawer 描画・クリック）→ Task 1・2

**2. Placeholder scan:** プレースホルダ無し。全ステップに実コード・実コマンド・期待出力あり。

**3. Type consistency:**
- `createWorkspace: () => Promise<Workspace[]>`（`listWorkspaces()` の戻り値を返す）。App は `.then(() => ...)` で戻り値を無視 ＝ 整合。
- `onNewWorkspace: () => Promise<void>` を `DrawerProps`・`NewWorkspaceButton`・`renderWithNewWorkspace`・App 配線で一貫使用。App の配線は `Promise<void>`（`.then(...).catch(...)` で reject しない）。
- `aria-label="New workspace"` をボタン実装とテストクエリで一致。

## Notes

- 後始末: プローブ作成の `workspace:16`（"Terminal"）が実機 cmux に残存。実装完了後にユーザー確認のうえ `workspace.close` で削除する（破壊的操作のため要承認）。
- マージ衝突配慮: `useCmux.ts`・`App.tsx` の変更は加算的に最小化。
