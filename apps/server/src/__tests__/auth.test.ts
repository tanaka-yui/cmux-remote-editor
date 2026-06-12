import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadOrCreateToken, tokenEquals } from '../auth'

describe('loadOrCreateToken', () => {
  let dir: string
  let envBackup: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmux-auth-'))
    envBackup = process.env.CMUX_REMOTE_TOKEN
    delete process.env.CMUX_REMOTE_TOKEN
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (envBackup === undefined) delete process.env.CMUX_REMOTE_TOKEN
    else process.env.CMUX_REMOTE_TOKEN = envBackup
  })

  it('環境変数 CMUX_REMOTE_TOKEN を最優先で使う', () => {
    process.env.CMUX_REMOTE_TOKEN = 'env-token'
    expect(loadOrCreateToken(join(dir, 'token'))).toBe('env-token')
  })

  it('ファイルが無ければ生成して永続化し、再呼び出しで同じ値を返す', () => {
    const file = join(dir, 'token')
    const token = loadOrCreateToken(file)
    expect(token.length).toBeGreaterThanOrEqual(24)
    expect(readFileSync(file, 'utf8').trim()).toBe(token)
    expect(loadOrCreateToken(file)).toBe(token)
  })

  it('既存ファイルの値を再利用する', () => {
    const file = join(dir, 'token')
    writeFileSync(file, 'persisted-token\n')
    expect(loadOrCreateToken(file)).toBe('persisted-token')
  })
})

describe('tokenEquals', () => {
  it('完全一致の場合のみ true を返す', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true)
    expect(tokenEquals('abc', 'abd')).toBe(false)
    expect(tokenEquals('abc', 'abcd')).toBe(false)
    expect(tokenEquals('abc', null)).toBe(false)
    expect(tokenEquals('abc', '')).toBe(false)
  })
})
