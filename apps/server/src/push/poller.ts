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
