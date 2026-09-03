// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface HarnessRequest {
  id: string
  method: string
  params: { [key: string]: JsonValue }
}

const ws = vi.hoisted(() => ({
  sent: [] as string[],
  onMessage: { fn: (_data: string) => {} },
  responses: {} as Record<string, JsonValue>,
  errors: {} as Record<string, { code: string; message: string }>,
  held: {} as Record<string, HarnessRequest[]>,
  hold: new Set<string>(),
}))

vi.mock('../hooks/useWebSocket', () => {
  const respond = (request: HarnessRequest) => {
    const error = ws.errors[request.method]
    if (error) {
      ws.onMessage.fn(JSON.stringify({ id: request.id, ok: false, error }))
      return
    }
    ws.onMessage.fn(JSON.stringify({ id: request.id, ok: true, result: ws.responses[request.method] ?? {} }))
  }
  const send = (data: string) => {
    ws.sent.push(data)
    const request = JSON.parse(data) as HarnessRequest
    if (ws.hold.has(request.method)) {
      const held = ws.held[request.method] ?? []
      held.push(request)
      ws.held[request.method] = held
      return true
    }
    respond(request)
    return true
  }
  return {
    useWebSocket: ({ onMessage }: { onMessage: (data: string) => void }) => {
      ws.onMessage.fn = onMessage
      return { status: 'connected' as const, send }
    },
  }
})

function sentRequests(): HarnessRequest[] {
  return ws.sent.map((data) => JSON.parse(data) as HarnessRequest)
}

function countOf(method: string): number {
  return sentRequests().filter((request) => request.method === method).length
}

function releaseHeld(method: string): void {
  ws.hold.delete(method)
  for (const request of ws.held[method] ?? []) {
    const error = ws.errors[request.method]
    if (error) ws.onMessage.fn(JSON.stringify({ id: request.id, ok: false, error }))
    else {
      ws.onMessage.fn(JSON.stringify({ id: request.id, ok: true, result: ws.responses[request.method] ?? {} }))
    }
  }
  ws.held[method] = []
}

const emptyTopology = () => {
  ws.responses['surface.list'] = { surfaces: [] }
  ws.responses['workspace.list'] = { workspaces: [] }
  ws.responses['notification.list'] = { notifications: [] }
}

beforeEach(() => {
  ws.sent.length = 0
  ws.responses = {}
  ws.errors = {}
  ws.held = {}
  ws.hold.clear()
  localStorage.clear()
  localStorage.setItem('cmux-remote-token', 'test-token')
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('App 結合 — topology 再取得と bootstrap (D2.1)', () => {
  it('マウントして接続したとき surface.list / workspace.list はそれぞれ 1 本だけ', async () => {
    emptyTopology()
    ws.hold.add('surface.list')

    render(<App />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(countOf('surface.list')).toBe(1)
    expect(countOf('workspace.list')).toBe(1)
    await act(async () => {
      releaseHeld('surface.list')
      await Promise.resolve()
    })
  })

  it('直接取得の経路が存在せず、workspace_ref 付きの surface.list が飛ばない', async () => {
    emptyTopology()
    ws.responses['workspace.list'] = {
      workspaces: [{ id: 'W1', ref: 'workspace:1', title: 'one', index: 0 }],
    }

    render(<App />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const listRequests = sentRequests().filter((request) => request.method === 'surface.list')
    expect(listRequests).toHaveLength(1)
    expect(listRequests.every((request) => request.params.workspace_ref === undefined)).toBe(true)
  })

  it('成功した空 snapshot でも bootstrap が完了し「端末がありません」を描画する', async () => {
    emptyTopology()

    render(<App />)

    expect(await screen.findByText('端末がありません')).toBeTruthy()
  })

  it('初回 snapshot の先頭を中間前面化せず、sessionStorage の preferred surface を選ぶ', async () => {
    sessionStorage.setItem('cmux:foreground', 'surface:2')
    ws.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:1',
          selected: false,
          title: 'first',
          type: 'browser',
          workspace_ref: 'workspace:1',
          workspace_title: 'First Workspace',
          workspace_id: 'W1',
          url: 'https://example.com/first',
        },
        {
          index: 1,
          ref: 'surface:2',
          selected: false,
          title: 'preferred',
          type: 'browser',
          workspace_ref: 'workspace:2',
          workspace_title: 'Preferred Workspace',
          workspace_id: 'W2',
          url: 'https://example.com/preferred',
        },
      ],
    }
    ws.responses['workspace.list'] = {
      workspaces: [
        { id: 'W1', ref: 'workspace:1', title: 'First Workspace', index: 0 },
        { id: 'W2', ref: 'workspace:2', title: 'Preferred Workspace', index: 1 },
      ],
    }
    ws.responses['notification.list'] = { notifications: [] }

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('banner').textContent).toContain('Preferred Workspace')
    })
    expect(sessionStorage.getItem('cmux:foreground')).toBe('surface:2')
  })

  it('T4: stale surface エラーを検出したとき共通 topology refresh を 1 回要求する', async () => {
    ws.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:dead',
          selected: true,
          title: 'dead',
          type: 'terminal',
          workspace_ref: 'workspace:1',
          workspace_title: 'one',
          workspace_id: 'W1',
        },
      ],
    }
    ws.responses['workspace.list'] = {
      workspaces: [{ id: 'W1', ref: 'workspace:1', title: 'one', index: 0 }],
    }
    ws.responses['notification.list'] = { notifications: [] }
    ws.errors['terminal.replay'] = { code: 'not_found', message: 'surface is gone' }

    render(<App />)

    await waitFor(() => expect(countOf('surface.list')).toBe(2))
    expect(countOf('workspace.list')).toBe(2)
  })
})
