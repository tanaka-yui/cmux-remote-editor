# cmux-remote-editor

[cmux](https://cmux.dev) のリモートターミナルビューア — iPhone などのブラウザ／PWA から、ローカルで動く cmux のワークスペースを閲覧・操作できます。

## 概要

ローカルマシンの cmux に Unix Domain Socket(UDS) で接続するブリッジサーバーを介して、スマホから cmux のターミナル出力の確認・タブ切替・テキスト/キー送信を行います。

```
ブラウザ / iPhone PWA  (React 19 + @wterm/react)
        │  HTTP / WebSocket
        ▼
   nginx (Docker, :48710 TLS / :48700→https)   ← TLS 終端 + 静的配信 + /ws,/health プロキシ
        │  WebSocket
        ▼
ブリッジサーバー (Bun + Hono, ホスト :48701)
        │  Unix Domain Socket（JSON-RPC, cmux-socket v2）
        ▼
   cmux  (~/.local/state/cmux/cmux.sock)
```

ブリッジサーバーは PWA からの JSON-RPC を cmux ソケットへ**透過的に中継**します（cmux バイナリの spawn は不要）。`surface.list` のみ `system.tree` を取得して全ペインのサーフェスへ平坦化し、`workspace_ref` で絞り込みます。

### 主な機能

- **ターミナル表示** — `@wterm/react` でレンダリング。`terminal.replay` の `render_grid`（色・属性・カーソルを保持）を 1 秒間隔ポーリングし `renderGridToAnsi` で ANSI 化して忠実描画。全角は 2:1 等幅フォント（M PLUS 1 Code）で cmux と文字幅が一致
- **タブ操作** — サーフェス一覧の表示・切替・新規作成・クローズ（split pane 対応）。ブラウザサーフェスは iframe 表示
- **入力 / キーボード** — `InputBar` のコマンド入力＋特殊キーに加え、⌨ で開く **US ANSI フルキーボード**（記号・ワンショット修飾キー Ctrl/Opt/Shift・矢印）。特殊キーは生エスケープシーケンスを `send_text`
- **タッチ操作** — 一本指でネイティブスクロール（慣性付き）、一本指タップ=左クリック・二本指タップ=右クリック（マウス対応 TUI に SGR 送信）、二本指ピンチでフォント増減
- **履歴 / オフライン** — スクロールバック履歴モード（取得行数は設定モーダルで 1000〜100000 行に調整可）、最後の画面を localStorage にキャッシュして切断中も表示
- **PWA** — `vite-plugin-pwa`（autoUpdate）でホーム画面に追加可能
- **軽量** — クラウド不要、Tailscale / Cloudflare Tunnel の背後にデプロイ可能

## 前提条件

- ローカルで [cmux](https://cmux.dev) が動作していること
- [Bun](https://bun.sh)、[pnpm](https://pnpm.io)（`packageManager` 固定）、[Node.js](https://nodejs.org)
- [Docker](https://www.docker.com/)（クライアント配信に使用。Rancher Desktop 等の互換ランタイムでも可）
- [mkcert](https://github.com/FiloSottile/mkcert)（HTTPS 用のローカル CA・証明書生成。`brew install mkcert`）

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
2. `pnpm certs:setup` — mkcert で TLS 証明書を生成（`certs/` に出力。SAN は `<ホスト名>.local`・localhost・現在の LAN IP）
3. `pnpm build` — クライアントの本番ビルド
4. `pnpm cmux:allow-automation` — cmux を Automation モード(`allowAll`)に設定（`~/.config/cmux/cmux.json` を書込、元ファイルは `.bak` 退避）
5. `docker compose build` — クライアントイメージのビルド

**cmux 設定の反映**: 上記 4 の `allowAll` は、デタッチした常駐デーモンが cmux に拒否されないために必須です（`cmuxOnly` のままだとデーモンは launchd に里子に出され系譜を失い拒否されます）。`cmux reload-config` だけでは起動済みソケットに反映されないため、**次のいずれか**で有効化してください:

- cmux **Settings → Automation → socket mode** を「Automation mode」に切替（ライブ反映）、または
- **cmux を再起動**（`cmux.json` の値が起動時に適用される）

> **セキュリティ**: `allowAll` は同一 macOS ユーザの任意のローカルプロセスが cmux を操作できるようにします。信頼できるマシンでのみ使用してください。元に戻すには `pnpm cmux:revert-automation`（同様に再起動/Settings で反映）。

### 2. 起動 / 停止

cmux 端末（任意のタブ）から実行します。

```bash
pnpm start    # サーバーをホスト常駐起動 + クライアントを Docker 起動
pnpm stop     # 両方停止
```

起動後、ブラウザ/iPhone から **https://<ホスト名>.local:48710/?token=<認証トークン>** を開きます（Safari なら「ホーム画面に追加」で PWA 化）。`http://<ホスト>:48700` へのアクセスはクエリを保持したまま https へ 301 リダイレクトされます。iPhone では先に下記「HTTPS / iPhone への証明書インストール」で mkcert のルート CA を信頼させてください。

> **認証トークン**: ブリッジサーバーは LAN から到達可能かつ cmux が `allowAll` のため、WebSocket 接続に共有トークンを必須としています。トークンは初回起動時に自動生成され `apps/server/.run/token` に保存されます（`pnpm start` の完了メッセージにトークン付き URL が表示されます。`pnpm server:logs` でも確認可）。一度 `?token=...` 付きで開けばブラウザに保存されるので、以降は素の URL でアクセスできます。トークンを固定したい場合は環境変数 `CMUX_REMOTE_TOKEN` を設定するか、`apps/server/.env` に `CMUX_REMOTE_TOKEN=...` を書いてください（Bun が起動時に自動読込。ファイルが無ければ自動生成にフォールバック）。なお本番では nginx⇔ブリッジ間も TLS（WSS/HTTPS）で保護され、ブリッジサーバー (:48701) は `127.0.0.1` のみに束縛されるため LAN から直接到達できません（経路上に平文区間は残りません。トークン認証も必須）。開発モード（`pnpm dev`）はローカルホスト内で完結するため HTTP のままです。

> **Mac のスリープについて**: ホストの Mac がスクリーンロックや蓋閉じでスリープに入ると cmux のレンダリングが止まり、リモートからのライブ表示も更新されなくなります。ロック中もレンダリングを継続したい場合は、[KeepingYouAwake](https://keepingyouawake.app/) などのスリープを防止するアプリの利用をおすすめします。

### 3. HTTPS / iPhone への証明書インストール

TLS は Docker 内の nginx で終端し、本番ではホスト側 Bun ブリッジも同じ mkcert 証明書で TLS 終端します（nginx→Bun も暗号化）。証明書は mkcert のローカル CA で発行され（`pnpm certs:setup`、`pnpm bootstrap` に含まれます）、Mac 側は `mkcert -install` で自動的に信頼されます。

iPhone で `https://<ホスト名>.local:48710` を開くには、mkcert のルート CA を一度だけ信頼させます:

1. `certs/rootCA.pem` を AirDrop などで iPhone へ送る
2. 設定アプリ → 「プロファイルがダウンロードされました」→ インストール
3. 設定 → 一般 → 情報 → 証明書信頼設定 → 当該 CA（mkcert ...）のスイッチを ON
4. Safari で `https://<ホスト名>.local:48710/?token=<認証トークン>` を開き、「ホーム画面に追加」

> **移行時の注意**: 旧 `http://<ホスト>:48700` と `https://<ホスト名>.local:48710` は別オリジンのため、localStorage に保存済みのトークンは引き継がれません。既存のブックマークやホーム画面 PWA は、一度トークン付きの https URL を開き直してから再追加してください。
>
> **LAN IP が変わったら**: `pnpm certs:setup && docker compose restart` で証明書を再発行できます（`.local` 名でアクセスしている場合は再発行不要です）。

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

Vite 開発サーバーが `/ws`・`/health` を `localhost:48701` にプロキシします。開発時はサーバーが cmux 端末の子プロセスとして動くため、cmux のモードは `cmuxOnly` のままでも接続できます。開発時も認証トークンは必要です — 初回のみ `http://localhost:5173/?token=<認証トークン>` で開いてください（トークンはサーバー起動ログに表示されます）。

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
| `CMUX_REMOTE_TOKEN` | 初回起動時に自動生成（`apps/server/.run/token` に永続化） | WebSocket 接続の共有認証トークン。`apps/server/.env` でも設定可（Bun が自動読込） |

ソケットパスは `CMUX_SOCKET_PATH` → `~/.local/state/cmux/last-socket-path` / `~/Library/Application Support/cmux/last-socket-path` のポインタファイル → 既定パス、の順で解決されます。

## ルートの主なスクリプト

| コマンド | 内容 |
|---|---|
| `pnpm bootstrap` | 依存インストール + 証明書生成 + ビルド + cmux Automation 設定 + Docker イメージビルド |
| `pnpm certs:setup` | mkcert で TLS 証明書を生成（`certs/` に出力、nginx に volume mount） |
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
      auth.ts             # WS 共有トークン認証（生成・永続化・検証）
      ws.ts               # WebSocket ⇄ cmux UDS 中継（surface.list は system.tree から整形）
      cmux-client.ts      # cmux UDS クライアント（ヘルスチェック用）
      socket-path.ts      # ソケットパス解決
      health.ts           # GET /health
  client/                 # React 19 + Vite PWA
    src/
      components/         # Header, ConnectionIndicator, Drawer, TabBar, InputBar,
                          #   Terminal, BrowserView, SettingsModal, TokenGate
      hooks/              # useCmux, useWebSocket
      lib/                # cmux-rpc(JSON-RPC), render-grid(grid→ANSI), terminal-keys/coords,
                          #   sgr-mouse, multitouch, mouse-mode, selection, settings, surface-cache, token
    main.tsx              # エントリ（M PLUS 1 Code フォント import を含む）
    nginx.conf            # TLS 終端 + 静的配信 + /ws,/health をホスト :48701 へプロキシ
scripts/
  set-cmux-socket-mode.mjs # cmux automation.socketControlMode パッチ
  setup-certs.mjs          # mkcert で TLS 証明書を生成（certs/ へ出力）
certs/                    # TLS 証明書（gitignore、nginx へ volume mount）
compose.yml               # client(nginx) のみ
```

## ライセンス

[MIT](LICENSE)
