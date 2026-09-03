// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const serviceWorker = {
  listener: (_event: MessageEvent) => {},
}

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
  serviceWorker.listener = () => {}
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        serviceWorker.listener = listener
      },
      removeEventListener: vi.fn(),
    },
  })
})

describe('App 結合 — topology 再取得と bootstrap (D2.1)', () => {
  it('topology RPC の待機中は空状態を出さず、空 snapshot の bootstrap 後だけ「端末がありません」を出す', async () => {
    emptyTopology()
    ws.hold.add('surface.list')

    render(<App />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('読み込み中')).toBeTruthy()
    expect(screen.queryByText('端末がありません')).toBeNull()

    await act(async () => {
      releaseHeld('surface.list')
      await Promise.resolve()
    })

    expect(await screen.findByText('端末がありません')).toBeTruthy()
    expect(screen.queryByText('読み込み中')).toBeNull()
  })

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

  it('workspace.list が先に返り surface.list が遅れても UUID の通知先を保持する', async () => {
    sessionStorage.setItem('cmux:foreground', 'surface:1')
    window.history.replaceState({}, '', '/?workspace=W26')
    ws.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:1',
          selected: true,
          title: 'initial',
          type: 'browser',
          workspace_ref: 'workspace:1',
          workspace_title: 'Initial Workspace',
          workspace_id: 'W1',
          url: 'https://example.com/initial',
        },
        {
          index: 1,
          ref: 'surface:26',
          selected: false,
          title: 'push-target',
          type: 'browser',
          workspace_ref: 'workspace:26',
          workspace_title: 'Push Workspace',
          workspace_id: 'W26',
          url: 'https://example.com/target',
        },
      ],
    }
    ws.responses['workspace.list'] = {
      workspaces: [
        { id: 'W1', ref: 'workspace:1', title: 'Initial Workspace', index: 0 },
        { id: 'W26', ref: 'workspace:26', title: 'Push Workspace', index: 1 },
      ],
    }
    ws.responses['notification.list'] = { notifications: [] }
    ws.hold.add('surface.list')

    render(<App />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.location.search).toBe('')
    expect(sessionStorage.getItem('cmux:foreground')).toBe('surface:1')
    expect(screen.queryByText('push-target')).toBeNull()

    await act(async () => {
      releaseHeld('surface.list')
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('Push Workspace'))
    expect(sessionStorage.getItem('cmux:foreground')).toBe('surface:26')
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

describe('App 結合 — タブ作成と browser 分岐', () => {
  const browserSurface = {
    index: 0,
    ref: 'surface:26',
    selected: true,
    title: 'docs',
    type: 'browser',
    workspace_ref: 'workspace:26',
    workspace_title: 'Push Workspace',
    workspace_id: 'W26',
    url: 'https://example.com/docs',
  }

  beforeEach(() => {
    ws.responses['surface.list'] = { surfaces: [browserSurface] }
    ws.responses['workspace.list'] = {
      workspaces: [{ id: 'W26', ref: 'workspace:26', title: 'Push Workspace', index: 0 }],
    }
    ws.responses['notification.list'] = { notifications: [] }
  })

  it('タブの + は前面 workspace の UUID を workspace_id に指定する', async () => {
    ws.responses['surface.create'] = { surface_ref: 'surface:118', workspace_id: 'W26' }
    render(<App />)
    await screen.findByText('新しいタブで開く ↗')

    fireEvent.click(screen.getByLabelText('New tab'))

    await waitFor(() => expect(countOf('surface.create')).toBe(1))
    const create = sentRequests().find((request) => request.method === 'surface.create')
    expect(create?.params.workspace_id).toBe('W26')
    expect(create?.params.workspace_ref).toBeUndefined()
  })

  it('P8 の誤配置は browser を残して警告し surface.close で rollback しない', async () => {
    ws.responses['surface.create'] = { surface_ref: 'surface:118', workspace_id: 'W1' }
    render(<App />)
    await screen.findByText('新しいタブで開く ↗')

    fireEvent.click(screen.getByLabelText('New tab'))

    expect(await screen.findByText('別のワークスペースに作成されました')).toBeTruthy()
    expect(screen.getByText('新しいタブで開く ↗')).toBeTruthy()
    expect(countOf('surface.close')).toBe(0)
  })

  it('browser は BrowserView を描き InputBar を無効化し terminal.replay を送らない', async () => {
    render(<App />)

    await screen.findByText('新しいタブで開く ↗')
    expect((screen.getByPlaceholderText('No tab selected') as HTMLInputElement).disabled).toBe(true)
    expect(countOf('terminal.replay')).toBe(0)
  })
})

describe('App 結合 — マウント後の Push 通知ジャンプ', () => {
  beforeEach(() => {
    ws.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:1',
          selected: true,
          title: 'initial',
          type: 'terminal',
          workspace_ref: 'workspace:1',
          workspace_title: 'Initial Workspace',
          workspace_id: 'W1',
        },
        {
          index: 1,
          ref: 'surface:26',
          selected: false,
          title: 'push-target',
          type: 'terminal',
          workspace_ref: 'workspace:26',
          workspace_title: 'Push Workspace',
          workspace_id: 'W26',
        },
      ],
    }
    ws.responses['workspace.list'] = {
      workspaces: [
        { id: 'W1', ref: 'workspace:1', title: 'Initial Workspace', index: 0 },
        { id: 'W26', ref: 'workspace:26', title: 'Push Workspace', index: 1 },
      ],
    }
    ws.responses['notification.list'] = { notifications: [] }
    ws.responses['terminal.replay'] = {
      render_grid: {
        columns: 80,
        rows: 24,
        styles: [],
        row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 4, text: 'live' }],
      },
    }
    ws.responses['surface.read_text'] = { text: 'live' }
  })

  it('selectSurface を通して通知先へ移り、既存の購読集合を保持する', async () => {
    render(<App />)
    const target = await screen.findByRole('tab', { name: /Push Workspace \/ push-target/ })

    fireEvent.click(target)
    fireEvent.click(screen.getByRole('tab', { name: /Initial Workspace \/ initial/ }))
    await waitFor(() => expect(document.querySelectorAll('[data-testid="live-dot"]').length).toBe(2))
    const beforeDots = document.querySelectorAll('[data-testid="live-dot"]').length

    act(() => {
      serviceWorker.listener(new MessageEvent('message', { data: { type: 'navigate', workspaceId: 'W26' } }))
    })

    expect(screen.getByRole('tab', { name: /Push Workspace \/ push-target/, selected: true })).toBeTruthy()
    expect(document.querySelectorAll('[data-testid="live-dot"]').length).toBeGreaterThanOrEqual(beforeDots)
    expect(countOf('workspace.select')).toBe(0)
  })

  it('workspace ref を渡しても UUID として解決しない', async () => {
    render(<App />)
    await screen.findByRole('tab', { name: /Initial Workspace \/ initial/, selected: true })

    act(() => {
      serviceWorker.listener(new MessageEvent('message', { data: { type: 'navigate', workspaceId: 'workspace:26' } }))
    })

    expect(screen.getByRole('tab', { name: /Initial Workspace \/ initial/, selected: true })).toBeTruthy()
  })
})

describe('App 結合 — 実 Terminal の feed 描画', () => {
  it('replay の grid 内容と read_text の履歴を実 Terminal に渡して縦積み描画する', async () => {
    ws.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:1',
          selected: true,
          title: 'terminal',
          type: 'terminal',
          workspace_ref: 'workspace:1',
          workspace_title: 'Terminal Workspace',
          workspace_id: 'W1',
        },
      ],
    }
    ws.responses['workspace.list'] = {
      workspaces: [{ id: 'W1', ref: 'workspace:1', title: 'Terminal Workspace', index: 0 }],
    }
    ws.responses['notification.list'] = { notifications: [] }
    ws.responses['terminal.replay'] = {
      render_grid: {
        columns: 80,
        rows: 24,
        styles: [],
        row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 9, text: 'live-grid' }],
      },
    }
    ws.responses['surface.read_text'] = { text: 'history-line\nlive-grid' }

    const { container } = render(<App />)

    const history = await screen.findByText('history-line')
    const wterm = container.querySelector<HTMLElement>('.wterm')
    expect(history.tagName).toBe('PRE')
    expect(history.textContent).toBe('history-line')
    if (!wterm) throw new Error('実 Terminal がマウントされていません')
    expect(wterm.style.display).not.toBe('none')
    expect(history.nextElementSibling).toBe(wterm)
    await waitFor(() => expect(wterm.querySelector('.term-grid')?.textContent).toContain('live-grid'))
    expect(
      sentRequests().some(
        (request) => request.method === 'terminal.replay' && request.params.surface_id === 'surface:1',
      ),
    ).toBe(true)
    expect(
      sentRequests().some(
        (request) => request.method === 'surface.read_text' && request.params.surface_id === 'surface:1',
      ),
    ).toBe(true)
  })
})
