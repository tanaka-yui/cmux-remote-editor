# Web Push 通知（MVP）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cmux の actionable な通知（Needs input / Permission）を Bun サーバーが常時バックグラウンドでポーリングして検知し、Web Push でアプリを閉じていても iPhone に表示し、タップで該当ワークスペースへディープリンクする。

**Architecture:** Bun サーバーに、WS 接続の有無に依らず動くバックグラウンドポーラーを内蔵。専用 cmux 接続で `notification.list` を ~10秒間隔ポーリング → actionable かつ未 push のみ抽出 → `web-push`（VAPID + aes128gcm）で各購読 endpoint に送信。クライアントは設定トグルで購読し、injectManifest 化した自前 Service Worker が push/notificationclick を処理する。

**Tech Stack:** Bun + Hono（server）、`web-push`、React 19 + Vite + `vite-plugin-pwa`（injectManifest）+ workbox（client）。テストは bun test（server）/ vitest（client）。

---

## 設計メモ（全タスク共通の前提）

- cmux RPC のワイヤ形式は `{ id, method, params }`（JSON-RPC 2.0 ではない）。応答は `{ id, ok?, result?, error?: { code, message } }`。1 行 1 メッセージ（改行区切り）。
- `notification.list` はサーバーで素通しされ、応答は `{ notifications: CmuxNotification[] }`。
- actionable 判定は Drawer の `deriveStatus`（`apps/client/src/components/Drawer.tsx`）と一致させる:
  - Needs input: `body.toLowerCase().includes('waiting for your input')` または `subtitle.toLowerCase() === 'waiting'`
  - Permission: `body.toLowerCase().includes('permission')`
- 通知の `workspace_id` は Workspace の `id`。クライアントの `selectWorkspace(ref)` は短縮 `ref` を取るため、ディープリンクでは `workspaces.find(w => w.id === workspace_id)?.ref` を引いて選択する。
- `createLineFramer`（UTF-8 安全な行フレーマ）は現状 `apps/server/src/ws.ts` に定義・export 済み。本計画では再利用のため `apps/server/src/line-framer.ts` へ抽出する（Task 7）。
- biome は `./src` のみ対象。`src/` 配下はシングルクォート・セミコロンなし・スペースインデント・幅120。`apps/client/vite.config.ts` は biome 対象外で既存はダブルクォート＋セミコロン → そのスタイルを踏襲する。
- TypeScript: `any` / `unknown` を型注釈に使わない（CLAUDE.md）。外部 JSON は具体的な interface へ `as` で受けてからフィールド検証する。`class` は使わない（ファクトリ関数 + クロージャ）。
- 単一テスト実行: server `cd apps/server && bun test src/__tests__/<file>`、client `cd apps/client && pnpm vitest run src/lib/__tests__/<file>`。

---

## Task 1: 依存追加 と サーバー共有型

**Files:**
- Modify: `apps/server/package.json`（`web-push` 追加、`@types/web-push` 追加）
- Create: `apps/server/src/push/types.ts`

- [ ] **Step 1: 依存をインストール**

```bash
cd apps/server && pnpm add web-push && pnpm add -D @types/web-push
```

Expected: `package.json` の dependencies に `web-push`、devDependencies に `@types/web-push` が追加される（リポジトリは exact 版固定）。

- [ ] **Step 2: 共有型を作成**

Create `apps/server/src/push/types.ts`:

```ts
// cmux の通知（notification.list の要素）。client 側 cmux-rpc.ts の CmuxNotification と同形。
export interface CmuxNotification {
  id: string
  title: string
  subtitle: string
  body: string
  workspace_id: string
  surface_id: string
  is_read: boolean
}

// ブラウザの PushSubscription.toJSON() と同形。store/送信で扱う。
export interface PushSubscriptionJSON {
  endpoint: string
  expirationTime: number | null
  keys: { p256dh: string; auth: string }
}
```

- [ ] **Step 3: 型チェック**

Run: `cd apps/server && pnpm exec tsc --noEmit`
Expected: PASS（エラーなし）

- [ ] **Step 4: Commit**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor/.worktrees/web-push-notifications
git add apps/server/package.json apps/server/src/push/types.ts pnpm-lock.yaml
git commit -m "feat(server): web-push 依存と push 共有型を追加"
```

---

## Task 2: actionable 判定（`push/filter.ts`）

**Files:**
- Create: `apps/server/src/push/filter.ts`
- Test: `apps/server/src/__tests__/push-filter.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/server/src/__tests__/push-filter.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { isActionable } from '../push/filter'
import type { CmuxNotification } from '../push/types'

function note(partial: Partial<CmuxNotification>): CmuxNotification {
  return {
    id: 'n1',
    title: 'cmux',
    subtitle: '',
    body: '',
    workspace_id: 'ws1',
    surface_id: 'sf1',
    is_read: false,
    ...partial,
  }
}

describe('isActionable', () => {
  test('Needs input: body に waiting for your input', () => {
    expect(isActionable(note({ body: 'Claude is waiting for your input' }))).toBe(true)
  })

  test('Needs input: subtitle が waiting（完全一致, 大小無視）', () => {
    expect(isActionable(note({ subtitle: 'Waiting' }))).toBe(true)
  })

  test('Permission: body に permission', () => {
    expect(isActionable(note({ body: 'Needs permission to run a command' }))).toBe(true)
  })

  test('完了/Idle 系は false', () => {
    expect(isActionable(note({ subtitle: 'Completed' }))).toBe(false)
    expect(isActionable(note({ body: '処理が完了しました' }))).toBe(false)
  })

  test('該当文言なしは false', () => {
    expect(isActionable(note({ body: 'just an update' }))).toBe(false)
  })

  test('既読は actionable でも false', () => {
    expect(isActionable(note({ body: 'waiting for your input', is_read: true }))).toBe(false)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/server && bun test src/__tests__/push-filter.test.ts`
Expected: FAIL（`Cannot find module '../push/filter'`）

- [ ] **Step 3: 実装**

Create `apps/server/src/push/filter.ts`:

```ts
import type { CmuxNotification } from './types'

// Drawer の deriveStatus と一致させた actionable 判定（Needs input / Permission）。
// 未読のもののみ対象にする。
export function isActionable(n: CmuxNotification): boolean {
  if (n.is_read) return false
  const body = n.body.toLowerCase()
  const subtitle = n.subtitle.toLowerCase()
  if (body.includes('waiting for your input') || subtitle === 'waiting') return true
  if (body.includes('permission')) return true
  return false
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/server && bun test src/__tests__/push-filter.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/push/filter.ts apps/server/src/__tests__/push-filter.test.ts
git commit -m "feat(server): actionable 通知判定 isActionable を追加"
```

---

## Task 3: push ペイロード生成（`push/payload.ts`）

**Files:**
- Create: `apps/server/src/push/payload.ts`
- Test: `apps/server/src/__tests__/push-payload.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/server/src/__tests__/push-payload.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { buildPayload } from '../push/payload'
import type { CmuxNotification } from '../push/types'

const base: CmuxNotification = {
  id: 'n1',
  title: 'my-workspace',
  subtitle: 'Claude',
  body: 'waiting for your input',
  workspace_id: 'ws-123',
  surface_id: 'sf-1',
  is_read: false,
}

describe('buildPayload', () => {
  test('title/body/data を JSON 文字列で返す', () => {
    const parsed = JSON.parse(buildPayload(base))
    expect(parsed.title).toBe('my-workspace')
    expect(parsed.body).toContain('waiting for your input')
    expect(parsed.data.workspace_id).toBe('ws-123')
    expect(parsed.data.url).toBe('/?workspace=ws-123')
    expect(parsed.tag).toBe('ws-123')
  })

  test('title が空なら cmux にフォールバック', () => {
    const parsed = JSON.parse(buildPayload({ ...base, title: '' }))
    expect(parsed.title).toBe('cmux')
  })

  test('workspace_id は URL エンコードされる', () => {
    const parsed = JSON.parse(buildPayload({ ...base, workspace_id: 'a b/c' }))
    expect(parsed.data.url).toBe('/?workspace=a%20b%2Fc')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/server && bun test src/__tests__/push-payload.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装**

Create `apps/server/src/push/payload.ts`:

```ts
import type { CmuxNotification } from './types'

// 通知 → Service Worker の push ハンドラが showNotification に渡す JSON。
// tag/url に workspace_id を載せ、同一WSの通知を畳み込み・タップで該当WSへ遷移させる。
export function buildPayload(n: CmuxNotification): string {
  const title = n.title || 'cmux'
  const body = [n.subtitle, n.body].filter((s) => s.trim() !== '').join(' — ') || 'New notification'
  return JSON.stringify({
    title,
    body,
    tag: n.workspace_id,
    data: { workspace_id: n.workspace_id, url: `/?workspace=${encodeURIComponent(n.workspace_id)}` },
  })
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/server && bun test src/__tests__/push-payload.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/push/payload.ts apps/server/src/__tests__/push-payload.test.ts
git commit -m "feat(server): push ペイロード生成 buildPayload を追加"
```

---

## Task 4: 購読・既送信 id の永続化（`push/store.ts`）

**Files:**
- Create: `apps/server/src/push/store.ts`
- Test: `apps/server/src/__tests__/push-store.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/server/src/__tests__/push-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPushStore } from '../push/store'
import type { PushSubscriptionJSON } from '../push/types'

function sub(endpoint: string): PushSubscriptionJSON {
  return { endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'push-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createPushStore', () => {
  test('購読の追加・重複排除・削除', () => {
    const store = createPushStore(dir)
    store.addSubscription(sub('https://a'))
    store.addSubscription(sub('https://a')) // 同一 endpoint は無視
    store.addSubscription(sub('https://b'))
    expect(store.listSubscriptions().map((s) => s.endpoint)).toEqual(['https://a', 'https://b'])
    store.removeSubscription('https://a')
    expect(store.listSubscriptions().map((s) => s.endpoint)).toEqual(['https://b'])
  })

  test('購読はファイルに永続化され再読込で復元する', () => {
    createPushStore(dir).addSubscription(sub('https://x'))
    const reloaded = createPushStore(dir)
    expect(reloaded.listSubscriptions().map((s) => s.endpoint)).toEqual(['https://x'])
  })

  test('seen の has/add と seed、永続化', () => {
    const store = createPushStore(dir)
    expect(store.seenHas('n1')).toBe(false)
    store.seenAdd('n1')
    expect(store.seenHas('n1')).toBe(true)
    store.seedSeen(['n2', 'n3'])
    const reloaded = createPushStore(dir)
    expect(reloaded.seenHas('n1')).toBe(true)
    expect(reloaded.seenHas('n2')).toBe(true)
    expect(reloaded.seenHas('n3')).toBe(true)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/server && bun test src/__tests__/push-store.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装**

Create `apps/server/src/push/store.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PushSubscriptionJSON } from './types'

function readJsonArray<T>(file: string): T[] {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function writeJson(file: string, value: PushSubscriptionJSON[] | string[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
}

export interface PushStore {
  listSubscriptions(): PushSubscriptionJSON[]
  addSubscription(sub: PushSubscriptionJSON): void
  removeSubscription(endpoint: string): void
  seenHas(id: string): boolean
  seenAdd(id: string): void
  seedSeen(ids: string[]): void
}

// 購読(push-subscriptions.json)と既送信 id(push-seen.json)をディレクトリ配下に永続化するストア。
// 状態はメモリにも保持し、変更時にファイルへ書き出す。テストでは temp dir を渡す。
export function createPushStore(dir: string): PushStore {
  const subsFile = join(dir, 'push-subscriptions.json')
  const seenFile = join(dir, 'push-seen.json')
  const subscriptions = readJsonArray<PushSubscriptionJSON>(subsFile)
  const seen = new Set<string>(readJsonArray<string>(seenFile))

  return {
    listSubscriptions: () => subscriptions.slice(),
    addSubscription(sub) {
      if (subscriptions.some((s) => s.endpoint === sub.endpoint)) return
      subscriptions.push(sub)
      writeJson(subsFile, subscriptions)
    },
    removeSubscription(endpoint) {
      const i = subscriptions.findIndex((s) => s.endpoint === endpoint)
      if (i === -1) return
      subscriptions.splice(i, 1)
      writeJson(subsFile, subscriptions)
    },
    seenHas: (id) => seen.has(id),
    seenAdd(id) {
      if (seen.has(id)) return
      seen.add(id)
      writeJson(seenFile, [...seen])
    },
    seedSeen(ids) {
      let changed = false
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id)
          changed = true
        }
      }
      if (changed) writeJson(seenFile, [...seen])
    },
  }
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/server && bun test src/__tests__/push-store.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/push/store.ts apps/server/src/__tests__/push-store.test.ts
git commit -m "feat(server): 購読・既送信idを永続化する push store を追加"
```

---

## Task 5: VAPID 鍵の生成・読込（`push/vapid.ts`）

**Files:**
- Create: `apps/server/src/push/vapid.ts`
- Test: `apps/server/src/__tests__/push-vapid.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/server/src/__tests__/push-vapid.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateVapidKeys } from '../push/vapid'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'push-vapid-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadOrCreateVapidKeys', () => {
  test('初回は鍵を生成し、再読込で同じ鍵を返す', () => {
    const file = join(dir, 'push-vapid.json')
    const first = loadOrCreateVapidKeys(file)
    expect(first.publicKey.length).toBeGreaterThan(0)
    expect(first.privateKey.length).toBeGreaterThan(0)
    const second = loadOrCreateVapidKeys(file)
    expect(second.publicKey).toBe(first.publicKey)
    expect(second.privateKey).toBe(first.privateKey)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/server && bun test src/__tests__/push-vapid.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装**

Create `apps/server/src/push/vapid.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import webpush from 'web-push'

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

// VAPID 鍵を読み込み、無ければ生成して永続化する。公開鍵はクライアントへ配布、秘密鍵はサーバー保管。
export function loadOrCreateVapidKeys(file: string): VapidKeys {
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>
      if (parsed.publicKey && parsed.privateKey) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
      }
    } catch {
      // 破損時は下で再生成する（既存購読は無効化されるが MVP では許容）。
    }
  }
  const keys = webpush.generateVAPIDKeys()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 })
  return keys
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/server && bun test src/__tests__/push-vapid.test.ts`
Expected: PASS（1 test）。`web-push` の `generateVAPIDKeys()` が Bun で動くことの確認も兼ねる。失敗時（web-push が Bun 非互換）は status を error にして親へ報告すること。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/push/vapid.ts apps/server/src/__tests__/push-vapid.test.ts
git commit -m "feat(server): VAPID鍵の生成・永続化 loadOrCreateVapidKeys を追加"
```

---

## Task 6: 送信ラッパと失効購読の掃除（`push/send.ts`）

**Files:**
- Create: `apps/server/src/push/send.ts`
- Test: `apps/server/src/__tests__/push-send.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/server/src/__tests__/push-send.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import webpush from 'web-push'
import { createSender } from '../push/send'
import { createPushStore } from '../push/store'
import type { PushSubscriptionJSON } from '../push/types'

function sub(endpoint: string): PushSubscriptionJSON {
  return { endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }
}

describe('createSender', () => {
  test('全購読へ送信する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-send-'))
    const store = createPushStore(dir)
    store.addSubscription(sub('https://a'))
    store.addSubscription(sub('https://b'))
    const sent: string[] = []
    const sender = createSender(store, async (s) => {
      sent.push(s.endpoint)
      return { statusCode: 201, body: '', headers: {} }
    })
    await sender.sendToAll('{"title":"t"}')
    expect(sent.sort()).toEqual(['https://a', 'https://b'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('410/404 の購読は store から削除する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-send-'))
    const store = createPushStore(dir)
    store.addSubscription(sub('https://gone'))
    store.addSubscription(sub('https://ok'))
    const sender = createSender(store, async (s) => {
      if (s.endpoint === 'https://gone') throw { statusCode: 410 }
      return { statusCode: 201, body: '', headers: {} }
    })
    await sender.sendToAll('{"title":"t"}')
    expect(store.listSubscriptions().map((s) => s.endpoint)).toEqual(['https://ok'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('web-push が Bun で有効なリクエストを生成できる（互換 smoke）', () => {
    const keys = webpush.generateVAPIDKeys()
    webpush.setVapidDetails('mailto:test@example.com', keys.publicKey, keys.privateKey)
    const details = webpush.generateRequestDetails({ endpoint: 'https://example.com/ep' }, null)
    expect(details.method).toBe('POST')
    expect(details.endpoint).toBe('https://example.com/ep')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/server && bun test src/__tests__/push-send.test.ts`
Expected: FAIL（`Cannot find module '../push/send'`）

- [ ] **Step 3: 実装**

Create `apps/server/src/push/send.ts`:

```ts
import webpush from 'web-push'
import type { PushStore } from './store'
import type { PushSubscriptionJSON } from './types'

interface SendResult {
  statusCode: number
  body: string
  headers: Record<string, string>
}

type SendFn = (sub: PushSubscriptionJSON, payload: string) => Promise<SendResult>

export interface Sender {
  sendToAll(payload: string): Promise<void>
}

// 全購読へ payload を送信する。送信関数は注入可能（テスト用）。VAPID は index.ts で
// setVapidDetails 済み。endpoint が失効(410/404)した購読は store から取り除く。
export function createSender(store: PushStore, send: SendFn = defaultSend): Sender {
  return {
    async sendToAll(payload) {
      await Promise.all(
        store.listSubscriptions().map(async (sub) => {
          try {
            await send(sub, payload)
          } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode
            if (statusCode === 410 || statusCode === 404) {
              store.removeSubscription(sub.endpoint)
            } else {
              console.error('[push] send error:', statusCode ?? (err as Error).message ?? err)
            }
          }
        }),
      )
    },
  }
}

function defaultSend(sub: PushSubscriptionJSON, payload: string): Promise<SendResult> {
  return webpush.sendNotification(sub, payload) as Promise<SendResult>
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/server && bun test src/__tests__/push-send.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/push/send.ts apps/server/src/__tests__/push-send.test.ts
git commit -m "feat(server): Web Push 送信ラッパと失効購読の掃除を追加"
```

---

## Task 7: 行フレーマ抽出 と cmux RPC 接続（`line-framer.ts` / `push/rpc-connection.ts`）

**Files:**
- Create: `apps/server/src/line-framer.ts`
- Modify: `apps/server/src/ws.ts`（`createLineFramer` を抽出先から import）
- Create: `apps/server/src/push/rpc-connection.ts`
- Test: `apps/server/src/__tests__/push-rpc-connection.test.ts`

- [ ] **Step 1: createLineFramer を抽出**

Create `apps/server/src/line-framer.ts`:

```ts
import { StringDecoder } from 'node:string_decoder'

// UTF-8 安全な行フレーマ。net.Socket の data チャンクは UTF-8 文字や行の途中で切れ得るため、
// data.toString() を直接連結すると絵文字(4byte)/CJK(3byte) 等のマルチバイト文字がチャンク境界で
// 分割され、各破片が U+FFFD(画面上は「?」)に化ける(→「??」)。StringDecoder で未完成バイトを次
// チャンクまで保持して文字境界を跨いで復元し、改行で区切った完全な行(空行除く)だけを返す。
export function createLineFramer(): { push(chunk: Buffer): string[] } {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  return {
    push(chunk: Buffer): string[] {
      buffer += decoder.write(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      return lines.filter((line) => line.trim() !== '')
    },
  }
}
```

- [ ] **Step 2: ws.ts を抽出先 import に切り替える**

In `apps/server/src/ws.ts`:
- 先頭の `import { StringDecoder } from 'node:string_decoder'` を削除し、代わりに `import { createLineFramer } from './line-framer'` を追加する。
- ファイル中の `createLineFramer` 関数定義（`// UTF-8 安全な行フレーマ...` のコメントから関数全体まで）を削除する。
- `createLineFramer()` を呼んでいる箇所（`const framer = createLineFramer()`）はそのまま（import 経由で解決される）。

注意: `ws.ts` が他から `createLineFramer` を import していないか確認する。

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor/.worktrees/web-push-notifications
grep -rn "from './ws'" apps/server/src | grep -i framer || echo "no external importers of createLineFramer"
```
Expected: no external importers（`ws.ts` 内のみで使用）。もし他に import 元があれば `./line-framer` へ向ける。

- [ ] **Step 3: ws の既存テストが通ることを確認（リグレッション）**

Run: `cd apps/server && bun test src/__tests__/ws.test.ts`
Expected: PASS（抽出前と同じ結果）

- [ ] **Step 4: rpc-connection の失敗テストを書く**

Create `apps/server/src/__tests__/push-rpc-connection.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpcConnection } from '../push/rpc-connection'

let server: Server | null = null
let dir: string | null = null
afterEach(() => {
  server?.close()
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

// 1 行受け取り、その id で canned レスポンスを返す擬似 cmux ソケット。
function startFakeCmux(sockPath: string, result: unknown): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((conn) => {
      conn.on('data', (data) => {
        for (const line of data.toString().split('\n')) {
          if (!line.trim()) continue
          const req = JSON.parse(line)
          conn.write(`${JSON.stringify({ id: req.id, ok: true, result })}\n`)
        }
      })
    })
    server.listen(sockPath, resolve)
  })
}

describe('createRpcConnection', () => {
  test('request が id 相関で result を解決する', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rpc-conn-'))
    const sockPath = join(dir, 'cmux.sock')
    await startFakeCmux(sockPath, { notifications: [{ id: 'n1' }] })
    const conn = createRpcConnection(sockPath)
    const res = await conn.request<{ notifications: { id: string }[] }>('notification.list')
    expect(res.notifications[0].id).toBe('n1')
    conn.close()
  })
})
```

- [ ] **Step 5: テストが失敗することを確認**

Run: `cd apps/server && bun test src/__tests__/push-rpc-connection.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 6: 実装**

Create `apps/server/src/push/rpc-connection.ts`:

```ts
import { Socket } from 'node:net'
import { createLineFramer } from '../line-framer'
import { resolveCmuxSocketPath } from '../socket-path'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface CmuxResponse {
  id?: string
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

export interface RpcConnection {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>
  isConnected(): boolean
  close(): void
}

const RPC_TIMEOUT_MS = 10_000

// ポーラー専用の cmux RPC 接続。{ id, method, params } を送り、id 相関で result を解決する。
// UTF-8 安全な行フレーマで通知本文(日本語)の文字化けを防ぐ。1 接続を使い回し、切断時は次の
// request で再接続する。
export function createRpcConnection(socketPath: string = resolveCmuxSocketPath()): RpcConnection {
  let socket: Socket | null = null
  let nextId = 0
  const pending = new Map<string, Pending>()
  const framer = createLineFramer()

  function rejectAll(err: Error): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  function ensureConnected(): Promise<Socket> {
    if (socket && !socket.destroyed) return Promise.resolve(socket)
    return new Promise((resolve, reject) => {
      const s = new Socket()
      const timeout = setTimeout(() => {
        s.destroy()
        reject(new Error('cmux connect timeout'))
      }, RPC_TIMEOUT_MS)

      s.on('error', (err) => {
        clearTimeout(timeout)
        s.destroy()
        socket = null
        reject(err)
      })
      s.on('close', () => {
        socket = null
        rejectAll(new Error('cmux socket closed'))
      })
      s.on('data', (data: Buffer) => {
        for (const line of framer.push(data)) {
          let parsed: CmuxResponse | null = null
          try {
            parsed = JSON.parse(line) as CmuxResponse
          } catch {
            parsed = null
          }
          if (!parsed || parsed.id == null) continue
          const p = pending.get(parsed.id)
          if (!p) continue
          pending.delete(parsed.id)
          clearTimeout(p.timer)
          if (parsed.error || parsed.ok === false) p.reject(new Error(parsed.error?.message ?? 'cmux rpc error'))
          else p.resolve(parsed.result)
        }
      })
      s.connect(socketPath, () => {
        clearTimeout(timeout)
        socket = s
        resolve(s)
      })
    })
  }

  return {
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const s = await ensureConnected()
      const id = String(++nextId)
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`cmux rpc timeout: ${method}`))
        }, RPC_TIMEOUT_MS)
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        try {
          s.write(`${JSON.stringify({ id, method, params })}\n`)
        } catch (err) {
          pending.delete(id)
          clearTimeout(timer)
          reject(err as Error)
        }
      })
    },
    isConnected: () => socket !== null && !socket.destroyed,
    close: () => {
      socket?.destroy()
      socket = null
    },
  }
}
```

- [ ] **Step 7: テスト合格を確認**

Run: `cd apps/server && bun test src/__tests__/push-rpc-connection.test.ts src/__tests__/ws.test.ts`
Expected: PASS（rpc-connection 1 test + ws 既存テスト）

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/line-framer.ts apps/server/src/ws.ts apps/server/src/push/rpc-connection.ts apps/server/src/__tests__/push-rpc-connection.test.ts
git commit -m "refactor(server): 行フレーマを line-framer.ts へ抽出し push 用 cmux RPC 接続を追加"
```

---

## Task 8: バックグラウンドポーラー（`push/poller.ts`）

**Files:**
- Create: `apps/server/src/push/poller.ts`
- Test: `apps/server/src/__tests__/push-poller.test.ts`

ポーリング 1 サイクルを純粋に近い `runPollCycle` として切り出し、タイマーや cmux 接続なしでテストする。`createPoller` がそれを setInterval で回す。

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/server/src/__tests__/push-poller.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPollCycle } from '../push/poller'
import { createPushStore } from '../push/store'
import type { Sender } from '../push/send'
import type { CmuxNotification } from '../push/types'

function note(partial: Partial<CmuxNotification>): CmuxNotification {
  return {
    id: 'n1',
    title: 't',
    subtitle: '',
    body: '',
    workspace_id: 'ws',
    surface_id: 'sf',
    is_read: false,
    ...partial,
  }
}

function fakeSender(): { sender: Sender; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    sender: {
      async sendToAll(payload) {
        sent.push(payload)
      },
    },
  }
}

describe('runPollCycle', () => {
  test('初回(seeded=false)は既存通知を seed し送信しない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'))
    const store = createPushStore(dir)
    const { sender, sent } = fakeSender()
    const list = [note({ id: 'a', body: 'waiting for your input' })]
    const out = await runPollCycle({ list: async () => list, store, sender }, false)
    expect(out.seeded).toBe(true)
    expect(sent.length).toBe(0)
    expect(store.seenHas('a')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('seed 後の新着 actionable のみ送信し seen に記録する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'))
    const store = createPushStore(dir)
    const { sender, sent } = fakeSender()
    // 2 回目: 新着 actionable(b) + 非 actionable(c) + 既読(d)
    const list = [
      note({ id: 'b', body: 'permission required' }),
      note({ id: 'c', body: 'just an update' }),
      note({ id: 'd', body: 'waiting for your input', is_read: true }),
    ]
    const out = await runPollCycle({ list: async () => list, store, sender }, true)
    expect(out.seeded).toBe(true)
    expect(sent.length).toBe(1)
    expect(store.seenHas('b')).toBe(true)
    // 3 回目: 同じ b は再送しない
    const out2 = await runPollCycle({ list: async () => list, store, sender }, true)
    expect(sent.length).toBe(1)
    expect(out2.seeded).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/server && bun test src/__tests__/push-poller.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装**

Create `apps/server/src/push/poller.ts`:

```ts
import { isActionable } from './filter'
import { buildPayload } from './payload'
import { createRpcConnection, type RpcConnection } from './rpc-connection'
import type { Sender } from './send'
import type { PushStore } from './store'
import type { CmuxNotification } from './types'

interface PollCycleDeps {
  list: () => Promise<CmuxNotification[]>
  store: PushStore
  sender: Sender
}

// ポーリング 1 サイクル。初回(seeded=false)は既存通知を seen に seed して送信せず(バックログ
// 一斉送信の防止)、以降は未 seen の actionable のみ送る。送信済みは seen へ記録する。
export async function runPollCycle(deps: PollCycleDeps, seeded: boolean): Promise<{ seeded: boolean }> {
  const list = await deps.list()
  if (!seeded) {
    deps.store.seedSeen(list.map((n) => n.id))
    return { seeded: true }
  }
  const fresh = list.filter((n) => isActionable(n) && !deps.store.seenHas(n.id))
  for (const n of fresh) {
    await deps.sender.sendToAll(buildPayload(n))
    deps.store.seenAdd(n.id)
  }
  return { seeded: true }
}

export interface Poller {
  refresh(): void
  stop(): void
}

// 購読が 1 件以上ある時のみ ~pollMs 間隔で動くポーラー。subscribe/unsubscribe 時に refresh()
// を呼ぶ。cmux 接続は使い回し、エラー時は接続を破棄して次サイクルで再接続する。
export function createPoller(opts: {
  store: PushStore
  sender: Sender
  pollMs: number
  connect?: () => RpcConnection
}): Poller {
  const connect = opts.connect ?? (() => createRpcConnection())
  let conn: RpcConnection | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let seeded = false
  let ticking = false

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const result = await runPollCycle(
        {
          store: opts.store,
          sender: opts.sender,
          list: async () => {
            if (!conn) conn = connect()
            const res = await conn.request<{ notifications?: CmuxNotification[] }>('notification.list')
            return res.notifications ?? []
          },
        },
        seeded,
      )
      seeded = result.seeded
    } catch (err) {
      // cmux 切断/RPC エラー: 接続を捨てて次サイクルで再接続する。致命的にしない。
      console.error('[push] poll cycle error:', (err as Error).message ?? err)
      conn?.close()
      conn = null
    } finally {
      ticking = false
    }
  }

  function start(): void {
    seeded = false
    void tick()
    timer = setInterval(() => void tick(), opts.pollMs)
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    conn?.close()
    conn = null
    seeded = false
  }

  return {
    refresh() {
      const hasSubs = opts.store.listSubscriptions().length > 0
      if (hasSubs && !timer) start()
      else if (!hasSubs && timer) stop()
    },
    stop,
  }
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/server && bun test src/__tests__/push-poller.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/push/poller.ts apps/server/src/__tests__/push-poller.test.ts
git commit -m "feat(server): バックグラウンドポーラー(seed/dedup/再接続)を追加"
```

---

## Task 9: 購読エンドポイント（`push/routes.ts`）

**Files:**
- Create: `apps/server/src/push/routes.ts`
- Test: `apps/server/src/__tests__/push-routes.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/server/src/__tests__/push-routes.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPushRoutes } from '../push/routes'
import { createPushStore } from '../push/store'

const TOKEN = 'test-token'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'push-routes-'))
  const store = createPushStore(dir)
  let changes = 0
  const app = createPushRoutes({
    store,
    vapidPublicKey: 'PUBKEY',
    authToken: TOKEN,
    onChange: () => {
      changes++
    },
  })
  return { dir, store, app, getChanges: () => changes }
}

const auth = { Authorization: `Bearer ${TOKEN}` }
const validSub = {
  endpoint: 'https://push.example/abc',
  expirationTime: null,
  keys: { p256dh: 'p', auth: 'a' },
}

describe('createPushRoutes', () => {
  test('トークン無しは 401', async () => {
    const { app, dir } = setup()
    const res = await app.request('/push/vapid-public-key')
    expect(res.status).toBe(401)
    rmSync(dir, { recursive: true, force: true })
  })

  test('トークンありで公開鍵を返す', async () => {
    const { app, dir } = setup()
    const res = await app.request('/push/vapid-public-key', { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ publicKey: 'PUBKEY' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('subscribe で購読が保存され onChange が呼ばれる', async () => {
    const { app, store, getChanges, dir } = setup()
    const res = await app.request('/push/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(validSub),
    })
    expect(res.status).toBe(200)
    expect(store.listSubscriptions()).toHaveLength(1)
    expect(getChanges()).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('不正な subscribe body は 400', async () => {
    const { app, dir } = setup()
    const res = await app.request('/push/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://x' }),
    })
    expect(res.status).toBe(400)
    rmSync(dir, { recursive: true, force: true })
  })

  test('unsubscribe で購読が削除される', async () => {
    const { app, store, dir } = setup()
    store.addSubscription(validSub)
    const res = await app.request('/push/unsubscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: validSub.endpoint }),
    })
    expect(res.status).toBe(200)
    expect(store.listSubscriptions()).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/server && bun test src/__tests__/push-routes.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: 実装**

Create `apps/server/src/push/routes.ts`:

```ts
import { Hono } from 'hono'
import { tokenEquals } from '../auth'
import type { PushStore } from './store'

interface SubscribeBody {
  endpoint?: string
  expirationTime?: number | null
  keys?: { p256dh?: string; auth?: string }
}

interface UnsubscribeBody {
  endpoint?: string
}

// push 購読エンドポイント。全て共有トークン(Authorization: Bearer)で保護する。
export function createPushRoutes(opts: {
  store: PushStore
  vapidPublicKey: string
  authToken: string
  onChange: () => void
}): Hono {
  const app = new Hono()

  app.use('/push/*', async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!tokenEquals(opts.authToken, token)) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  })

  app.get('/push/vapid-public-key', (c) => c.json({ publicKey: opts.vapidPublicKey }))

  app.post('/push/subscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SubscribeBody
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return c.json({ error: 'Invalid subscription' }, 400)
    }
    opts.store.addSubscription({
      endpoint: body.endpoint,
      expirationTime: body.expirationTime ?? null,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    })
    opts.onChange()
    return c.json({ ok: true })
  })

  app.post('/push/unsubscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as UnsubscribeBody
    if (!body.endpoint) return c.json({ error: 'Invalid request' }, 400)
    opts.store.removeSubscription(body.endpoint)
    opts.onChange()
    return c.json({ ok: true })
  })

  return app
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/server && bun test src/__tests__/push-routes.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/push/routes.ts apps/server/src/__tests__/push-routes.test.ts
git commit -m "feat(server): push購読エンドポイント(/push/*)を追加"
```

---

## Task 10: サーバー起動への組み込み（`index.ts`）

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: import とブートストラップを追加**

In `apps/server/src/index.ts`、既存 import 群の末尾（`import { createWebSocketHandler, type WSData } from './ws'` の後）に追加:

```ts
import webpush from 'web-push'

import { createPoller } from './push/poller'
import { createPushRoutes } from './push/routes'
import { createSender } from './push/send'
import { createPushStore } from './push/store'
import { loadOrCreateVapidKeys } from './push/vapid'
```

`const clientDistPath = join(import.meta.dir, '../../client/dist')` の直後に追加:

```ts
// Web Push: VAPID 鍵を読み込み(無ければ生成)、送信ライブラリに設定。購読ストアと、
// WS 接続の有無に依らず動くバックグラウンドポーラー(購読が 1 件以上ある時のみ稼働)を用意する。
const runDir = join(import.meta.dir, '../.run')
const vapidKeys = loadOrCreateVapidKeys(join(runDir, 'push-vapid.json'))
webpush.setVapidDetails(
  process.env.CMUX_PUSH_SUBJECT ?? 'mailto:cmux-remote@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey,
)
const pushStore = createPushStore(runDir)
const pushSender = createSender(pushStore)
const pushPoller = createPoller({
  store: pushStore,
  sender: pushSender,
  pollMs: parseInt(process.env.CMUX_PUSH_POLL_MS ?? '10000', 10),
})
const pushRoutes = createPushRoutes({
  store: pushStore,
  vapidPublicKey: vapidKeys.publicKey,
  authToken,
  onChange: () => pushPoller.refresh(),
})
```

- [ ] **Step 2: ルートを静的配信より前にマウントし、ポーラーを起動**

`app.route('/', health)` の直後（`// Static files (PWA)` より前）に追加:

```ts
// Web Push 購読エンドポイント（静的配信のフォールバックより前に登録する）。
app.route('/', pushRoutes)
```

`const server = Bun.serve({ ... })` の定義より後（`console.log(...)` 群の後）に追加:

```ts
// 既に購読が永続化されていれば(再起動後など)ポーラーを起動する。
pushPoller.refresh()
```

- [ ] **Step 3: 型チェックとサーバー全テスト**

Run: `cd apps/server && pnpm exec tsc --noEmit && bun test`
Expected: PASS（全テスト green、型エラーなし）

- [ ] **Step 4: 起動 smoke（任意・cmux 不在でも起動すること）**

Run:
```bash
cd apps/server && timeout 3 bun src/index.ts 2>&1 | head -5 || true
```
Expected: `[server] cmux-remote bridge running on http://127.0.0.1:48701` 等が出力され、push 初期化で例外が出ないこと（VAPID 生成のため `.run/push-vapid.json` が作られる）。注意: 既に :48701 で本番サーバーが動いている場合は EADDRINUSE になり得るので、その場合はこの smoke を skip してよい。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): 起動時にVAPID初期化・push購読ルート・ポーラーを組み込み"
```

---

## Task 11: クライアント push ライブラリ（`lib/push.ts`）

**Files:**
- Create: `apps/client/src/lib/push.ts`
- Test: `apps/client/src/lib/__tests__/push.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `apps/client/src/lib/__tests__/push.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { urlBase64ToUint8Array } from '../push'

describe('urlBase64ToUint8Array', () => {
  it('VAPID 公開鍵(URL-safe base64)を 65 byte の Uint8Array にデコードする', () => {
    const key = 'BGtkbcjrO12YMoDuq2sCQeHlu47uPx3SHTgFKZFYiBW8Qr0D9vgyZSZPdw6_4ZFEI9Snk1VEAj2qTYI1I1YxBXE'
    const out = urlBase64ToUint8Array(key)
    expect(out).toBeInstanceOf(Uint8Array)
    // P-256 の非圧縮公開鍵は 65 byte、先頭は 0x04。
    expect(out.length).toBe(65)
    expect(out[0]).toBe(0x04)
  })

  it('- と _ を + と / に変換する', () => {
    // '-' (0x3e=62) と '_' (0x3f=63) を含む 4 文字 = 3 byte
    const out = urlBase64ToUint8Array('-_-_')
    expect(Array.from(out)).toEqual([0xfb, 0xff, 0xbf])
  })
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/push.test.ts`
Expected: FAIL（`Cannot find module '../push'`）

- [ ] **Step 3: 実装**

Create `apps/client/src/lib/push.ts`:

```ts
import { getAuthToken } from './token'

// Web Push の前提が揃っているか。iOS はホーム画面追加 PWA + 16.4+ + secure context が必須。
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// URL-safe base64 の VAPID 公開鍵を applicationServerKey 用の Uint8Array に変換する。
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${getAuthToken()}` },
  })
}

// 通知許可を要求し PushManager で購読してサーバーへ登録する。許可が下りなければ false。
export async function subscribeToPush(): Promise<boolean> {
  if (!isPushSupported()) return false
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const reg = await navigator.serviceWorker.ready
  const res = await authedFetch('/push/vapid-public-key')
  const { publicKey } = (await res.json()) as { publicKey: string }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  })
  await authedFetch('/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  })
  return true
}

// サーバーから購読を削除し、ブラウザ側の購読も解除する。
export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  await authedFetch('/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  })
  await sub.unsubscribe()
}

// 実際にブラウザ購読が存在するか（トグルの初期表示用）。
export async function isPushSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false
  const reg = await navigator.serviceWorker.ready
  return (await reg.pushManager.getSubscription()) !== null
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/push.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/push.ts apps/client/src/lib/__tests__/push.test.ts
git commit -m "feat(client): Web Push 購読ライブラリ lib/push.ts を追加"
```

---

## Task 12: 設定の push-enabled（`lib/settings.ts`）

**Files:**
- Modify: `apps/client/src/lib/settings.ts`
- Test: `apps/client/src/lib/__tests__/settings.test.ts`（既存に追記）

- [ ] **Step 1: 失敗するテストを追記**

`apps/client/src/lib/__tests__/settings.test.ts` の import に `loadPushEnabled, savePushEnabled` を追加し、末尾に以下の describe を追記:

```ts
describe('push-enabled 設定', () => {
  beforeEach(() => localStorage.clear())

  it('既定は false', () => {
    expect(loadPushEnabled()).toBe(false)
  })

  it('保存して読み戻せる', () => {
    savePushEnabled(true)
    expect(loadPushEnabled()).toBe(true)
    savePushEnabled(false)
    expect(loadPushEnabled()).toBe(false)
  })
})
```

注意: 既存テストに `beforeEach`/`describe`/`it` の import が無ければ vitest の import 行に追加する（`import { beforeEach, describe, expect, it } from 'vitest'`）。

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/settings.test.ts`
Expected: FAIL（`loadPushEnabled` is not exported）

- [ ] **Step 3: 実装**

`apps/client/src/lib/settings.ts` の末尾に追加:

```ts
// Web Push 通知の有効フラグ。実際の購読状態は SW の pushManager.getSubscription() が真実だが、
// トグルの楽観的初期表示用に localStorage にも保持する。
const PUSH_ENABLED_KEY = 'cmux:push-enabled'

export function loadPushEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(PUSH_ENABLED_KEY) === 'true'
}

export function savePushEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(PUSH_ENABLED_KEY, enabled ? 'true' : 'false')
}
```

- [ ] **Step 4: テスト合格を確認**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/settings.test.ts`
Expected: PASS（既存 + 2 new）

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/lib/settings.ts apps/client/src/lib/__tests__/settings.test.ts
git commit -m "feat(client): 設定に push-enabled の load/save を追加"
```

---

## Task 13: injectManifest 移行 と 自前 Service Worker（`sw.ts`）

**Files:**
- Modify: `apps/client/package.json`（workbox devDeps 追加）
- Modify: `apps/client/vite.config.ts`（injectManifest へ）
- Modify: `apps/client/tsconfig.json`（`src/sw.ts` を exclude）
- Create: `apps/client/src/sw.ts`

- [ ] **Step 1: workbox 依存を追加**

```bash
cd apps/client && pnpm add -D workbox-precaching workbox-routing workbox-core
```

Expected: devDependencies に 3 パッケージ追加（`workbox-window` は既存）。

- [ ] **Step 2: vite.config.ts を injectManifest に変更**

`apps/client/vite.config.ts` の `VitePWA({ ... })` を以下に置き換える（既存スタイル＝ダブルクォート＋セミコロンを維持）:

```ts
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      manifest: {
        name: "cmux Remote",
        short_name: "cmux",
        start_url: "/",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#1a1a2e",
        background_color: "#1a1a2e",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm,woff2}"],
      },
    }),
```

注意: injectManifest モードでは `workbox` キーは使わず `injectManifest` キーになる。SPA フォールバックと `/ws`・`/health` の除外は SW 側（Step 4）で `NavigationRoute` の denylist として実装する。

- [ ] **Step 3: tsconfig で sw.ts を除外**

`apps/client/tsconfig.json` の `"include": ["src"]` の後ろに `exclude` を追加する:

```json
  "include": ["src"],
  "exclude": ["src/sw.ts"]
```

理由: アプリ用 tsconfig は `lib: ["DOM", ...]` で、SW のグローバル（`ServiceWorkerGlobalScope`/`PushEvent` 等）と衝突する。SW は vite-plugin-pwa（esbuild）が単独でバンドル・トランスパイルするため、アプリの `tsc` 型チェックからは除外する。

- [ ] **Step 4: 自前 SW を作成**

Create `apps/client/src/sw.ts`:

```ts
/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | PrecacheEntry)[] }

precacheAndRoute(self.__WB_MANIFEST)

// SPA フォールバック。ただし WebSocket ブリッジ(/ws)とヘルスチェック(/health)は横取りしない。
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/ws/, /^\/health/] }))

interface PushData {
  workspace_id?: string
  url?: string
}

interface PushPayload {
  title: string
  body: string
  data?: PushData
}

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return
  let payload: PushPayload
  try {
    payload = event.data.json() as PushPayload
  } catch {
    return
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.data?.workspace_id,
      data: payload.data ?? {},
    }),
  )
})

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  const data = (event.notification.data ?? {}) as PushData
  const workspaceId = data.workspace_id
  const targetUrl = data.url ?? '/'
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of allClients) {
        await client.focus()
        if (workspaceId) client.postMessage({ type: 'navigate', workspaceId })
        return
      }
      await self.clients.openWindow(targetUrl)
    })(),
  )
})

// registerType: 'autoUpdate' 相当の即時反映（injectManifest では自前で行う）。
self.skipWaiting()
clientsClaim()
```

- [ ] **Step 5: ビルドが通ることを確認**

Run: `cd apps/client && pnpm build`
Expected: PASS（`tsc` がエラーなし＝sw.ts は除外され、アプリ型チェックは通る。`vite build` が `dist/sw.js` を生成し、`workbox` の manifest 注入が成功する）。出力に `sw.js` の生成ログが出ること。

- [ ] **Step 6: Commit**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor/.worktrees/web-push-notifications
git add apps/client/package.json apps/client/vite.config.ts apps/client/tsconfig.json apps/client/src/sw.ts pnpm-lock.yaml
git commit -m "feat(client): injectManifest 化し push/notificationclick を処理する自前 SW を追加"
```

---

## Task 14: 設定トグル と ディープリンク配線（`SettingsModal.tsx` / `App.tsx`）

**Files:**
- Modify: `apps/client/src/components/SettingsModal.tsx`
- Modify: `apps/client/src/App.tsx`

- [ ] **Step 1: SettingsModal にトグルを追加**

`apps/client/src/components/SettingsModal.tsx`:

`SettingsModalProps` を以下に変更（3 つの prop を追加）:

```ts
interface SettingsModalProps {
  open: boolean
  historyLines: number
  pushSupported: boolean
  pushEnabled: boolean
  onTogglePush: (enabled: boolean) => void
  onSave: (lines: number) => void
  onClose: () => void
}
```

関数シグネチャを変更:

```ts
export function SettingsModal({
  open,
  historyLines,
  pushSupported,
  pushEnabled,
  onTogglePush,
  onSave,
  onClose,
}: SettingsModalProps) {
```

`<div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>設定</div>` の直後（履歴 `<label htmlFor="history-lines" ...>` より前）に通知トグルセクションを挿入:

```tsx
        <div style={{ marginBottom: 18 }}>
          <label
            htmlFor="push-enabled"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, color: '#aaa' }}
          >
            <span>通知（Web Push）</span>
            <input
              id="push-enabled"
              type="checkbox"
              checked={pushEnabled}
              disabled={!pushSupported}
              onChange={(e) => onTogglePush(e.target.checked)}
              style={{ width: 18, height: 18, accentColor: '#4caf50' }}
            />
          </label>
          {!pushSupported && (
            <div style={{ fontSize: 12, color: '#777', marginTop: 6 }}>
              この環境では利用できません（HTTPS のホーム画面追加 PWA・iOS 16.4+ が必要です）。
            </div>
          )}
        </div>
```

- [ ] **Step 2: App.tsx に push 状態とトグル処理を追加**

`apps/client/src/App.tsx`:

import を追加（`import { loadHistoryLines, saveHistoryLines } from './lib/settings'` を以下へ変更し、push の import を追加）:

```ts
import { isPushSubscribed, isPushSupported, subscribeToPush, unsubscribeFromPush } from './lib/push'
import { loadHistoryLines, loadPushEnabled, savePushEnabled, saveHistoryLines } from './lib/settings'
```

`Main()` 内、`const [settingsOpen, setSettingsOpen] = useState(false)` の直後に追加:

```ts
  // Web Push 通知の有効状態。初期は localStorage の楽観値、マウント後に実購読で補正する。
  const pushSupported = isPushSupported()
  const [pushEnabled, setPushEnabled] = useState(loadPushEnabled)

  useEffect(() => {
    if (!pushSupported) return
    isPushSubscribed()
      .then((subscribed) => {
        setPushEnabled(subscribed)
        savePushEnabled(subscribed)
      })
      .catch(() => {})
  }, [pushSupported])

  // トグル操作(ユーザージェスチャ)で購読/解除する。許可が下りなければ false に戻す。
  const togglePush = useCallback((enabled: boolean) => {
    if (enabled) {
      subscribeToPush()
        .then((ok) => {
          setPushEnabled(ok)
          savePushEnabled(ok)
        })
        .catch((err) => console.error('[app] push subscribe error:', err))
    } else {
      unsubscribeFromPush()
        .then(() => {
          setPushEnabled(false)
          savePushEnabled(false)
        })
        .catch((err) => console.error('[app] push unsubscribe error:', err))
    }
  }, [])
```

- [ ] **Step 3: App.tsx にディープリンク配線を追加**

`const currentWs = workspaces.find((w) => w.ref === currentWorkspace)` の直前に追加:

```ts
  // プッシュ通知タップ後の遷移。?workspace=<id>(新規ウィンドウ)と SW からの postMessage(既存
  // ウィンドウ)の両方で、通知の workspace_id に対応するワークスペースを選択する。
  useEffect(() => {
    if (workspaces.length === 0) return
    const navigateTo = (workspaceId: string) => {
      const target = workspaces.find((w) => w.id === workspaceId)
      if (target) selectWorkspace(target.ref)
    }
    const params = new URLSearchParams(window.location.search)
    const wid = params.get('workspace')
    if (wid) {
      navigateTo(wid)
      params.delete('workspace')
      const qs = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
    const onMessage = (e: MessageEvent) => {
      const data = (e.data ?? {}) as { type?: string; workspaceId?: string }
      if (data.type === 'navigate' && typeof data.workspaceId === 'string') navigateTo(data.workspaceId)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [workspaces, selectWorkspace])
```

- [ ] **Step 4: SettingsModal 呼び出しに props を渡す**

`<SettingsModal ... />` を以下に変更:

```tsx
      <SettingsModal
        open={settingsOpen}
        historyLines={historyLines}
        pushSupported={pushSupported}
        pushEnabled={pushEnabled}
        onTogglePush={togglePush}
        onSave={(lines) => {
          setHistoryLines(lines)
          saveHistoryLines(lines)
        }}
        onClose={() => setSettingsOpen(false)}
      />
```

- [ ] **Step 5: 型チェックとクライアント全テスト**

Run: `cd apps/client && pnpm exec tsc --noEmit && pnpm vitest run`
Expected: PASS（型エラーなし、全テスト green）

- [ ] **Step 6: Commit**

```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor/.worktrees/web-push-notifications
git add apps/client/src/components/SettingsModal.tsx apps/client/src/App.tsx
git commit -m "feat(client): 設定に通知トグルを追加しタップで該当WSへディープリンク"
```

---

## Task 15: ドキュメント更新 と 全体検証

**Files:**
- Modify: `CLAUDE.md`（リポジトリルート）

- [ ] **Step 1: CLAUDE.md に Web Push 構成を追記**

`CLAUDE.md` の「### サーバー (`apps/server/src/`)」セクションの末尾（`health.ts` の項目の後）に追加:

```markdown
- `push/` — Web Push 通知。WS 接続の有無に依らず動く**バックグラウンドポーラー**（`poller.ts`）が専用 cmux 接続（`rpc-connection.ts`、UTF-8 安全な `line-framer.ts` を共用）で `notification.list` を ~10秒間隔ポーリングし、**actionable（Needs input / Permission）かつ未送信の通知のみ**を `web-push`（VAPID）で各購読 endpoint へ送る。`filter.ts`（`isActionable`）/`payload.ts`/`store.ts`（購読・既送信 id を `.run/` に永続）/`send.ts`（410/404 で失効購読を掃除）/`vapid.ts`（`.run/push-vapid.json`）/`routes.ts`（`/push/vapid-public-key`・`/push/subscribe`・`/push/unsubscribe`、共有トークン `Authorization: Bearer` で保護）に分割。起動時に既存通知 id を seed して**バックログを一斉送信しない**。購読が 0 件ならポーラーは停止。env: `CMUX_PUSH_POLL_MS`（既定 10000）/`CMUX_PUSH_SUBJECT`。**dev は HTTP のため Web Push は動かない（secure context 必須）**。
```

`CLAUDE.md` の「### クライアント (`apps/client/src/`)」セクションの `lib/token.ts` 項目の後に追加:

```markdown
- `lib/push.ts` / `sw.ts` — Web Push 購読と Service Worker。**PWA は generateSW から injectManifest へ移行**し（`vite.config.ts` の `strategies: 'injectManifest'`・`srcDir/filename`）、自前 `sw.ts` が `precacheAndRoute` + `NavigationRoute`（SPA フォールバック、`/ws`・`/health` は denylist）に加えて **push / notificationclick** を処理する（タップで既存ウィンドウへ `postMessage({type:'navigate'})`、無ければ `openWindow('/?workspace=<id>')`）。`sw.ts` は DOM lib と衝突するため tsconfig の `exclude` でアプリ `tsc` から外し、vite-plugin-pwa が単独でバンドルする。`lib/push.ts` は許可要求→`pushManager.subscribe`→`POST /push/subscribe`。`SettingsModal` の「通知（Web Push）」トグル（ユーザージェスチャで購読、非対応環境は無効化）で有効化し、`App.tsx` が `?workspace=`／SW メッセージを受けて該当 WS を選択する。
```

- [ ] **Step 2: 全体チェックとテスト**

Run:
```bash
cd /Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor/.worktrees/web-push-notifications
pnpm check && pnpm test
```
Expected: PASS（`tsc --noEmit` + `biome check` 両パッケージ、server `bun test` + client `vitest` 全 green）。biome の指摘があれば `pnpm check:fix` で整形してから再実行。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: Web Push 通知の構成を CLAUDE.md に追記"
```

---

## 完了後の作業（実装者向け）

1. `result.md`（`/Users/yui/Documents/workspace/tanaka-yui/cmux-remote-editor/.dispatch/web-push-notifications/result.md`）に Changes Made / Test Results / Commits と、下記の **手動 iOS 検証手順** を記載する。
2. status.json を done に更新する。

### 手動 iOS 検証手順（result.md に転記する）

1. 本番相当を起動（`pnpm start`。サーバーは host 常駐、nginx は Docker、証明書は mkcert）。iPhone で PWA をホーム画面に追加（iOS 16.4+、初回は `?token=` 付き URL でトークン投入）。
2. 設定（歯車）→「通知（Web Push）」を ON → 通知許可を付与。
3. cmux 側で actionable 通知を発火（Claude 等が権限要求 / 入力待ちになる操作）。
4. PWA を閉じた状態でも iPhone にプッシュ通知が表示されることを確認。
5. 通知をタップ → PWA が開き、該当ワークスペースが選択されることを確認。
6. dev（HTTP, `pnpm dev`）では Web Push は動作しない（secure context 必須）。設定トグルが無効表示になることを確認。

---

## Self-Review チェック結果

- **Spec coverage**: actionable 判定(T2)・ペイロード(T3)・購読/seen 永続化(T4)・VAPID(T5)・送信&失効掃除(T6)・cmux RPC 接続/フレーマ抽出(T7)・ポーラー seed/dedup/再接続(T8)・保護エンドポイント(T9)・起動組み込み(T10)・クライアント購読(T11)・設定永続(T12)・injectManifest+SW(T13)・トグル&ディープリンク(T14)・docs/検証(T15)。spec の全項目をカバー。
- **Placeholder scan**: TBD/TODO 無し。各コード step に実コードを記載。
- **Type consistency**: `CmuxNotification`/`PushSubscriptionJSON`(types.ts)、`PushStore`(store.ts)、`Sender`(send.ts)、`RpcConnection`(rpc-connection.ts)、`createPushRoutes`/`createPoller`/`createSender`/`createPushStore`/`loadOrCreateVapidKeys` のシグネチャは各タスク間で一致。`isActionable` は filter.ts、`buildPayload` は payload.ts、`urlBase64ToUint8Array`/`isPushSupported`/`subscribeToPush`/`unsubscribeFromPush`/`isPushSubscribed` は client push.ts、`loadPushEnabled`/`savePushEnabled` は settings.ts で一貫。
