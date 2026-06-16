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
