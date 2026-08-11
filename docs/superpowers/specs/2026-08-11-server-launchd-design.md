# サーバー常駐の launchd LaunchAgent 化 — 設計

日付: 2026-08-11
ステータス: 承認済み（実装前）

## 背景: 「サーバーの Docker 化は本当に不可能か」再調査の結果

### 真因の更新

compose.yml は「cmux ソケットが `cmuxOnly` モードで PID 系譜チェックを行うため、コンテナからの接続は常に拒否される」ことを Docker 化断念の理由としていた。しかし本番運用は既に `allowAll`（`pnpm cmux:allow-automation`、確認時点の `~/.config/cmux/cmux.json` も `allowAll`）であり、PID 系譜チェックは現在の障壁ではない。

実験により真の障壁を特定した:

```
$ docker run --rm -v ~/.local/state/cmux:/cmux alpine ls -la /cmux
srw-rw-rw-  cmux-501.sock          # ソケットのファイルノードは見える

$ ... socat - UNIX-CONNECT:/cmux/cmux-501.sock
socat E connect(, AF=1 "/cmux/cmux-501.sock", 21): Not supported   # connect() は不可
```

**Rancher Desktop（Lima VM / virtiofs, vmType: vz）は、bind mount したホストの UNIX ソケットに対する VM 境界越しの connect() を中継しない。** これは cmux の設定と無関係な macOS Docker 全般の制限で、サーバーをコンテナに入れる限り cmux UDS へ直接は届かない。

### 検討した代替経路

| 経路 | 判定 | 根拠 |
|---|---|---|
| OrbStack へ乗り換え | 不可 | UDS bind mount 未対応（[orbstack#62](https://github.com/orbstack/orbstack/issues/62) が open、[#1185](https://github.com/orbstack/orbstack/issues/1185) は退行報告） |
| Docker Desktop へ乗り換え | 不可 | 同様の virtiofs 制限（docker.sock のみ特別扱い） |
| Lima reverse ソケット転送 | 可能だが脆い | Lima 本体は `portForwards: reverse: true` でホスト UDS→ゲスト転送に対応（[lima#836](https://github.com/lima-vm/lima/pull/836)、SSH -R 経由）。Rancher Desktop では `~/Library/Application Support/rancher-desktop/lima/_config/override.yaml` で注入するが、一部ブロックは毎起動時に上書きされる既知問題があり（[rancher-desktop#9967](https://github.com/rancher-sandbox/rancher-desktop/issues/9967)）、factory reset で消える。RD 更新で静かに壊れるリスクがあり要実証 |
| ホストに socat リレー（UDS→127.0.0.1 TCP）+ サーバー Docker 化 | 可能 | nginx→ホスト TCP と同型で確実。ただしホスト常駐が Bun サーバーから socat に置き換わるだけで、launchd 管理は結局必要。可動部品はむしろ増える |
| cmux 本体に TCP リスナー追加 | 可能 | ソースは `~/Documents/workspace/oss/cmux`。最も本質的だがスコープが cmux 側へ拡大 |

### 決定

動機を確認したところ「ライフサイクル一元化 — 自動再起動・ログ収集が揃えば手段は Docker でなくてもよい」であった。現状の `pnpm start`（nohup 起動）に足りないのは (a) クラッシュ時の自動再起動、(b) Mac 再起動後の自動復帰、の 2 点のみ（クライアント側は `restart: unless-stopped` で両方持つ）。

よって **Docker 化はせず、Bun サーバーを launchd LaunchAgent（KeepAlive + RunAtLoad）で常駐させる**。VM 境界問題と戦わず、最小の変更で動機を満たす。完全 Docker 化が将来必要になった場合の再訪先は上表の「Lima reverse ソケット転送」。

## 設計

### LaunchAgent

`~/Library/LaunchAgents/com.tanaka-yui.cmux-remote-editor.server.plist` をスクリプトが**実行時に生成**する。launchd 環境は PATH が薄いため、bun の絶対パス（`which bun` で解決）とリポジトリ絶対パスを生成時に埋め込む。テンプレートをリポジトリに置かず生成式にするのは、環境依存の絶対パスを成果物に含めないため。

- `Label`: `com.tanaka-yui.cmux-remote-editor.server`
- `ProgramArguments`: `[<bun絶対パス>, src/index.ts]`
- `WorkingDirectory`: `<repo>/apps/server`
- `EnvironmentVariables`: `CMUX_REMOTE_TLS=1`
- `KeepAlive: true` — クラッシュ時に launchd が自動再起動
- `RunAtLoad: true` — bootstrap 時および（plist が残っている限り）ログイン時に自動起動
- `StandardOutPath` / `StandardErrorPath`: `<repo>/apps/server/.run/server.log`（現行のログ場所・`pnpm server:logs` を維持）

### スクリプト

新規 `scripts/server-launchd.mjs`（`up` / `down` / `status` サブコマンド）を追加し、`apps/server/package.json` のスクリプトの中身を差し替える。**pnpm インターフェース（`server:up/down/status/restart/logs`、`start`/`stop`）は不変。**

- `up`（= `pnpm server:up`、冪等）:
  1. 旧 nohup 方式の残存プロセスがあればポート(:48701)のリスナーを kill（移行の自動処理）
  2. plist を生成して `~/Library/LaunchAgents/` に書く
  3. 登録済みなら `launchctl bootout gui/$UID/<label>` → `launchctl bootstrap gui/$UID <plist>`
- `down`（= `pnpm server:down`）: `launchctl bootout` + **plist ファイル削除** + 念のためポートリスナー kill
- `status`: launchctl のジョブ状態 + ポート LISTEN 確認
- `restart`（= `pnpm server:restart`）: `up` を呼ぶだけ（冪等なので専用処理不要）

### 停止の意味論（重要）

- 旧 `stop`（lsof で kill）は launchd 管理下では KeepAlive が即再起動するため使えない。bootout への置換は必須。
- bootout だけでは plist が `~/Library/LaunchAgents/` に残り、**次のログインで再び自動起動してしまう**。そのため `down` は plist 削除まで行い、「**止めたら Mac を再起動しても止まったまま**」を保証する（ユーザー承認済みの意味論）。`up` が毎回 plist を生成するので削除して失うものはない。
- 常時起動の on/off 専用コマンドは追加しない。`server:up` = 常時起動開始、`server:down` = 完全解除、で一対一に対応する。

### 変更しないもの

- `pnpm dev`（cmux 子プロセスとして動く開発モード。launchd 無関係）
- `pnpm start` / `stop` の UX（start = server:up + compose up、stop = compose stop + server:down）
- ログの場所と `pnpm server:logs`
- cmux `allowAll` 前提（launchd 常駐は launchd 直下の別プロセスツリーであり、現行の nohup 常駐と同じく `allowAll` が必要）
- クライアント側 Docker 構成
- ログローテーション（現状も無し。スコープ外）

### ドキュメント更新

- `compose.yml` 冒頭コメント: 断念理由を「cmuxOnly の PID チェック」から「VM 境界越しの UDS connect() 不可（+ allowAll でも解消しない）」に書き直す
- `CLAUDE.md` 運用セクション: launchd 化した `server:up/down` の説明、stop の完全解除意味論、Mac 再起動後の全体復帰には Rancher Desktop 側のログイン時自動起動設定が別途必要な旨を注記

## エラーハンドリング

- `which bun` が失敗（bun 未インストール）: 明示エラーで中断
- `launchctl bootstrap` 失敗: launchctl の stderr をそのまま表示して非 0 終了（部分状態を隠さない）
- `up` のポート kill 後もポートが解放されないケース（kill 失敗・権限不足など）: bootstrap するとポート衝突でクラッシュループに入るため、専有プロセスを表示して中断

## 検証手順

1. `pnpm server:up` → `pnpm server:status` で running を確認、`/health` が `cmux: connected` を返す
2. bun プロセスを `kill -9` → 数秒以内に自動再起動することを確認（KeepAlive）
3. `pnpm server:down` → ポート解放・再起動しない・plist が削除されていることを確認
4. `pnpm start` / `pnpm stop` の一連フローが従来どおり動く
5. （可能なら）ログアウト/ログインまたは Mac 再起動で自動復帰を確認（RunAtLoad）
