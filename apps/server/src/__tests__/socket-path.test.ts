import { resolveCmuxSocketPath } from '../socket-path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('resolveCmuxSocketPath', () => {
  const tmpDirs: string[] = []
  let savedEnv: string | undefined

  beforeEach(() => {
    // Isolate from any ambient CMUX_SOCKET_PATH so branch tests are deterministic.
    savedEnv = process.env.CMUX_SOCKET_PATH
    delete process.env.CMUX_SOCKET_PATH
  })

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CMUX_SOCKET_PATH
    else process.env.CMUX_SOCKET_PATH = savedEnv
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cmux-socket-test-'))
    tmpDirs.push(dir)
    return dir
  }

  it('env指定が最優先される', () => {
    const result = resolveCmuxSocketPath({ env: '/custom/cmux.sock' })
    expect(result).toBe('/custom/cmux.sock')
  })

  it('pointerファイルが指す実在ソケットを返す', () => {
    const dir = makeTmpDir()
    const socketPath = join(dir, 'cmux.sock')
    const pointer = join(dir, 'last-socket-path')
    writeFileSync(socketPath, '')
    writeFileSync(pointer, `${socketPath}\n`)

    const result = resolveCmuxSocketPath({ pointerFiles: [pointer] })
    expect(result).toBe(socketPath)
  })

  it('先頭pointerのソケットが存在しなければ次の候補にフォールバックする', () => {
    const dir = makeTmpDir()
    const stalePointer = join(dir, 'stale-last-socket-path')
    const livePointer = join(dir, 'live-last-socket-path')
    const liveSocket = join(dir, 'cmux.sock')
    writeFileSync(stalePointer, `${join(dir, 'missing.sock')}\n`)
    writeFileSync(liveSocket, '')
    writeFileSync(livePointer, `${liveSocket}\n`)

    const result = resolveCmuxSocketPath({ pointerFiles: [stalePointer, livePointer] })
    expect(result).toBe(liveSocket)
  })

  it('有効なpointerが無ければfallbackを返す', () => {
    const result = resolveCmuxSocketPath({
      pointerFiles: ['/nonexistent/last-socket-path'],
      fallback: '/fallback/cmux.sock',
    })
    expect(result).toBe('/fallback/cmux.sock')
  })
})
