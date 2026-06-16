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
