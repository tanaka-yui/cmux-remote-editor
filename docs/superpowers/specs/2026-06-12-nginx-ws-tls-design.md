# nginx ↔ Bun ブリッジの TLS 化 / LAN 露出封鎖

作成日: 2026-06-12 / タスク: nginx-ws-tls

## Context（なぜこの変更をするのか）

ユーザーの懸念（原文）:
> 「nginx から ws サーバー間の通信は平文だと思いますが、傍受される要素ありませんか？ある場合そこも https 化したい」

現状の通信経路:

```
ブラウザ/PWA → nginx (Docker :48710 https / :48700 は 301) → Bun ブリッジ (ホスト :48701 HTTP 平文) → cmux UDS
```

TLS は nginx で終端し、nginx→Bun の区間は HTTP 平文。この区間の傍受リスクを技術評価し、リスクが実在するため対処する。

## 脅威モデル評価（本タスクの最重要成果物・結論）

実証調査の結果:

1. **Bun は `0.0.0.0`（全インターフェース）にバインドしている（実証済み・最重要）**
   - `Bun.serve` の既定 `hostname` は `0.0.0.0`（context7 / bun-types `serve.d.ts` で確認）。現コードは `hostname` 未指定。
   - `lsof` で `bun ... TCP *:48701 (LISTEN)` を確認。
   - LAN IP 経由 `curl http://192.168.0.109:48701/health` が **HTTP 200** を返すことを確認。
   - → LAN 上の任意端末が `ws://<MacのLAN IP>:48701/ws?token=...` に**平文で直接到達でき、nginx/TLS を完全バイパス**できる。トークン・端末 I/O が平文で LAN に晒される。

2. **nginx→Bun ホップ単体（ユーザーが想定した区間）**
   - macOS + Rancher Desktop ではコンテナは Linux VM 内で動作し、`host.docker.internal:48701` への通信は VM↔ホストの仮想ネットワーク内で完結する。
   - → 物理 LAN には出ないため、**LAN 端末からこのワイヤ自体は傍受できない**。盗聴できるのは同一 Mac 上の root 権限プロセスのみ（高いハードル）。

3. **トークンの平文露出**
   - `CMUX_REMOTE_TOKEN` はこの平文区間を通る。`auth.ts` のコメントも「The bridge is reachable from the LAN」と露出を認識済みだが、トークンは**認証**のみを担い、**機密性**は提供しない。

**結論: 傍受リスクは実在する。ただし主因はユーザーが想定した「nginx→Bun ホップ」そのものではなく、Bun が `0.0.0.0` にバインドして平文ブリッジを LAN に晒している点。**「ループバックだから安全」は誤り。対処する価値がある。

## 採用方針（多層防御）

ユーザー選択: **「TLS 化 + LAN 露出も封鎖」** / 上流 TLS 検証は **「検証なし（proxy_ssl_verify off）」**。

1. **Bun をループバック束縛**（`hostname: '127.0.0.1'`、env `CMUX_BIND_HOST` で上書き可・既定はループバック）
   - LAN からの直接到達を遮断する。トークン・端末 I/O は LAN に出ない。
   - 本番では nginx(Docker) が `host.docker.internal` 経由でループバックの Bun に到達できる必要がある → **実行時に検証**（後述）。到達不可なら `CMUX_BIND_HOST=0.0.0.0` にフォールバック（その場合も TLS が機密性を担保）。

2. **Bun で TLS 終端**（WSS/HTTPS、本番のみ env `CMUX_REMOTE_TLS` で有効化、既存 mkcert 証明書を再利用）
   - nginx→Bun ホップを暗号化し、同一ホスト root の盗聴・VM↔ホップの平文も解消。ユーザー要望「https 化」に直接合致。
   - dev（`pnpm dev`）は HTTP のまま（`CMUX_REMOTE_TLS` 未設定）。Vite が localhost にプロキシするため無変更。

3. **nginx 上流を https 化**（`proxy_pass https://...` + `proxy_ssl_verify off`）
   - mkcert 証明書の SAN に `host.docker.internal` は無いため、ホスト内ホップとして検証なしで暗号化のみ得る（ユーザー選択）。

クライアントは `window.location.protocol` から `wss:`/`ws:` を導出するため**無変更**（`useCmux.ts:52-54`）。

## ファイル変更

### 新規: `apps/server/src/tls.ts`
`loadTlsOptions()` を実装（class 不使用・`any`/`unknown` 不使用）:
- `CMUX_REMOTE_TLS` が truthy なときのみ TLS を有効化。未設定（= dev）は `undefined` を返し HTTP 動作。
- 証明書パスは env `CMUX_TLS_CERT` / `CMUX_TLS_KEY`、既定は `import.meta.dir` 基準でリポジトリ `certs/server.pem` / `certs/server-key.pem`（`join(import.meta.dir, '../../../certs/...')`）。
- 有効だが証明書ファイルが存在しなければ明確なエラーで fail fast（`pnpm start` の既存チェックと整合）。
- 戻り値は `{ cert: BunFile; key: BunFile } | undefined`。

### 変更: `apps/server/src/index.ts`
- `const tls = loadTlsOptions()` を読み込み、`Bun.serve({ port, hostname: process.env.CMUX_BIND_HOST ?? '127.0.0.1', tls, fetch, websocket })`。
- 起動ログのスキームを `tls ? 'https' : 'http'` に応じて出力。

### 新規: `apps/server/src/__tests__/tls.test.ts`（TDD・先に RED）
既存テスト（`auth.test.ts` 等）の Bun test パターンに合わせる:
- `CMUX_REMOTE_TLS` 未設定 → `undefined`。
- 設定 + 既存ファイル → `{ cert, key }` を返す。
- 設定だが証明書欠如 → throw。
- env はテスト内で設定/復元。

### 変更: `apps/client/nginx.conf`
- `/ws`・`/health` の `proxy_pass http://host.docker.internal:48701` → `https://host.docker.internal:48701`。
- `proxy_ssl_verify off;` を明示（コメントで「ホスト内ホップ・mkcert に host.docker.internal SAN 無し」を記載）。
- WS の `Upgrade`/`Connection`/`proxy_http_version 1.1` 等は維持。

### 変更: `apps/server/package.json`
- `start:bg` に `CMUX_REMOTE_TLS=1` を付与（本番常駐のみ TLS 有効化）。`dev` スクリプトは無変更（dev は HTTP）。

### 変更（ドキュメント）: `CLAUDE.md` / `README`
- 「Bun ブリッジと開発モードは HTTP のまま」の記述を更新し、本番は Bun も TLS 終端・ループバック束縛である旨を反映。

### 無変更
- `apps/client/vite.config.ts`（dev は Bun HTTP + localhost プロキシで動作）。
- `apps/client/src/hooks/useCmux.ts`（protocol 自動導出）。
- `scripts/setup-certs.mjs`（検証なし選択のため `host.docker.internal` SAN 追加は不要）。

## 検証（end-to-end）

1. `pnpm check`（tsc + biome 両パッケージ）が通ること。
2. `cd apps/server && bun test`（新規 `tls.test.ts` 含む全テスト緑）。
3. `pnpm certs:setup`（worktree に `certs/` が無いため必要。mkcert 依存）。
4. **LAN 封鎖の実証**: ループバック束縛で Bun を起動 →
   `curl -m4 http://192.168.0.109:48701/health` が **接続拒否/失敗**になること（旧: 200 → 新: 失敗 = LAN 露出除去）。
5. **Docker→Bun ループバック到達 + TLS の実証**: nginx を再ビルド/再起動し
   `curl -k https://localhost:48710/health` が **200**（cmux status 付き）を返すこと。
   = Docker(VM) がループバックの Bun に TLS で到達できている。
6. **フォールバック判定**: 手順 5 が失敗（Docker がループバックに到達不可）なら
   `CMUX_BIND_HOST=0.0.0.0` で再起動して再検証。LAN 封鎖は諦め、TLS+トークンで機密性を担保する旨を result.md に明記。

稼働中の Docker コンテナ `cmux-remote-editor-client-1`（:48700/:48710 公開中）で手順 5/6 を実行可能。

## トレードオフ / 残存リスク

- `proxy_ssl_verify off`: 同一ホスト root による能動的 MITM は理論上可能だが、その権限があれば証明書鍵・トークンファイルも読めるため実効的な弱体化はない。暗号化（受動盗聴対策）は得られる。
- ループバック束縛が Docker 到達性を壊す可能性（Rancher のバージョン/モード依存）→ env フォールバックで回避可能・既定は secure。
