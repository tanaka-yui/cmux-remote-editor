# new-workspace-button 設計

## 背景

cmux リモートビューア (PWA) のドロワー（サイドバー）には、ワークスペースの一覧・切替・閉じる手段はあるが「新規作成」する手段がない。要望: ドロワーに「新規ワークスペースを起動」ボタンを追加し、タップで cmux 側に新WSを作成、PWA がそれに追従して表示を切り替える。

## 実機プローブで確認した事実

cmux ソケット (`/Users/yui/.local/state/cmux/cmux-501.sock`) へ JSON-RPC を直接 probe した結果:

- `workspace.create` RPC は**存在する**。**空パラメータ `{}` で動作**し、既定ディレクトリの新規ワークスペース（＋ターミナル surface 1つ）を作成する。
- 返り値: `{ workspace_ref, workspace_id, surface_ref, surface_id, window_ref, window_id }`。`workspace_ref`（例 `workspace:16`）は `selectWorkspace` にそのまま渡せる短縮 ref。
- **cmux 側は新WSを自動選択しない**: 作成直後 `workspace.list` で新WSは `selected=false` のままだった。非選択WSは `surface.read_text` できない制約があるため、PWA で中身を表示するには明示的な `workspace.select` が必須。
- 架空メソッド (`workspace.__nope__`) は cmux 由来の `method_not_found` を返した ＝ サーバー `ws.ts` は未知メソッドを透過中継しており、**サーバー変更は不要**。

## 設計判断（ユーザー確認済み）

- **ボタン配置**: ドロワー下部に固定フッターボタン（「＋ 新規ワークスペース」ラベル付き）。モバイルではドロワーにヘッダーが無くデスクトップのみ表示されるため、両環境で常に見えるフッターが最適。
- **作成後の挙動**: 新WSを自動選択して追従表示し、（モバイルでは）ドロワーを閉じる。既存のワークスペース選択と同一の挙動（`workspace.select` で実機 cmux 側も追従）。

## アーキテクチャ

既存の `createSurface` / `selectWorkspace` パターンを写し取る。サーバー改変なし。

### 1. Hook 層 (`apps/client/src/hooks/useCmux.ts`)

`selectWorkspace` の直後に `createWorkspace()` を追加:

```ts
const createWorkspace = useCallback(async () => {
  // workspace.create は ws.ts が透過中継。空パラメータで既定ディレクトリの新規WS
  // (+ターミナル surface 1つ)を作る。cmux 側は新WSを自動選択しないため、返り値の
  // workspace_ref を既存 selectWorkspace で追従選択する(非選択WSは read_text 不可)。
  const result = (await rpc('workspace.create')) as { workspace_ref?: string }
  const list = await listWorkspaces()
  if (result.workspace_ref) selectWorkspace(result.workspace_ref)
  return list
}, [rpc, listWorkspaces, selectWorkspace])
```

- `listWorkspaces()` を先に呼び、新WSを一覧へ反映してから `selectWorkspace` で追従選択する。`selectWorkspace` が `currentWorkspace` を新 ref に更新 → App の既存 effect が新 `currentWorkspace` の panes/surfaces を取得して表示する。
- `selectWorkspace` には `if (ref === currentWorkspace) return` ガードがあるが、新 ref は現在と一致しないため通過する。
- `createWorkspace` を return オブジェクトに追加して export する。

### 2. UI 層 (`apps/client/src/components/Drawer.tsx`)

- `DrawerProps` に `onNewWorkspace: () => Promise<void>` を追加。
- 小コンポーネント `NewWorkspaceButton({ onNewWorkspace })` を新設:
  - ローカル `useState` で `creating` を持ち、**作成中は `disabled`・ラベルを「作成中…」に切替**（連打で複数WSが作られるのを防ぐ）。
  - `onClick`: `creating` なら無視。`setCreating(true)` → `await onNewWorkspace()` → `finally { setCreating(false) }`。
  - スタイルは既存ドロワーに合わせる（背景 `#0f1729`、上ボーダー `1px solid #1e2a42`、文字 `#e0e0e0`、全幅、`paddingBottom: env(safe-area-inset-bottom)` でホームインジケータ回避）。`type="button"`。
- 配置: デスクトップ／モバイル両方の `<nav>` 内で、`sidebarContent`（`flex:1, overflowY:auto` の `<ul>`）の**後**に兄弟要素として置く。これで一覧はスクロール、ボタンは下部に固定される。両ブランチで同一 JSX を共有するため、`NewWorkspaceButton` を 1 度定義して両所に描画する。

### 3. 配線 (`App.tsx`)

`useCmux` の destructure に `createWorkspace` を追加し、`<Drawer>` に配線:

```tsx
onNewWorkspace={() =>
  createWorkspace()
    .then(() => setDrawerOpen(false))
    .catch((err) => console.error('[app] create workspace error:', err))
}
```

- 戻り値は `Promise<void>`（reject しない）。`NewWorkspaceButton` がこれを await して `creating` を解除する。
- 作成完了後に `setDrawerOpen(false)` でドロワーを閉じる（モバイル／デスクトップ共通。既存の workspace 選択時 `onClose` と整合）。

## データフロー

タップ → ボタン disabled＋「作成中…」 → `workspace.create` → `workspace.list` 再取得（新WSが一覧に出現）→ `workspace.select`（cmux 追従）→ `setDrawerOpen(false)` → App effect が新 `currentWorkspace` の surfaces を取得 → 新ターミナル表示 → ボタン再有効化。

## エラーハンドリング

- `App.tsx` の `.catch` でログのみ（既存の `createSurface` / `closeWorkspace` と同方針）。
- 失敗時は現WS据え置き、ボタンは `finally` で再有効化。

## テスト (TDD, vitest)

### `apps/client/src/hooks/__tests__/useCmux.test.ts`（追記）

`describe('useCmux createWorkspace')`:

1. `workspace.create` を送る（その後 `workspace.list` を送る）。
2. `workspace.create` の返り値 `workspace_ref` を使って `workspace.select` を `{ workspace_id: <新ref> }` で送る。

### `apps/client/src/components/__tests__/Drawer.test.tsx`（追記）

1. フッターボタン（「新規ワークスペース」）が描画される。
2. クリックで `onNewWorkspace` が呼ばれる。

## 非対象 (YAGNI)

- ディレクトリ選択 UI（`workspace.create {}` の既定挙動で足りる。CLI も引数なしで動く）。
- ワークスペース名/色の指定。
- サーバー (`ws.ts`) の変更（透過中継で対応済み）。

## マージ衝突への配慮

並列タスク（web-push 通知）が同一 worktree 外で `useCmux.ts` / `App.tsx` に触れる可能性がある。本タスクの変更は加算的（`useCmux.ts`＝1関数追加、`App.tsx`＝destructure 1語＋prop 1つ）に留め、変更の中心を `Drawer.tsx` の新規部分に置く。

## スタイル制約

- Biome: シングルクォート、セミコロンなし、行幅 120。`pnpm check`（tsc + biome）を通す。
- `any`/`unknown`/`class` を使わない。ハードコードを避ける。
- Surgical Changes: 自タスク範囲のみ変更。
