# close-workspace-feature 設計

## 背景

cmux リモートビューア (PWA) には、ワークスペースの新規作成・切替はあるが「閉じる（削除）」手段がない。ユーザー要望: 「ワークスペースを閉じる機能がないので追加」。

## スコープ判断（「閉じる」の解釈）

**採用: cmux 同期型（cmux 側のワークスペースを実際に閉じる）。**

根拠:
- 既存の `closeSurface` は cmux 同期型（`surface.close` RPC を cmux ソケットへ送る）。一貫性のため同じ方針を採る。
- 「閉じる」の自然な意味は cmux 側の実クローズ。表示のみ非表示にすると `workspace.list` が cmux 由来のためリロードで復活してしまい、要望を満たさない。

## 実機プローブで確認した事実

cmux ソケット (`/Users/yui/.local/state/cmux/cmux-501.sock`) を非破壊的に probe（架空 ID 使用）した結果:

- `workspace.close` RPC は**存在する**（`method_not_found` ではなく `invalid_params`）。パラメータキーは `workspace_id`。
- 値の形式は `workspace.select` と**同一**を受理する:
  - 短縮 ref `workspace:N`（実在リストに対し解決）
  - フル UUID（不在なら `not_found`）
- 既存 `selectWorkspace` が `ws.ref`（短縮 ref）を渡して動作しているため、`closeWorkspace` も `ws.ref` で動く。
- サーバー `ws.ts` は `surface.list`/`surface.create` 以外を透過中継するため、**サーバー変更は不要**。

## アーキテクチャ

既存の `closeSurface` + `listSurfaces` パターンをワークスペース単位に写し取る。

### 1. Hook 層 (`apps/client/src/hooks/useCmux.ts`)

`closeWorkspace(workspaceRef)` を追加:

```ts
const closeWorkspace = useCallback(
  async (workspaceRef: string) => {
    await rpc('workspace.close', { workspace_id: workspaceRef })
    if (workspaceRef === currentWorkspace) {
      setSurfaces([])
      setCurrentSurface(null)
      setPanes([])
      setCurrentPane(null)
    }
    return listWorkspaces()
  },
  [rpc, listWorkspaces, currentWorkspace],
)
```

- cmux ソケットの `workspace.close` は `workspace_id` を読む（`workspace_ref` は無視）。値は短縮 ref を受理。
- 現在のワークスペースを閉じた場合、フォールバックが確定するまで旧 WS のタブ/画面が残らないよう surface/pane 状態を即クリア（`selectWorkspace` と同じ理由）。
- 戻り値 `listWorkspaces()` → `resolveSelectedRef` がフォールバックを自動処理。

#### フォールバック挙動（`resolveSelectedRef` による）

- **現在の WS を閉じた**: `prev` ref がリストから消える → cmux が auto-select した `selected` WS（無ければ先頭）へ追従。App の effect が新 WS の surfaces を取得。
- **非現在の WS を閉じた**: `prev` がリストに残る → 現在維持。表示に影響なし。
- **最後の WS を閉じた**: リスト空 → `currentWorkspace = null`、surfaces 空（既存の null 処理で graceful）。

`closeWorkspace` を return オブジェクトに追加して export する。

### 2. UI 層 (`apps/client/src/components/Drawer.tsx`)

- `DrawerProps` に `onCloseWorkspace: (ref: string) => void` を追加し、`WorkspaceList` → `WorkspaceItem` へ伝播。
- `WorkspaceItem`: 現在は行全体が単一 `<button>`。これをフレックスコンテナ化し `[選択ボタン(flex:1), close ボタン]` の構成にする（`TabBar` の × ボタンと同パターン。ボタンはネスト不可のため兄弟要素にする）。
- **インライン2段階確認**: `WorkspaceItem` 内に `useState` で `confirming` を持つ。
  - 通常: 小さな `×` ボタン（`#777`、`aria-label="Close workspace"`）。
  - `×` タップ → `setConfirming(true)`（`stopPropagation` で行の選択/ドロワー閉じを抑止）。
  - confirming 中: `✓`（確定, 危険色 `#e74c3c`, `aria-label="Confirm close"`）と `✕`（取消, ミュート, `aria-label="Cancel close"`）。
  - `✓` → `onCloseWorkspace(ws.ref)`。`✕` → `setConfirming(false)`。
- ワークスペース close 時にドロワー（モバイルオーバーレイ）は閉じない（一覧更新を見せるため `onClose` は呼ばない）。

### 3. `App.tsx`

`useCmux` から `closeWorkspace` を取り出し、`<Drawer>` に配線:

```tsx
onCloseWorkspace={(ref) => {
  closeWorkspace(ref).catch((err) => console.error('[app] close workspace error:', err))
}}
```

## テスト (TDD, vitest)

### `apps/client/src/hooks/__tests__/useCmux.test.ts`（追記）

`describe('useCmux closeWorkspace')`:

1. `workspace.close` を `{ workspace_id: ref }` で送る（`workspace_ref` を含まない）。
2. 現在の WS を閉じた後、`workspace.list` の selected フォールバックで `currentWorkspace` が残りの WS へ移る。
3. 非現在の WS を閉じても `currentWorkspace` が維持される。
4. 現在の WS を閉じると `surfaces` がクリアされる。

### `apps/client/src/components/__tests__/Drawer.test.tsx`（新規）

破壊的操作の確認担保:

1. `×` を 1 回タップしただけでは `onCloseWorkspace` が呼ばれない。
2. `×` → `✓`（確定）で初めて `onCloseWorkspace(ref)` が呼ばれる。
3. `×` → `✕`（取消）で `onCloseWorkspace` は呼ばれない。

## 非対象 (YAGNI)

- ワークスペースの新規作成 UI（要望外）。
- アンドゥ/ゴミ箱。
- 外側クリックでの確認自動キャンセル（取消ボタンで足りる）。
- サーバー (`ws.ts`) の変更（透過中継で対応済み）。

## スタイル制約

- Biome: シングルクォート、セミコロンなし、行幅 120。`pnpm check`（tsc + biome）を通す。
- `any`/`unknown`/`class` を使わない。ハードコードを避ける。
- Surgical Changes: 自タスク範囲のみ変更。
