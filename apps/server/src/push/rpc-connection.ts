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
