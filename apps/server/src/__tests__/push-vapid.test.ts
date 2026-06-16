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
