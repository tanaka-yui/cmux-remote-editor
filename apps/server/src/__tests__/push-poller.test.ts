import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPollCycle } from '../push/poller'
import type { Sender } from '../push/send'
import { createPushStore } from '../push/store'
import type { CmuxNotification } from '../push/types'

function note(partial: Partial<CmuxNotification>): CmuxNotification {
  return {
    id: 'n1',
    title: 't',
    subtitle: '',
    body: '',
    workspace_id: 'ws',
    surface_id: 'sf',
    is_read: false,
    ...partial,
  }
}

function fakeSender(): { sender: Sender; sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    sender: {
      async sendToAll(payload) {
        sent.push(payload)
      },
    },
  }
}

describe('runPollCycle', () => {
  test('初回(seeded=false)は既存通知を seed し送信しない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'))
    const store = createPushStore(dir)
    const { sender, sent } = fakeSender()
    const list = [note({ id: 'a', body: 'waiting for your input' })]
    const out = await runPollCycle({ list: async () => list, store, sender }, false)
    expect(out.seeded).toBe(true)
    expect(sent.length).toBe(0)
    expect(store.seenHas('a')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('seed 後の新着 actionable のみ送信し seen に記録する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'))
    const store = createPushStore(dir)
    const { sender, sent } = fakeSender()
    // 2 回目: 新着 actionable(b) + 非 actionable(c) + 既読(d)
    const list = [
      note({ id: 'b', body: 'permission required' }),
      note({ id: 'c', body: 'just an update' }),
      note({ id: 'd', body: 'waiting for your input', is_read: true }),
    ]
    const out = await runPollCycle({ list: async () => list, store, sender }, true)
    expect(out.seeded).toBe(true)
    expect(sent.length).toBe(1)
    expect(store.seenHas('b')).toBe(true)
    // 3 回目: 同じ b は再送しない
    const out2 = await runPollCycle({ list: async () => list, store, sender }, true)
    expect(sent.length).toBe(1)
    expect(out2.seeded).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
