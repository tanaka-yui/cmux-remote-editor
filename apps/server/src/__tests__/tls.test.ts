import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadTlsOptions } from '../tls'

describe('loadTlsOptions', () => {
  let dir: string
  let certPath: string
  let keyPath: string
  let envBackup: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmux-tls-'))
    certPath = join(dir, 'server.pem')
    keyPath = join(dir, 'server-key.pem')
    writeFileSync(certPath, 'cert')
    writeFileSync(keyPath, 'key')
    envBackup = process.env.CMUX_REMOTE_TLS
    delete process.env.CMUX_REMOTE_TLS
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (envBackup === undefined) delete process.env.CMUX_REMOTE_TLS
    else process.env.CMUX_REMOTE_TLS = envBackup
  })

  it('CMUX_REMOTE_TLS が未設定なら undefined を返す（dev は HTTP のまま）', () => {
    expect(loadTlsOptions(certPath, keyPath)).toBeUndefined()
  })

  it('有効かつ証明書が存在すれば cert/key を返す', () => {
    const opts = loadTlsOptions(certPath, keyPath, true)
    expect(opts).toBeDefined()
    expect(opts?.cert.name).toBe(certPath)
    expect(opts?.key.name).toBe(keyPath)
  })

  it('有効だが証明書ファイルが無ければ throw する', () => {
    expect(() => loadTlsOptions(join(dir, 'missing.pem'), join(dir, 'missing-key.pem'), true)).toThrow()
  })

  it('CMUX_REMOTE_TLS=1 を読み取って TLS を有効化する', () => {
    process.env.CMUX_REMOTE_TLS = '1'
    const opts = loadTlsOptions(certPath, keyPath)
    expect(opts?.cert.name).toBe(certPath)
  })
})
