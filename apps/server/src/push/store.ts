import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PushSubscriptionJSON } from './types'

function readJsonArray<T>(file: string): T[] {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function writeJson(file: string, value: PushSubscriptionJSON[] | string[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
}

export interface PushStore {
  listSubscriptions(): PushSubscriptionJSON[]
  addSubscription(sub: PushSubscriptionJSON): void
  removeSubscription(endpoint: string): void
  seenHas(id: string): boolean
  seenAdd(id: string): void
  seedSeen(ids: string[]): void
}

// 購読(push-subscriptions.json)と既送信 id(push-seen.json)をディレクトリ配下に永続化するストア。
// 状態はメモリにも保持し、変更時にファイルへ書き出す。テストでは temp dir を渡す。
export function createPushStore(dir: string): PushStore {
  const subsFile = join(dir, 'push-subscriptions.json')
  const seenFile = join(dir, 'push-seen.json')
  const subscriptions = readJsonArray<PushSubscriptionJSON>(subsFile)
  const seen = new Set<string>(readJsonArray<string>(seenFile))

  return {
    listSubscriptions: () => subscriptions.slice(),
    addSubscription(sub) {
      if (subscriptions.some((s) => s.endpoint === sub.endpoint)) return
      subscriptions.push(sub)
      writeJson(subsFile, subscriptions)
    },
    removeSubscription(endpoint) {
      const i = subscriptions.findIndex((s) => s.endpoint === endpoint)
      if (i === -1) return
      subscriptions.splice(i, 1)
      writeJson(subsFile, subscriptions)
    },
    seenHas: (id) => seen.has(id),
    seenAdd(id) {
      if (seen.has(id)) return
      seen.add(id)
      writeJson(seenFile, [...seen])
    },
    seedSeen(ids) {
      let changed = false
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id)
          changed = true
        }
      }
      if (changed) writeJson(seenFile, [...seen])
    },
  }
}
