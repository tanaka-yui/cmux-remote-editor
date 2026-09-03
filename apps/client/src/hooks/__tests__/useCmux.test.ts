// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCmux } from '../useCmux'

// useWebSocket をモックし、send された payload を捕捉する。
// rpc が解決するよう、送信された各リクエストには成功レスポンスを即座にエコーバックする。
// method 別の result は hoisted.responses で差し替えられる（未設定なら空オブジェクト）。
const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  onMessage: { fn: (_data: string) => {} },
  onClose: { fn: () => {} },
  responses: {} as Record<string, unknown>,
  errors: {} as Record<string, { code: string; message: string }>,
  status: { value: 'connected' as 'connected' | 'disconnected' },
  canSend: { value: true },
  swallow: { value: false },
}))

vi.mock('../useWebSocket', () => ({
  useWebSocket: ({ onMessage, onClose }: { onMessage: (data: string) => void; onClose?: () => void }) => {
    hoisted.onMessage.fn = onMessage
    hoisted.onClose.fn = onClose ?? (() => {})
    return {
      status: hoisted.status.value,
      send: (data: string) => {
        if (!hoisted.canSend.value) return false
        hoisted.sent.push(data)
        if (hoisted.swallow.value) return true
        const req = JSON.parse(data) as { id: string; method: string }
        const error = hoisted.errors[req.method]
        if (error) {
          hoisted.onMessage.fn(JSON.stringify({ id: req.id, ok: false, error }))
          return true
        }
        const result = hoisted.responses[req.method] ?? {}
        hoisted.onMessage.fn(JSON.stringify({ id: req.id, ok: true, result }))
        return true
      },
    }
  },
}))

beforeEach(() => {
  hoisted.sent.length = 0
  hoisted.responses = {}
  hoisted.errors = {}
  hoisted.status.value = 'connected'
  hoisted.canSend.value = true
  hoisted.swallow.value = false
  localStorage.clear()
})

describe('rpc の登録順（同期 echo の回帰ガード）', () => {
  it('send の中で同期的に応答が返っても取りこぼさない', async () => {
    hoisted.responses['surface.read_text'] = { text: 'sync-echo' }
    const { result } = renderHook(() => useCmux())

    await expect(result.current.readText('surface:1')).resolves.toBe('sync-echo')
  })

  it('同期 echo で解決した RPC はタイマーを残さない', async () => {
    vi.useFakeTimers()
    hoisted.responses['surface.read_text'] = { text: 'ok' }
    const { result } = renderHook(() => useCmux())

    await result.current.readText('surface:1')

    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})

describe('D10 切断時の pending RPC', () => {
  it('切断で既存の pending が 10 秒を待たず reject される', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCmux())
    hoisted.swallow.value = true
    let rejected: Error | null = null
    const promise = result.current.readText('surface:1').catch((error: Error) => {
      rejected = error
      return ''
    })

    act(() => {
      hoisted.status.value = 'disconnected'
      hoisted.onClose.fn()
    })

    await promise
    expect(rejected).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('切断中に新しく呼んだ RPC は 10 秒待たず即 reject される', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCmux())

    act(() => {
      hoisted.canSend.value = false
      hoisted.status.value = 'disconnected'
    })

    await expect(result.current.readText('surface:1')).rejects.toThrow(/not connected/i)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('アンマウントでも pending が reject され、タイマーが残らない', async () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useCmux())
    hoisted.swallow.value = true
    const promise = result.current.readText('surface:1').catch(() => 'rejected')

    act(() => {
      unmount()
    })

    await expect(promise).resolves.toBe('rejected')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('reject 後に遅れて届いた応答は破棄される（例外にならない）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.swallow.value = true
    const promise = result.current.readText('surface:1').catch(() => 'rejected')
    const sentId = (JSON.parse(hoisted.sent[hoisted.sent.length - 1] as string) as { id: string }).id

    act(() => {
      hoisted.onClose.fn()
    })

    await promise
    expect(() => {
      hoisted.onMessage.fn(JSON.stringify({ id: sentId, ok: true, result: { text: 'late' } }))
    }).not.toThrow()
  })
})

describe('useCmux closeSurface', () => {
  it('surface.close を surface_id パラメータで送る（cmux ソケットは surface_ref ではなく surface_id を読む）', async () => {
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.closeSurface('surface:42')
    })

    const closeReq = hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, unknown> })
      .find((req) => req.method === 'surface.close')

    expect(closeReq).toBeDefined()
    expect(closeReq?.params).toEqual({ surface_id: 'surface:42' })
    expect(closeReq?.params).not.toHaveProperty('surface_ref')
  })
})

// cmux ソケットの surface.read_text / send_text / send_key は surface_ref を無視して
// フォーカス中サーフェスにフォールバックする（実機プローブで確認）。surface_id が正。
describe('useCmux surface RPC params', () => {
  const findReq = (method: string) =>
    hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, unknown> })
      .find((req) => req.method === method)

  it('surface.read_text を surface_id で送る（surface_ref はフォーカス中タブへフォールバックする）', async () => {
    hoisted.responses['surface.read_text'] = { text: 'hello' }
    const { result } = renderHook(() => useCmux())

    let text = ''
    await act(async () => {
      text = await result.current.readText('surface:7', { scrollback: true, lines: 50 })
    })

    expect(text).toBe('hello')
    const req = findReq('surface.read_text')
    expect(req?.params).toEqual({ surface_id: 'surface:7', scrollback: true, lines: 50 })
    expect(req?.params).not.toHaveProperty('surface_ref')
  })

  it('surface.send_text を surface_id で送る', async () => {
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.sendText('surface:7', 'ls')
    })
    expect(findReq('surface.send_text')?.params).toEqual({ surface_id: 'surface:7', text: 'ls' })
  })

  it('surface.send_key を surface_id で送る', async () => {
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.sendKey('surface:7', 'enter')
    })
    expect(findReq('surface.send_key')?.params).toEqual({ surface_id: 'surface:7', key: 'enter' })
  })

  it('readGrid は terminal.replay を surface_id で送り render_grid を返す', async () => {
    const grid = { columns: 80, rows: 24, styles: [], row_spans: [] }
    hoisted.responses['terminal.replay'] = { render_grid: grid, surface_id: 'surface:7' }
    const { result } = renderHook(() => useCmux())

    let got: unknown
    await act(async () => {
      got = await result.current.readGrid('surface:7')
    })

    expect(got).toEqual(grid)
    const req = findReq('terminal.replay')
    expect(req?.params).toEqual({ surface_id: 'surface:7' })
    expect(req?.params).not.toHaveProperty('surface_ref')
  })

  it('readGrid は render_grid が無い（端末未起動で停止中）場合 null を返す', async () => {
    // タブだけ開いて zsh が起動していない停止状態では terminal.replay が render_grid を返さない。
    // undefined をそのまま返すと App→Terminal で grid.columns を評価して落ちる（useGrid の
    // `!== null` 厳密比較を undefined がすり抜ける）ため、ここで null に正規化する。
    hoisted.responses['terminal.replay'] = { surface_id: 'surface:7' }
    const { result } = renderHook(() => useCmux())

    let got: unknown = 'sentinel'
    await act(async () => {
      got = await result.current.readGrid('surface:7')
    })

    expect(got).toBeNull()
  })

  it('cmux エラー時は code を載せた Error で reject する（App の stale-surface 判定に使う）', async () => {
    hoisted.errors['terminal.replay'] = { code: 'invalid_params', message: 'Missing or invalid terminal_id' }
    const { result } = renderHook(() => useCmux())

    let caught: unknown
    await act(async () => {
      caught = await result.current.readGrid('surface:dead').catch((e) => e)
    })

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('Missing or invalid terminal_id')
    expect((caught as Error & { code?: string }).code).toBe('invalid_params')
  })
})

describe('D1 workspace.select を一度も呼ばない', () => {
  it('createWorkspace でも closeWorkspace でも workspace.select が飛ばない', async () => {
    hoisted.responses['workspace.create'] = {
      workspace_ref: 'workspace:30',
      workspace_id: 'C459840B-0000-0000-0000-000000000030',
      surface_ref: 'surface:200',
      surface_id: 'S-200',
    }
    hoisted.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:200',
          selected: true,
          title: 'zsh',
          type: 'terminal',
          workspace_ref: 'workspace:30',
          workspace_title: '30',
          workspace_id: 'C459840B-0000-0000-0000-000000000030',
        },
      ],
    }
    hoisted.responses['workspace.list'] = { workspaces: [{ ref: 'workspace:30' }] }
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.createWorkspace()
      await result.current.closeWorkspace('workspace:30')
    })

    const methods = hoisted.sent.map((raw) => (JSON.parse(raw) as { method: string }).method)
    expect(methods).not.toContain('workspace.select')
  })

  it('selectWorkspace は公開 API から消えている', () => {
    const { result } = renderHook(() => useCmux())
    expect('selectWorkspace' in result.current).toBe(false)
  })

  it('移行用 shim（currentSurface / focusSurface）はまだ残っている', () => {
    const { result } = renderHook(() => useCmux())
    expect('currentSurface' in result.current).toBe(true)
    expect(typeof result.current.focusSurface).toBe('function')
  })

  it('closeWorkspace は workspace と surface の一覧を各 1 回更新する', async () => {
    hoisted.responses['workspace.list'] = { workspaces: [] }
    hoisted.responses['surface.list'] = { surfaces: [] }
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.closeWorkspace('workspace:30')
    })

    const methods = hoisted.sent.map((raw) => (JSON.parse(raw) as { method: string }).method)
    expect(methods.filter((method) => method === 'workspace.list')).toHaveLength(1)
    expect(methods.filter((method) => method === 'surface.list')).toHaveLength(1)
  })
})

describe('D1.1 createWorkspace の 3 手順', () => {
  it('surface.create を呼ばず、workspace.create が返した surface を前面化する', async () => {
    hoisted.responses['workspace.create'] = {
      workspace_ref: 'workspace:30',
      workspace_id: 'C459840B-0000-0000-0000-000000000030',
      surface_ref: 'surface:200',
      surface_id: 'S-200',
    }
    hoisted.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:200',
          selected: true,
          title: 'zsh',
          type: 'terminal',
          workspace_ref: 'workspace:30',
          workspace_title: '30',
          workspace_id: 'C459840B-0000-0000-0000-000000000030',
        },
      ],
    }
    hoisted.responses['workspace.list'] = { workspaces: [{ ref: 'workspace:30' }] }
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.createWorkspace()
    })

    const methods = hoisted.sent.map((raw) => (JSON.parse(raw) as { method: string }).method)
    expect(methods).not.toContain('surface.create')
    expect(methods.filter((method) => method === 'surface.list')).toHaveLength(1)
    expect(result.current.view.foreground).toBe('surface:200')
    expect(result.current.view.subscriptions.map((subscription) => subscription.ref)).toContain('surface:200')
  })

  it('返った surface_ref が一覧に無ければ前面を変えず、エラーにもしない', async () => {
    hoisted.responses['workspace.create'] = { workspace_ref: 'workspace:30', surface_ref: 'surface:999' }
    hoisted.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:1',
          selected: true,
          title: 'a',
          type: 'terminal',
          workspace_ref: 'workspace:1',
          workspace_title: '1',
          workspace_id: 'W1',
        },
      ],
    }
    const { result } = renderHook(() => useCmux())
    act(() => {
      result.current.initializeFrom(
        [{ ref: 'surface:1', type: 'terminal', workspace_ref: 'workspace:1', index: 0 }],
        null,
      )
    })

    await act(async () => {
      await expect(result.current.createWorkspace()).resolves.toBeDefined()
    })

    expect(result.current.view.foreground).toBe('surface:1')
  })
})

describe('P7/P8/P9 createSurface', () => {
  it('workspace_id を渡し、レスポンスの surface_ref を前面化する（差分探索をしない）', async () => {
    hoisted.responses['surface.create'] = {
      surface_ref: 'surface:118',
      surface_id: 'S-118',
      workspace_id: 'W26',
      type: 'terminal',
    }
    hoisted.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:118',
          selected: true,
          title: 'zsh',
          type: 'terminal',
          workspace_ref: 'workspace:26',
          workspace_title: '26',
          workspace_id: 'W26',
        },
      ],
    }
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.createSurface('W26')
    })

    const create = hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, string | undefined> })
      .find((request) => request.method === 'surface.create')
    expect(create?.params.workspace_id).toBe('W26')
    expect(create?.params.workspace_ref).toBeUndefined()
    expect(result.current.view.foreground).toBe('surface:118')
  })

  it('レスポンスの workspace_id が要求と違えば警告を返すが、端末は残す（P8）', async () => {
    hoisted.responses['surface.create'] = { surface_ref: 'surface:118', workspace_id: 'W1' }
    hoisted.responses['surface.list'] = {
      surfaces: [
        {
          index: 0,
          ref: 'surface:118',
          selected: true,
          title: 'zsh',
          type: 'terminal',
          workspace_ref: 'workspace:1',
          workspace_title: '1',
          workspace_id: 'W1',
        },
      ],
    }
    const { result } = renderHook(() => useCmux())
    let outcome: { misplaced: boolean } | undefined

    await act(async () => {
      outcome = await result.current.createSurface('W26')
    })

    expect(outcome?.misplaced).toBe(true)
    expect(result.current.view.foreground).toBe('surface:118')
  })
})

describe('listSurfaces は全ワークスペースを取る', () => {
  it('workspace_ref を渡さない', async () => {
    hoisted.responses['surface.list'] = { surfaces: [] }
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.listSurfaces()
    })

    const request = hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, string | undefined> })
      .find((candidate) => candidate.method === 'surface.list')
    expect(request?.params.workspace_ref).toBeUndefined()
  })
})

describe('currentWorkspace は導出値', () => {
  it('前面のワークスペースに追従する', () => {
    const { result } = renderHook(() => useCmux())
    act(() => {
      result.current.initializeFrom(
        [
          { ref: 'surface:1', type: 'terminal', workspace_ref: 'workspace:1', index: 0 },
          { ref: 'surface:2', type: 'terminal', workspace_ref: 'workspace:26', index: 1 },
        ],
        'surface:2',
      )
    })
    expect(result.current.currentWorkspace).toBe('workspace:26')
  })
})

describe('D3.1 selectSurface の原子性（合成 reducer の結合テスト）', () => {
  const renderCounts: { view: string | null; feedStatus: string | undefined }[] = []

  function useTrackingHook() {
    const cmux = useCmux()
    renderCounts.push({
      view: cmux.view.foreground,
      feedStatus: cmux.view.foreground === null ? undefined : cmux.feeds.get(cmux.view.foreground)?.status,
    })
    return cmux
  }

  beforeEach(() => {
    renderCounts.length = 0
    localStorage.clear()
  })

  it('none: 最初のコミットで loading/none になっている（中間コミットが無い）', () => {
    const { result } = renderHook(() => useTrackingHook())
    const surfaces = [{ ref: 'surface:1', type: 'terminal', workspace_ref: 'workspace:1', index: 0 }]
    act(() => {
      result.current.initializeFrom(surfaces, 'surface:1')
    })
    const firstWithForeground = renderCounts.find((render) => render.view === 'surface:1')
    expect(firstWithForeground?.feedStatus).toBe('loading')
  })

  it('cache: 最初のコミットで warming/cache になっている', () => {
    localStorage.setItem('cmux-surface-cache:surface:1', JSON.stringify({ scrollback: 'cached', updatedAt: 500 }))
    const { result } = renderHook(() => useTrackingHook())
    const surfaces = [{ ref: 'surface:1', type: 'terminal', workspace_ref: 'workspace:1', index: 0 }]
    act(() => {
      result.current.initializeFrom(surfaces, 'surface:1')
    })
    const first = renderCounts.find((render) => render.view === 'surface:1')
    expect(first?.feedStatus).toBe('warming')
    expect(result.current.feeds.get('surface:1')?.source).toBe('cache')
  })

  it('focus / promote は hook の公開 API に出ていない', () => {
    const { result } = renderHook(() => useCmux())
    expect('focus' in result.current).toBe(false)
    expect('promote' in result.current).toBe(false)
    expect('reconcile' in result.current).toBe(false)
    expect('initialize' in result.current).toBe(false)
  })
})

describe('既存ガードの複数端末版', () => {
  it('read_text / terminal.replay / send_text は surface_id を使い surface_ref を使わない', async () => {
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.readText('surface:5')
      await result.current.readGrid('surface:6')
      await result.current.sendText('surface:7', 'ls')
    })
    const requests = hoisted.sent.map(
      (raw) => JSON.parse(raw) as { method: string; params: Record<string, string | number | boolean | undefined> },
    )
    for (const method of ['surface.read_text', 'terminal.replay', 'surface.send_text']) {
      const request = requests.find((candidate) => candidate.method === method)
      expect(request?.params.surface_ref).toBeUndefined()
      expect(typeof request?.params.surface_id).toBe('string')
    }
  })
})
