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
    // payload=null なら暗号化は行われないため keys はダミーで良い（型上は keys が必須）。
    const details = webpush.generateRequestDetails(
      { endpoint: 'https://example.com/ep', keys: { p256dh: 'p', auth: 'a' } },
      null,
    )
    expect(details.method).toBe('POST')
    expect(details.endpoint).toBe('https://example.com/ep')
  })
})
