# cmux-remote-editor

[cmux](https://cmux.dev) のリモートターミナルビューア — iPhone などのブラウザ／PWA から、ローカルで動く cmux のワークスペースを閲覧・操作できます。

## 概要

ローカルマシンの cmux に Unix Domain Socket(UDS) で接続するブリッジサーバーを介して、スマホから cmux のターミナル出力の確認・タブ切替・テキスト/キー送信を行います。

```
ブラウザ / iPhone PWA  (React 19 + @wterm/react)
        │  HTTP / WebSocket
        ▼
   nginx (Docker, :48700)         ← 静的配信 + /ws,/health プロキシ
        │  WebSocket
        ▼
ブリッジサーバー (Bun + Hono, ホスト :48701)
        │  Unix Domain Socket（JSON-RPC, cmux-socket v2）
        ▼
   cmux  (~/.local/state/cmux/cmux.sock)
```

ブリッジサーバーは PWA からの JSON-RPC を cmux ソケットへ**透過的に中継**します（cmux バイナリの spawn は不要）。`surface.list` のみ `system.tree` を取得して全ペインのサーフェスへ平坦化し、`workspace_ref` で絞り込みます。

### 主な機能

- **ターミナル表示** — `@wterm/react` でレンダリング、`surface.read_text` を 1 秒間隔ポーリング（可視画面）
- **タブ操作** — サーフェス一覧の表示・切替・新規作成・クローズ（split pane 対応）
- **入力** — `InputBar` からのテキスト/キー送信
- **ジェスチャー** — `react-swipeable` + `react-use` による 2 本指スワイプでワークスペース/ペイン/サーフェス移動
- **PWA** — `vite-plugin-pwa`（autoUpdate）でホーム画面に追加可能
- **軽量** — クラウド不要、Tailscale / Cloudflare Tunnel の背後にデプロイ可能

## 前提条件

- ローカルで [cmux](https://cmux.dev) が動作していること
- [Bun](https://bun.sh)、[pnpm](https://pnpm.io)（`packageManager` 固定）、[Node.js](https://nodejs.org)
- [Docker](https://www.docker.com/)（クライアント配信に使用。Rancher Desktop 等の互換ランタイムでも可）

## セットアップ & 起動（常駐 + Docker）

ブリッジサーバーは**ホスト上のバックグラウンド常駐**、クライアント(nginx PWA)は **Docker** で動かす構成です。

> **なぜサーバーはコンテナ化しないのか**
> cmux のソケットは既定の `cmuxOnly` モードだと「cmux アプリの子孫プロセスのみ接続可」という PID 系譜チェックを行います。Docker コンテナは別プロセスツリー（macOS では VM 内）なので**常に拒否**され、さらに macOS Docker Desktop はホスト UDS の bind mount が不安定です。そのためサーバーはホストで動かし、nginx から `host.docker.internal:48701` へプロキシします。

### 1. セットアップ（初回のみ）

```bash
pnpm bootstrap
```

`pnpm bootstrap` は次をまとめて実行します:

1. `pnpm install` — 依存インストール
2. `pnpm build` — クライアントの本番ビルド
3. `pnpm cmux:allow-automation` — cmux を Automation モード(`allowAll`)に設定（`~/.config/cmux/cmux.json` を書込、元ファイルは `.bak` 退避）
4. `docker compose build` — クライアントイメージのビルド

**cmux 設定の反映**: 上記 3 の `allowAll` は、デタッチした常駐デーモンが cmux に拒否されないために必須です（`cmuxOnly` のままだとデーモンは launchd に里子に出され系譜を失い拒否されます）。`cmux reload-config` だけでは起動済みソケットに反映されないため、**次のいずれか**で有効化してください:

- cmux **Settings → Automation → socket mode** を「Automation mode」に切替（ライブ反映）、または
- **cmux を再起動**（`cmux.json` の値が起動時に適用される）

> **セキュリティ**: `allowAll` は同一 macOS ユーザの任意のローカルプロセスが cmux を操作できるようにします。信頼できるマシンでのみ使用してください。元に戻すには `pnpm cmux:revert-automation`（同様に再起動/Settings で反映）。

### 2. 起動 / 停止

cmux 端末（任意のタブ）から実行します。

```bash
pnpm start    # サーバーをホスト常駐起動 + クライアントを Docker 起動
pnpm stop     # 両方停止
```

起動後、ブラウザ/iPhone から **http://<ホスト>:48700** を開きます（Safari なら「ホーム画面に追加」で PWA 化）。

### サーバー単体の管理

```bash
pnpm server:up        # バックグラウンド常駐起動（ログ: apps/server/.run/server.log）
pnpm server:status    # 稼働確認
pnpm server:logs      # ログ追従
pnpm server:restart   # 再起動
pnpm server:down      # 停止
```

## 開発

```bash
pnpm install
pnpm dev      # turbo: サーバー(bun --watch) + クライアント(vite) を同時起動
```

Vite 開発サーバーが `/ws`・`/health` を `localhost:48701` にプロキシします。開発時はサーバーが cmux 端末の子プロセスとして動くため、cmux のモードは `cmuxOnly` のままでも接続できます。

### テスト / 静的解析

```bash
pnpm test        # turbo: サーバー(bun test) + クライアント(vitest)
pnpm check       # tsc + biome
pnpm lint        # biome lint
```

## 設定（環境変数）

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `48701` | ブリッジサーバーのポート |
| `CMUX_SOCKET_PATH` | ポインタファイルから自動解決（既定 `~/.local/state/cmux/cmux.sock`） | cmux Unix ソケットのパス |

ソケットパスは `CMUX_SOCKET_PATH` → `~/.local/state/cmux/last-socket-path` / `~/Library/Application Support/cmux/last-socket-path` のポインタファイル → 既定パス、の順で解決されます。

## ルートの主なスクリプト

| コマンド | 内容 |
|---|---|
| `pnpm bootstrap` | 依存インストール + ビルド + cmux Automation 設定 + Docker イメージビルド |
| `pnpm start` / `pnpm stop` | サーバー常駐 + クライアント Docker の起動 / 停止 |
| `pnpm server:up\|down\|status\|restart\|logs` | ホストのサーバーデーモン管理 |
| `pnpm cmux:allow-automation` / `pnpm cmux:revert-automation` | cmux の `socketControlMode` を `allowAll` / `cmuxOnly` に設定 |
| `pnpm dev` | 開発モード（サーバー watch + Vite） |

## プロジェクト構成

```
apps/
  server/                 # Bun + Hono ブリッジサーバー
    src/
      index.ts            # エントリ（HTTP/WS/静的配信）
      ws.ts               # WebSocket ⇄ cmux UDS 中継（surface.list は system.tree から整形）
      cmux-client.ts      # cmux UDS クライアント（ヘルスチェック用）
      socket-path.ts      # ソケットパス解決
      health.ts           # GET /health
  client/                 # React 19 + Vite PWA
    src/
      components/         # Header, Drawer, StatusBar, TabBar, InputBar, Terminal
      hooks/              # useCmux, useWebSocket, useGesture
      lib/cmux-rpc.ts     # JSON-RPC 型とヘルパー
    nginx.conf            # 静的配信 + /ws,/health をホスト :48701 へプロキシ
scripts/
  set-cmux-socket-mode.mjs # cmux automation.socketControlMode パッチ
compose.yml               # client(nginx) のみ
```

## ライセンス

[MIT](LICENSE)
