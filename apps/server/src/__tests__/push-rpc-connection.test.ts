import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
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
