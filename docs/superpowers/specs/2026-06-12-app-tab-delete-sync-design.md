# app-tab-delete-sync 設計

## 背景 / ユーザー要望

> 「アプリでタブ消せない、アプリでタブ消したら cmux 本体も消えたりすることは可能か、可能なら対応したい」

PWA でタブを削除しても何も起きない。アプリでのタブ削除を、ローカル cmux 本体のサーフェス削除に同期させたい。

## 根本原因（ライブソケットで実証）

タブクローズの配線は既に存在していた:

- `TabBar.tsx:70` — × ボタン `onClick={() => onClose(surface.ref)}`
- `App.tsx:212` — `onClose` → `closeSurface(ref, currentWorkspace)`
- `useCmux.ts:144` — `closeSurface` → `rpc('surface.close', { surface_ref: surfaceRef })`

`surface.close` は実在する cmux RPC メソッド（`cmux capabilities` で確認）。問題は**パラメータ名の不一致**。

実際に動く CLI `cmux close-surface --surface <ref>` を UDS ミラーで捕捉したワイヤー:

```json
{"method":"surface.close","params":{"surface_id":"surface:40","workspace_id":"<UUID>"}}
```

cmux ソケットは **`surface_id`** を読む。アプリは `surface_ref` を送っていたため param が無視され、フォーカス中のサーフェスにフォールバック（「Cannot close the last surface」エラーの原因）。

実証結果:
- `surface.close {"surface_id":"surface:42"}` → 対象サーフェスが消えた ✅（`surface_id` 単独で十分、短縮 ref を値として受理）
- `surface.close {"surface_ref":...}` / `{"surface":...}`（UUID・短縮 ref とも）→ 無視される ❌

## 変更内容

| 対象 | 変更 |
|---|---|
| `apps/client/src/hooks/useCmux.ts` `closeSurface` | RPC パラメータ名 `surface_ref` → `surface_id`（値は短縮 ref のまま） |
| `apps/server/src/ws.ts` | **変更なし**。`surface.close` は既に素通し。クライアントが正しい param を送れば動く |
| `apps/client/src/hooks/__tests__/useCmux.test.ts`（新規） | 回帰テスト: `closeSurface` が `method:'surface.close', params:{surface_id:<ref>}` を送ることを検証 |

## 検証

- `cd apps/client && pnpm vitest run`（新規回帰テスト含む）
- `pnpm check`（tsc + biome）
- サーバー無変更のため `cd apps/server && bun test` が緑を維持することを確認

## スコープ外 / 注意

- `surface.read_text` / `surface.send_text` / `surface.send_key` は `surface_ref` を使用中だが本タスクのスコープ外（要望はタブ削除のみ）。別途検証推奨として result.md に記載。
- 同時実行タスク `app-tab-focus-priority`（`useCmux.ts` を編集）と衝突しうる。変更は `closeSurface` の1行のみに限定し、result.md に明記。
