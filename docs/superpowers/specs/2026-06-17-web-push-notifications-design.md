# Web Push 通知（MVP）設計

- 日付: 2026-06-17
- タスク slug: `web-push-notifications`
- ステータス: 設計承認済み（実装計画フェーズへ）

## ゴール

PWA で cmux の actionable な通知（「ask user」「権限要求」など）が発生したとき、Service Worker の Web Push を使って、**アプリを閉じていても** iPhone にモバイルのプッシュ通知として表示する。タップで該当ワークスペースへディープリンクする。

## スコープ決定（ブレインストーミングで確定）

- **push 対象**: actionable のみ（Drawer の `deriveStatus` で「Needs input」「Permission」に該当する未読通知）。完了/Idle 通知は push しない。
- **タップ挙動**: 該当ワークスペースへディープリンク（`App.tsx` の変更は最小限）。
- **検証バー**: 純粋ロジックのユニットテスト ＋ `pnpm check` / `pnpm test` green ＋ iPhone 実機での手動検証手順を `result.md` に記載。実機の自動 E2E は対象外。

### YAGNI で除外

通知のグルーピング / 既読同期、複数ユーザー、VAPID 鍵ローテーション UI、ポーリング間隔の設定 UI（env のみ）、push 失敗のリトライキュー。

## 背景・制約

- cmux は push してこない（UDS の request/response のみ。サーバー側に event/notification ハンドラなし）。→ **Bun サーバーが cmux を常時バックグラウンドでポーリング**して新着 unread を検知し Web Push を送る必要がある。
- サーバーは host 常駐デーモン（`pnpm server:up`）。Docker 不可（cmux ソケットの PID 系譜チェック）。本番は HTTPS/WSS・127.0.0.1 束縛・nginx で TLS 終端（mkcert）。dev は HTTP（Vite が :48701 へプロキシ）。
- Web Push は secure context（HTTPS）必須。**dev（HTTP）では動かない** → クライアントは feature-detect で非対応時にトグルを無効化する。
- iOS PWA Web Push の前提: ホーム画面追加済み PWA + iOS 16.4+ + ユーザージェスチャでの許可。
- 認証は WS 共有トークン（`apps/server/src/auth.ts`: env `CMUX_REMOTE_TOKEN` → `.run/token`、`timingSafeEqual`）。push エンドポイントも同トークンで保護する。
- 並列タスク（新規ワークスペースボタン）が別 worktree で進行中。共有ファイル（`useCmux.ts` / `App.tsx`）への変更は最小限にし、マージ衝突を避ける。本設計では `useCmux.ts` は変更しない。

## アーキテクチャ / データフロー

```
[サーバー常駐] PushPoller ──(専用 cmux 接続, ~10秒間隔)──> notification.list
      │  actionable & 未 push の新着のみ抽出（seen-set で dedup）
      ▼
   web-push (VAPID + aes128gcm) ──> 各 PushSubscription の endpoint（Apple/FCM 等の push service）
      ▼
[iPhone] Service Worker 'push' イベント ──> showNotification（アプリを閉じていても表示）
      │ タップ
      ▼
'notificationclick' ──> 開いている PWA に postMessage / なければ openWindow('/?workspace=<id>')
      ▼
[PWA] URL param / SW message を読んで該当 workspace を選択（App.tsx 最小変更）
```

**採用アプローチ**: ポーラーを既存 Bun サーバー（host 常駐デーモン）に内蔵する。

- 不採用 A: WS 中継への相乗り。WS は接続時のみ存在し、アプリを閉じると動かない＝要件不適合。
- 不採用 B: 別プロセス/別デーモン化。Bun サーバーが既に host 常駐デーモンなので過剰（YAGNI）。

## サーバー側コンポーネント（`apps/server/src/`、新規）

クラスは使わず関数 + クロージャで構成する（CLAUDE.md 規約）。

| モジュール | 責務 | 主な公開関数 |
|---|---|---|
| `push/vapid.ts` | VAPID 鍵の生成・読込。`.run/push-vapid.json` に永続（なければ `generateVAPIDKeys()`）。 | `loadOrCreateVapidKeys()`, `getVapidPublicKey()` |
| `push/store.ts` | 購読 `.run/push-subscriptions.json`（endpoint で重複排除）と push 済み id 集合 `.run/push-seen.json` の永続化。 | `addSubscription`, `removeSubscription`, `listSubscriptions`, `seenHas`, `seenAdd`, `seedSeen` |
| `push/filter.ts` | **純粋関数**。actionable 判定（Drawer の `deriveStatus` と同等ロジックをサーバーに再実装）と新着抽出。 | `isActionable(n)`, `selectNewPushable(list, seen)` |
| `push/payload.ts` | **純粋関数**。通知 → push payload JSON。 | `buildPayload(n): string` |
| `push/send.ts` | `web-push` ラッパ。送信と失効購読の掃除（410/404 → store から削除）。 | `sendToAll(payload)` |
| `push/poller.ts` | 専用 cmux 接続で `notification.list` を ~10秒間隔ポーリング。新着 actionable を送信。 | `startPoller()`, `stopPoller()`, `refreshPollerState()` |
| `push/routes.ts` | Hono ルート。全て共有トークン保護。 | `pushRoutes` (Hono), `requirePushToken` ミドルウェア |
| `push/rpc-connection.ts` | ポーラー用の薄い JSON-RPC ラッパ（id 相関、UTF-8 安全な行フレーミング）。 | `createRpcConnection()` / `request(method, params)` |

### ポーラーの挙動

- **起動条件**: 購読が 1 件以上のときのみ稼働。0 件になったら停止（`refreshPollerState()` を subscribe/unsubscribe 時に呼ぶ）。
- **起動時 seed**: 最初の `notification.list` で取得した既存通知 id を全て seen に登録し、**バックログを一斉送信しない**。以降のサイクルで seen に無い actionable のみ送る。
- **間隔**: env `CMUX_PUSH_POLL_MS`（既定 10000）。
- **cmux 切断**: 例外を捕捉して当該サイクルをスキップし、次サイクルで再接続を試みる（致命的にしない）。
- **UTF-8 安全**: 通知本文（日本語）がチャンク境界で割れて U+FFFD 化しないよう、Buffer レベルの `\n` 分割 / `StringDecoder` で行フレーミングする（CLAUDE.md の既知の落とし穴）。共有 `cmux-client.ts` は health 用途で変更しない。

### HTTP ルートと認証

- `GET /push/vapid-public-key` → `{ publicKey }` を返す。
- `POST /push/subscribe` → body の PushSubscription を store に追加（endpoint で重複排除）→ `refreshPollerState()`。
- `POST /push/unsubscribe` → body の endpoint を store から削除 → `refreshPollerState()`。
- 共通ミドルウェア `requirePushToken`: `Authorization: Bearer <token>` を `tokenEquals` で検証。失敗は 401。
- `index.ts` に Hono ルートのマウントと、起動時の VAPID 初期化・ポーラー起動を追加（数行）。

## PWA / Service Worker（generateSW → injectManifest 移行）

`push` / `notificationclick` ハンドラ追加のため injectManifest へ移行する。

- `vite.config.ts`: `strategies: 'injectManifest'`, `srcDir: 'src'`, `filename: 'sw.ts'`（`registerType: 'autoUpdate'` 維持）。`injectManifest` 用に `globPatterns` を移設。
- 新規 `apps/client/src/sw.ts`:
  - `precacheAndRoute(self.__WB_MANIFEST)`。
  - **現状の offline 挙動を再現**: `registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/ws/, /^\/health/] }))`。
  - `push` リスナ: `event.data?.json()` → `self.registration.showNotification(title, { body, data, badge, icon, tag })`。
  - `notificationclick` リスナ: 既存クライアントを探して `client.focus()` + `postMessage({ type: 'navigate', workspaceId })`、無ければ `clients.openWindow('/?workspace=' + workspaceId)`。
- devDeps 追加: `workbox-precaching`, `workbox-routing`（client）/ `web-push`（server）。
- 既存の `registerSW({ immediate: true })`（`main.tsx`）は維持。

## クライアント購読フロー / 設定 UI

- 新規 `apps/client/src/lib/push.ts`:
  - `urlBase64ToUint8Array(base64)`（**純粋・ユニットテスト対象**）。
  - `isPushSupported()`: `isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window`。
  - `subscribeToPush()`: `Notification.requestPermission()` → `GET /push/vapid-public-key` → `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` → `POST /push/subscribe`。
  - `unsubscribeFromPush()`: `getSubscription()?.unsubscribe()` → `POST /push/unsubscribe`。
  - fetch には `Authorization: Bearer <getAuthToken()>` を付与。
- `lib/settings.ts`: `cmux:push-enabled`（boolean）の load/save を追加。
- `components/SettingsModal.tsx`: 「通知を有効にする」トグルを追加。
  - トグル ON 操作（ユーザージェスチャ）で `subscribeToPush()`、OFF で `unsubscribeFromPush()`。
  - 非対応環境（dev HTTP 等）はトグルを無効化し理由を表示。
  - 実際の購読状態は `pushManager.getSubscription()` で確認して初期表示に反映。
- `App.tsx`（**最小変更**、配置は実装時に確認）:
  - マウント時に `?workspace=` を読み、存在すれば該当 WS を選択。
  - `navigator.serviceWorker` の `message`（`{ type: 'navigate', workspaceId }`）を購読して該当 WS を選択。
  - いずれも既存の workspace 選択関数を呼ぶだけ。`useCmux.ts` は変更しない。

## エラーハンドリング

- **失効購読**: `web-push` の送信 reject で `statusCode === 410 || 404` の場合、当該購読を store から削除。
- **cmux 切断**: ポーラーがサイクル内で捕捉し、次サイクルで再接続。
- **VAPID 未初期化**: 起動時に必ず生成・読込するため通常発生しない。鍵ファイル破損時はログを出して再生成しない（既存購読が無効化されるのを避けるため、手動対応に委ねる）。
- **クライアント permission 拒否**: トグルを OFF 状態に戻し、説明を表示。

## データ永続化（`apps/server/.run/`、gitignore 済み）

- `push-vapid.json`: `{ publicKey, privateKey }`（一度生成したら再利用）。
- `push-subscriptions.json`: `PushSubscription[]`（endpoint で一意）。
- `push-seen.json`: push 済み通知 id の配列。

## 環境変数

- `CMUX_PUSH_POLL_MS`（既定 `10000`）: ポーリング間隔。
- `CMUX_PUSH_SUBJECT`（既定 `mailto:cmux-remote@example.com`）: VAPID subject。

## テスト戦略（TDD、純粋ロジックから）

- **server（bun test）**:
  - `push/filter.test.ts`: `isActionable`（Needs input / Permission のみ true、完了/その他 false、is_read=true は除外）、`selectNewPushable`（seen に無い actionable のみ抽出）。
  - `push/payload.test.ts`: `buildPayload` の構造（title/body/data.workspace_id/url）。
  - `push/store.test.ts`: temp dir で add/remove/dedup（同一 endpoint 重複排除）、seen の has/add/seed の round-trip。
  - `push/routes.test.ts`: `requirePushToken` の 401/通過。
  - `push/send` は `web-push` の `generateRequestDetails` で有効なリクエストが生成されることを確認（実送信なし）。Bun での `web-push` 動作確認を兼ねる。
- **client（vitest）**:
  - `lib/__tests__/push.test.ts`: `urlBase64ToUint8Array` の変換正当性。
- `pnpm check`（tsc + biome）と `pnpm test` を green に。

## 手動 iOS 検証手順（result.md に記載）

1. 本番相当を起動（`pnpm start`）。iPhone で PWA をホーム画面に追加（iOS 16.4+）。
2. 設定モーダル → 「通知を有効にする」を ON → 許可を付与。
3. cmux 側で actionable 通知（権限要求 / ask user 等）を発火。
4. PWA を閉じた状態でも iPhone にプッシュ通知が表示されることを確認。
5. 通知をタップ → PWA が開き、該当ワークスペースが選択されることを確認。
6. dev（HTTP）では Web Push が動作しない（secure context 必須）ことを明記。

## 想定ファイル変更一覧

新規（server）: `src/push/vapid.ts`, `store.ts`, `filter.ts`, `payload.ts`, `send.ts`, `poller.ts`, `routes.ts`, `rpc-connection.ts` ＋各テスト。
変更（server）: `src/index.ts`（ルートマウント + ポーラー起動）, `package.json`（`web-push` 追加）。
新規（client）: `src/sw.ts`, `src/lib/push.ts` ＋テスト。
変更（client）: `vite.config.ts`（injectManifest）, `src/lib/settings.ts`（push-enabled）, `src/components/SettingsModal.tsx`（トグル）, `App.tsx`（ディープリンク最小追加）, `package.json`（workbox-* 追加）。
変更（docs）: `CLAUDE.md`（Web Push 構成の追記）。
