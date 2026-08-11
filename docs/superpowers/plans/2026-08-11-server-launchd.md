# サーバー常駐の launchd LaunchAgent 化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bun ブリッジサーバーの常駐を nohup から launchd LaunchAgent（KeepAlive + RunAtLoad）へ切り替え、クラッシュ自動再起動とログイン時自動復帰を得る。

**Architecture:** 新規スクリプト `scripts/server-launchd.mjs` が plist を実行時生成（bun 絶対パス・リポジトリ絶対パスを埋め込み）して `launchctl bootstrap/bootout` を操作する。`apps/server/package.json` のスクリプトの中身だけを差し替え、pnpm インターフェースは不変。`down` は plist 削除まで行う完全解除。

**Tech Stack:** Node ESM スクリプト（既存 `scripts/*.mjs` と同型）、launchd（macOS）、Bun サーバー本体は無変更。

Spec: `docs/superpowers/specs/2026-08-11-server-launchd-design.md`

## Global Constraints

- 実行・検証は **canonical checkout**（`/Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor`）で行う。worktree には証明書が無く本番検証できない。
- ライブの launchd・実サーバーに対して検証する（launchctl 相互作用が本体のためユニットテストは追加しない）。**各タスクの検証後は必ずサーバーを稼働状態に戻す**（PWA が利用中の可能性がある）。
- Label は `com.tanaka-yui.cmux-remote-editor.server` 固定。ポートは `PORT` env（既定 `48701`）。
- pnpm インターフェース（`server:up/down/status/restart/logs`、`start`/`stop`）は変えない。
- コードスタイル: Biome（シングルクォート、セミコロンなし、行幅 120）。既存 `scripts/set-cmux-socket-mode.mjs` と同じ plain Node ESM。
- コミット前に `pnpm check` と `pnpm sort-package` を通す。
- サーバー本体（`apps/server/src/`）は無変更。パス解決は `import.meta.dir` 基準で cwd 非依存だが、Bun の `.env` 自動読込のため plist の `WorkingDirectory` は `apps/server` にする（現行 nohup 運用と同じ cwd）。

---

### Task 1: launchd 管理スクリプト `scripts/server-launchd.mjs`

**Files:**
- Create: `scripts/server-launchd.mjs`

**Interfaces:**
- Consumes: なし（自己完結。`which bun` / `launchctl` / `lsof` を実行時に使う）
- Produces: CLI `node scripts/server-launchd.mjs <up|down|status>`。Task 2 の package.json がこの 3 サブコマンドを呼ぶ。plist は `~/Library/LaunchAgents/com.tanaka-yui.cmux-remote-editor.server.plist` に生成。

- [ ] **Step 1: スクリプトを作成**

`scripts/server-launchd.mjs` を以下の内容で作成:

```js
#!/usr/bin/env node
// Manage the bridge server as a macOS launchd LaunchAgent (KeepAlive + RunAtLoad).
//
// Why launchd: the old nohup daemon had no crash restart and no revival after
// login. Why `down` also deletes the plist: `launchctl bootout` alone is undone
// at the next login because launchd loads every plist left in
// ~/Library/LaunchAgents — deleting it keeps a stopped server stopped.
//
// Usage: node scripts/server-launchd.mjs <up|down|status>

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.tanaka-yui.cmux-remote-editor.server'
const PORT = process.env.PORT ?? '48701'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_DIR = join(REPO_ROOT, 'apps', 'server')
const LOG_PATH = join(SERVER_DIR, '.run', 'server.log')
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const DOMAIN = `gui/${process.getuid()}`

function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() }
  }
}

function portListenerPids() {
  const { out } = run('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'])
  return out ? out.split('\n') : []
}

// Returns false if the port is still occupied after ~3s (kill failed / no permission).
function killPortListeners() {
  const pids = portListenerPids()
  if (pids.length) run('kill', pids)
  const deadline = Date.now() + 3000
  while (portListenerPids().length) {
    if (Date.now() > deadline) return false
    run('sleep', ['0.2'])
  }
  return true
}

function buildPlist(bunPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${SERVER_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CMUX_REMOTE_TLS</key><string>1</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`
}

function up() {
  const bun = run('which', ['bun'])
  if (!bun.ok || !bun.out) {
    console.error('bun not found in PATH — install bun first')
    process.exit(1)
  }
  run('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]) // ignore failure (not loaded)
  if (!killPortListeners()) {
    console.error(`port :${PORT} still busy after kill:`)
    console.error(run('lsof', ['-i', `tcp:${PORT}`, '-sTCP:LISTEN']).out)
    process.exit(1)
  }
  mkdirSync(join(SERVER_DIR, '.run'), { recursive: true })
  mkdirSync(dirname(PLIST_PATH), { recursive: true })
  writeFileSync(PLIST_PATH, buildPlist(bun.out))
  const boot = run('launchctl', ['bootstrap', DOMAIN, PLIST_PATH])
  if (!boot.ok) {
    console.error(`launchctl bootstrap failed:\n${boot.out}`)
    process.exit(1)
  }
  const deadline = Date.now() + 5000
  while (!portListenerPids().length) {
    if (Date.now() > deadline) {
      console.error(`bootstrapped but not listening on :${PORT} — check logs: pnpm server:logs`)
      process.exit(1)
    }
    run('sleep', ['0.2'])
  }
  console.log(`server up via launchd (${LABEL}) on :${PORT} (TLS) — logs: apps/server/.run/server.log`)
}

function down() {
  run('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]) // ignore failure (not loaded)
  if (existsSync(PLIST_PATH)) rmSync(PLIST_PATH)
  if (!killPortListeners()) console.error(`warning: port :${PORT} still has a listener`)
  console.log('server down (LaunchAgent removed — stays down after reboot)')
}

function status() {
  const registered = run('launchctl', ['print', `${DOMAIN}/${LABEL}`]).ok
  console.log(portListenerPids().length ? `running on :${PORT}` : 'stopped')
  console.log(registered ? `launchd: registered (${LABEL})` : 'launchd: not registered')
}

const cmd = process.argv[2]
if (cmd === 'up') up()
else if (cmd === 'down') down()
else if (cmd === 'status') status()
else {
  console.error('Usage: node scripts/server-launchd.mjs <up|down|status>')
  process.exit(1)
}
```

- [ ] **Step 2: ベースライン確認（読み取りのみ）**

Run: `node scripts/server-launchd.mjs status`
Expected: 現行 nohup サーバーが稼働中なら `running on :48701` / 停止中なら `stopped`。2 行目は必ず `launchd: not registered`（まだ未登録）。

- [ ] **Step 3: up を実行（旧 nohup からの移行がここで起こる）**

Run: `node scripts/server-launchd.mjs up`
Expected: `server up via launchd (com.tanaka-yui.cmux-remote-editor.server) on :48701 (TLS) — logs: apps/server/.run/server.log`

Run: `node scripts/server-launchd.mjs status`
Expected: `running on :48701` と `launchd: registered (...)`

Run: `curl -sk https://127.0.0.1:48701/health`
Expected: `{"status":"ok","cmux":"connected",...}`（cmux が起動中の場合。`disconnected` なら cmux 未起動なだけでサーバー自体は正常）

- [ ] **Step 4: KeepAlive（クラッシュ自動再起動）を検証**

Run: `OLD=$(lsof -ti tcp:48701 -sTCP:LISTEN) && kill -9 $OLD && NEW=''; for i in $(seq 1 20); do sleep 1; NEW=$(lsof -ti tcp:48701 -sTCP:LISTEN) && break; done; echo "old=$OLD new=$NEW"`
Expected: 20 秒以内に old と new が**異なる PID** で両方非空（launchd が再起動した。直近の spawn から 10 秒未満の kill は ThrottleInterval により最大 ~10 秒遅れる）。

- [ ] **Step 5: down（完全解除）を検証**

Run: `node scripts/server-launchd.mjs down`
Expected: `server down (LaunchAgent removed — stays down after reboot)`

Run: `lsof -ti tcp:48701 -sTCP:LISTEN; test -f ~/Library/LaunchAgents/com.tanaka-yui.cmux-remote-editor.server.plist && echo 'plist REMAINS' || echo 'plist gone'; launchctl print gui/$(id -u)/com.tanaka-yui.cmux-remote-editor.server >/dev/null 2>&1 && echo 'job REMAINS' || echo 'job gone'`
Expected: lsof は空、`plist gone`、`job gone`。

- [ ] **Step 6: サーバーを稼働状態に戻す**

Run: `node scripts/server-launchd.mjs up && node scripts/server-launchd.mjs status`
Expected: `running on :48701` / `launchd: registered (...)`

- [ ] **Step 7: コミット**

```bash
git add scripts/server-launchd.mjs
git commit -m 'feat(server): launchd LaunchAgent 管理スクリプトを追加'
```

---

### Task 2: package.json のスクリプト差し替え

**Files:**
- Modify: `apps/server/package.json`（`restart` / `start:bg` / `status` / `stop` の 4 スクリプト）

**Interfaces:**
- Consumes: Task 1 の CLI `node ../../scripts/server-launchd.mjs <up|down|status>`（apps/server が cwd のため相対パスは `../../`）
- Produces: 従来どおりの pnpm インターフェース。root `package.json` の `server:up`（→ `start:bg`）、`server:down`（→ `stop`）、`server:status`（→ `status`）、`server:restart`（→ `restart`）、`start`/`stop` は無変更で動く。

- [ ] **Step 1: apps/server/package.json の 4 スクリプトを差し替え**

`apps/server/package.json` の `scripts` 内、以下の 4 行を差し替える（`logs` / `start` / `dev` などは触らない）:

旧:

```json
    "restart": "bun run stop; sleep 1; bun run start:bg",
    "start:bg": "mkdir -p .run && CMUX_REMOTE_TLS=1 nohup bun src/index.ts >> .run/server.log 2>&1 & echo \"server up on :${PORT:-48701} (TLS) — logs: apps/server/.run/server.log\"",
    "status": "lsof -ti tcp:${PORT:-48701} -sTCP:LISTEN >/dev/null 2>&1 && echo \"running on :${PORT:-48701}\" || echo stopped",
    "stop": "PIDS=$(lsof -ti tcp:${PORT:-48701} -sTCP:LISTEN 2>/dev/null); if [ -n \"$PIDS\" ]; then kill $PIDS && echo 'server down'; else echo 'not running'; fi",
```

新:

```json
    "restart": "node ../../scripts/server-launchd.mjs up",
    "start:bg": "node ../../scripts/server-launchd.mjs up",
    "status": "node ../../scripts/server-launchd.mjs status",
    "stop": "node ../../scripts/server-launchd.mjs down",
```

（`up` は「bootout → 生成 → bootstrap」の冪等操作なので `restart` と `start:bg` は同一で正しい。）

- [ ] **Step 2: pnpm 経由の動作を検証**

Run: `pnpm server:status`
Expected: `running on :48701` / `launchd: registered (...)`（Task 1 Step 6 で稼働中のはず）

Run: `OLD=$(lsof -ti tcp:48701 -sTCP:LISTEN) && pnpm server:restart && NEW=$(lsof -ti tcp:48701 -sTCP:LISTEN) && echo "old=$OLD new=$NEW"`
Expected: `server up via launchd ...` が出力され、old と new が異なる PID（restart でプロセスが入れ替わった）。

Run: `pnpm server:down && pnpm server:status`
Expected: `server down (...)` のあと `stopped` / `launchd: not registered`。

Run: `pnpm server:up && pnpm server:status`
Expected: `running on :48701` / `launchd: registered (...)`。

- [ ] **Step 3: start/stop の全体フローを検証**

Run: `pnpm stop`
Expected: docker compose が停止し、サーバーも `server down (...)`。

Run: `pnpm start`
Expected: `server up via launchd ...` → compose up → `Up. PWA (first connect, token included): https://....local:48710/?token=...` が出力される。

Run: `curl -sk https://127.0.0.1:48710/health`
Expected: `{"status":"ok",...}`（nginx → ホスト launchd サーバーへのプロキシが機能）。スタックはこのまま稼働状態で残す。

- [ ] **Step 4: check を通す**

Run: `pnpm check && pnpm sort-package`
Expected: 両方 PASS（`sort-package` はスクリプトのキー順を変えていないので通る）。

- [ ] **Step 5: コミット**

```bash
git add apps/server/package.json
git commit -m 'feat(server): 常駐管理を nohup から launchd へ切替'
```

---

### Task 3: ドキュメント更新（compose.yml コメント + CLAUDE.md）

**Files:**
- Modify: `compose.yml:1-7`（冒頭コメント）
- Modify: `CLAUDE.md`（運用セクションと「重要な制約」セクション）

**Interfaces:**
- Consumes: Task 1/2 の成果（launchd 常駐・stop の完全解除意味論）
- Produces: なし（ドキュメントのみ）

- [ ] **Step 1: compose.yml の冒頭コメントを真因に書き直す**

旧（1〜7 行目）:

```yaml
# Only the client (nginx PWA) runs in Docker.
#
# The Bun bridge server must talk to the cmux Unix socket, and cmux only accepts
# connections from processes started *inside* cmux (access_mode: cmuxOnly). A
# container is a separate process tree and is always rejected, so the server runs
# on the host instead — start it from a cmux terminal with `pnpm server:up`.
# nginx proxies /ws and /health to that host server via host.docker.internal.
```

新:

```yaml
# Only the client (nginx PWA) runs in Docker.
#
# The Bun bridge server cannot run in a container: Rancher Desktop (Lima VM /
# virtiofs) exposes a bind-mounted host Unix socket as a file node but does not
# proxy connect() across the VM boundary ("Not supported"), so the cmux socket
# is unreachable from any container regardless of cmux's access mode (allowAll
# does not help). The server runs on the host as a launchd LaunchAgent instead
# (`pnpm server:up`). Full investigation (OrbStack/Docker Desktop share the
# limitation; Lima reverse socket forwarding is fragile under Rancher Desktop):
# docs/superpowers/specs/2026-08-11-server-launchd-design.md
# nginx proxies /ws and /health to that host server via host.docker.internal.
```

- [ ] **Step 2: CLAUDE.md の運用セクションを更新**

旧:

```
pnpm server:up|down|status|restart|logs   # ホスト常駐サーバーの管理（ログ: apps/server/.run/server.log）
```

新:

```
pnpm server:up|down|status|restart|logs   # launchd LaunchAgent 常駐の管理（ログ: apps/server/.run/server.log）
```

さらに直後の段落（「クライアントを更新した後の…」）の末尾に以下を追記:

```
サーバーは LaunchAgent（`KeepAlive` + `RunAtLoad`）で常駐し、クラッシュ時は自動再起動、ログイン時は自動復帰する。`pnpm stop` / `pnpm server:down` は plist 削除まで行う完全解除で、Mac を再起動しても止まったまま。Mac 再起動後にスタック全体を自動復帰させるには Rancher Desktop のログイン時自動起動設定が別途必要（クライアント側の復帰は `restart: unless-stopped` が担う）。
```

- [ ] **Step 3: CLAUDE.md の「重要な制約」セクションを真因に書き直す**

旧（セクション冒頭の 2 文）:

```
cmux ソケットは既定の `cmuxOnly` モードで「cmux の子孫プロセスのみ接続可」という PID 系譜チェックを行うため、コンテナ（別プロセスツリー）からの接続は常に拒否される。そのためサーバーはホストで動かし、Docker は nginx クライアントのみ（`compose.yml` 参照）。
```

新:

```
Rancher Desktop（Lima VM / virtiofs）は bind mount したホストの UNIX ソケットをファイルノードとしては見せるが、VM 境界を越えた connect() を中継しない（`Not supported`）。そのため cmux ソケットにはコンテナからどの設定でも到達できず（`allowAll` でも不可）、サーバーはホストで動かし、Docker は nginx クライアントのみ（`compose.yml` 参照）。調査記録は `docs/superpowers/specs/2026-08-11-server-launchd-design.md`。なお cmux 既定の `cmuxOnly` モードは「cmux の子孫プロセスのみ接続可」という PID 系譜チェックも行う。
```

（同セクションの後続文「常駐デーモン運用には cmux を `allowAll` にする必要があり…」はそのまま残す — launchd 常駐でも launchd 直下の別プロセスツリーであることは変わらず、`allowAll` 前提は従来どおり。）

- [ ] **Step 4: コミット**

```bash
git add compose.yml CLAUDE.md
git commit -m 'docs: Docker 化断念の真因と launchd 常駐運用を反映'
```

---

## 実装後の手動確認（任意・ユーザー向け）

- ログアウト → ログイン（または Mac 再起動）後に `pnpm server:status` が `running` を示すこと（`RunAtLoad` の実機確認。spec 検証手順 5）。
- Rancher Desktop の「ログイン時に自動起動」を有効にしておくと、再起動後にクライアント（nginx）も自動復帰する。
