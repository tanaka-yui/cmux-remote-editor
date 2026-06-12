# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

cmux のリモートターミナルビューア。iPhone 等のブラウザ/PWA から、ローカルで動く cmux を閲覧・操作する。pnpm workspace + Turborepo のモノレポで、`apps/server`（Bun + Hono のブリッジサーバー）と `apps/client`（React 19 + Vite PWA）の 2 パッケージ構成。

## コマンド

```bash
pnpm install
pnpm dev          # turbo: サーバー(bun --watch, :48701) + クライアント(vite, :5173) 同時起動
pnpm build        # turbo run build
pnpm test         # turbo: サーバー(bun test) + クライアント(vitest)。test は build に依存
pnpm check        # tsc --noEmit + biome check（両パッケージ）
pnpm check:fix    # biome check --write
pnpm lint         # biome lint
```

単一テストの実行:

```bash
cd apps/server && bun test src/__tests__/auth.test.ts        # サーバー（bun test）
cd apps/client && pnpm vitest run src/lib/__tests__/cmux-rpc.test.ts  # クライアント（vitest）
```

運用（本番相当の常駐構成）:

```bash
pnpm bootstrap       # 初回のみ: install + build + cmux allowAll 設定 + docker compose build
pnpm start / stop    # サーバーをホスト常駐起動 + クライアント(nginx)を Docker 起動 / 両方停止
pnpm server:up|down|status|restart|logs   # ホスト常駐サーバーの管理（ログ: apps/server/.run/server.log）
```

## アーキテクチャ

```
ブラウザ/PWA → nginx (Docker :48710 https / :48700 は https へ 301) → ブリッジサーバー (Bun, ホスト :48701 — 本番は HTTPS/WSS・127.0.0.1 束縛 / dev は HTTP) → cmux UDS (JSON-RPC)
```

TLS は nginx で終端する。証明書は mkcert 製（`pnpm certs:setup` → `certs/`、gitignore 済み、compose の volume で nginx にマウント）。**本番では Bun ブリッジも同じ証明書で TLS 終端する**（`CMUX_REMOTE_TLS=1` を `server:up` が付与、証明書パスは `CMUX_TLS_CERT`/`CMUX_TLS_KEY` で上書き可・既定は `certs/`）。Bun は `127.0.0.1` のみに束縛し（`CMUX_BIND_HOST` で上書き可・既定 loopback）LAN からの直接到達を遮断するため、nginx→Bun を含め平文区間は残らない。nginx は `proxy_pass https://host.docker.internal:48701` + `proxy_ssl_verify off`（mkcert に `host.docker.internal` SAN が無く、かつホスト内ホップのため検証なし＝機密性のみ確保）。**開発モード（`pnpm dev`）は `CMUX_REMOTE_TLS` 未設定で HTTP のまま**、nginx の代わりに Vite dev サーバー(:5173)が `/ws`・`/health` を :48701 にプロキシする。Docker(VM) が loopback の Bun に到達できない環境では `CMUX_BIND_HOST=0.0.0.0` にフォールバック（その場合も TLS は維持される）。

### 重要な制約: サーバーは Docker に入れられない

cmux ソケットは既定の `cmuxOnly` モードで「cmux の子孫プロセスのみ接続可」という PID 系譜チェックを行うため、コンテナ（別プロセスツリー）からの接続は常に拒否される。そのためサーバーはホストで動かし、Docker は nginx クライアントのみ（`compose.yml` 参照）。常駐デーモン運用には cmux を `allowAll` にする必要があり（`pnpm cmux:allow-automation`）、設定は cmux の再起動か Settings → Automation での切替で初めて反映される。開発時（`pnpm dev`）はサーバーが cmux 端末の子プロセスなので `cmuxOnly` のままで動く。

### サーバー (`apps/server/src/`)

- `index.ts` — エントリ。`Bun.serve` で WS upgrade（`/ws`、トークン必須）・Hono ルート（`/health`、クライアント静的配信）を振り分け。
- `ws.ts` — 中核。ブラウザ WS ⇄ cmux UDS の JSON-RPC 透過中継。WS 接続ごとに cmux への UDS 接続を 1 本張る。例外的に書き換える RPC が 2 つ:
  - `surface.list` → `system.tree` に変換し、応答を全ペインのサーフェスに平坦化して `{ surfaces }` に整形（ソケット側の `surface.list` は `workspace_ref` を無視するため）。
  - `surface.create` → `type: 'terminal', focus: true` のデフォルトを注入。
  - cmux ソケットが閉じたら WS を code 1011 で閉じ、クライアントの再接続にフォールバックさせる。
- `auth.ts` — WS 共有トークン。優先順: 環境変数 `CMUX_REMOTE_TOKEN`（`apps/server/.env` も Bun が自動読込）→ `apps/server/.run/token`（無ければ自動生成・永続化）。比較は `timingSafeEqual`。
- `socket-path.ts` — cmux ソケットパス解決。`CMUX_SOCKET_PATH` → `last-socket-path` ポインタファイル（XDG state / Application Support）→ 既定パスの順。
- `health.ts` — `GET /health`。cmux への接続を 1 本使い回す（ポーリングによる接続チャーン防止）。

### クライアント (`apps/client/src/`)

- `hooks/useCmux.ts` — 中核。WS 上に Promise ベースの RPC 層（pending Map + 10 秒タイムアウト）を構築し、workspace/pane/surface の状態と操作を提供。**タブ切替は PWA 側の表示のみ変更し、ローカル cmux のペインフォーカスは奪わない**（`surface.focus` RPC は使わない設計）。**ワークスペース切替は `workspace.select` で cmux 側も追従させる** — cmux は選択中ワークスペース以外のターミナルを `read_text` できない（`internal_error`）ため、追従なしでは別ワークスペースのライブ表示が不可能。注意: cmux ソケットの surface 系 RPC（read_text/send_text/send_key/close）はパラメータ `surface_id` を読む。`surface_ref` は無視され、フォーカス中サーフェスへ暗黙にフォールバックする。`terminal.replay` の `render_grid` は `active_screen`（`'primary'` / `'alternate'`＝代替スクリーン）と `modes`（端末の DECSET モード状態 `{ code, ansi, on }[]`）も返す。**タップ→マウス送信の有効化は `modes` で判定する**: `1000`/`1002`/`1003`（マウストラッキング: クリック/ドラッグ/モーション報告）のいずれかが `on` なら端末がマウス入力を受け付ける状態、`1006` が `on` なら SGR 拡張座標形式（`\x1b[<Cb;Col;RowM`/`m`）。`active_screen='alternate'` 単独より正確で、マウス未設定の TUI（`mouse=` 無しの nvim や lazygit）への誤爆を避けられる。なお `terminal.replay` は `read_text` と違い、選択中ワークスペース以外のサーフェスでも `render_grid` を返す（実機確認済み）。
- `components/Terminal.tsx` — `@wterm/react` でレンダリング。可視サーフェスを `surface.read_text` で 1 秒間隔ポーリング。
- `lib/token.ts` — URL の `?token=` を localStorage に保存（URL は書き換えない）。WS 接続 URL に常に付与。
- PWA は `vite-plugin-pwa`（autoUpdate）。workbox の `navigateFallbackDenylist` で `/ws`・`/health` を Service Worker から除外している — プロキシ対象のパスを増やす場合はここにも追加が必要。

## コードスタイル

- Biome（`biome.json`）: シングルクォート、セミコロンなし（asNeeded）、行幅 120。コミット前に `pnpm check` を通すこと。
- `package.json` の並び順は `sort-package-json` で管理（`pnpm sort-package:fix`）。
