// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Surface } from '../../lib/cmux-rpc'
import { MAX_LIVE_SUBSCRIPTIONS, TOPOLOGY_POLL_INTERVAL } from '../../lib/view-state'
import { type TopologySnapshot, useCmux } from '../useCmux'

interface HeldRequest {
  id: string
  method: string
}

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
  gate: {
    open: true,
    openFor: {} as Record<string, boolean>,
    held: [] as HeldRequest[],
    release: (_method?: string) => {},
  },
}))

vi.mock('../useWebSocket', () => {
  const respond = (req: HeldRequest) => {
    const error = hoisted.errors[req.method]
    if (error) {
      hoisted.onMessage.fn(JSON.stringify({ id: req.id, ok: false, error }))
      return
    }
    const result = hoisted.responses[req.method] ?? {}
    hoisted.onMessage.fn(JSON.stringify({ id: req.id, ok: true, result }))
  }
  hoisted.gate.release = (method?: string) => {
    const released = hoisted.gate.held.filter((req) => method === undefined || req.method === method)
    hoisted.gate.held = hoisted.gate.held.filter((req) => method !== undefined && req.method !== method)
    for (const req of released) respond(req)
  }
  const send = (data: string) => {
    if (!hoisted.canSend.value) return false
    hoisted.sent.push(data)
    if (hoisted.swallow.value) return true
    const req = JSON.parse(data) as HeldRequest
    const methodOpen =
      req.method in hoisted.gate.openFor ? hoisted.gate.openFor[req.method] === true : hoisted.gate.open
    const isTopologyList = req.method === 'surface.list' || req.method === 'workspace.list'
    if (isTopologyList && !methodOpen) {
      hoisted.gate.held.push(req)
      return true
    }
    respond(req)
    return true
  }
  return {
    useWebSocket: ({ onMessage, onClose }: { onMessage: (data: string) => void; onClose?: () => void }) => {
      hoisted.onMessage.fn = onMessage
      hoisted.onClose.fn = onClose ?? (() => {})
      return {
        status: hoisted.status.value,
        send,
      }
    },
  }
})

beforeEach(() => {
  vi.restoreAllMocks()
  hoisted.sent.length = 0
  hoisted.responses = {}
  hoisted.errors = {}
  hoisted.status.value = 'disconnected'
  hoisted.canSend.value = true
  hoisted.swallow.value = false
  hoisted.gate.open = true
  hoisted.gate.openFor = {}
  hoisted.gate.held = []
  localStorage.clear()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
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

  it('retained memory: 追い出し後の再昇格で、最初のコミットが warming/memory になる', () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now++)
    const { result } = renderHook(() => useTrackingHook())
    // 公開 selectSurface は cap = MAX_LIVE_SUBSCRIPTIONS 固定なので、確実に追い出すには
    // 上限 + 1 件を順に選ぶ必要がある（2 件では追い出されず F4 のままになる）。
    const surfaces = Array.from({ length: MAX_LIVE_SUBSCRIPTIONS + 1 }, (_, i) => ({
      ref: `surface:${i}`,
      type: 'terminal',
      workspace_ref: 'workspace:1',
      index: i,
    }))
    act(() => {
      result.current.initializeFrom(surfaces, 'surface:0')
    })
    act(() => {
      result.current.applyFeedResult({
        ref: 'surface:0',
        epoch: 1,
        grid: { columns: 80, rows: 1, styles: [], row_spans: [] },
        now: 2000,
      })
    })
    expect(result.current.feeds.get('surface:0')).toMatchObject({ status: 'live', source: 'memory' })
    // surface:1 〜 surface:8 を順に選ぶと、最古の surface:0 が購読集合から外れる
    for (let i = 1; i <= MAX_LIVE_SUBSCRIPTIONS; i++) {
      act(() => {
        result.current.selectSurface(surfaces[i] as Surface)
      })
    }
    expect(result.current.view.subscriptions.map((x) => x.ref)).not.toContain('surface:0')
    // feed は D3.2 で保持され、status/source は F10 で据え置き
    expect(result.current.feeds.get('surface:0')).toMatchObject({ status: 'live', source: 'memory' })
    const epochBefore = result.current.feeds.get('surface:0')?.epoch as number

    renderCounts.length = 0
    act(() => {
      result.current.selectSurface(surfaces[0] as Surface)
    })
    const first = renderCounts.find((render) => render.view === 'surface:0')
    // 再昇格なので F1: 最初のコミットで warming/memory になっていること（live のままは不可）
    expect(first?.feedStatus).toBe('warming')
    expect(result.current.feeds.get('surface:0')?.source).toBe('memory')
    expect(result.current.feeds.get('surface:0')?.epoch).toBe(epochBefore + 1)
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

const topologySurface = (ref: string, workspaceRef = 'workspace:1', index = 0): Surface => ({
  index,
  ref,
  selected: false,
  title: ref,
  type: 'terminal',
  workspace_ref: workspaceRef,
  workspace_title: workspaceRef,
  workspace_id: workspaceRef.replace('workspace:', 'W'),
})

describe('D2.1 topology 再取得ループ', () => {
  beforeEach(() => {
    hoisted.status.value = 'connected'
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.responses['workspace.list'] = { workspaces: [] }
  })

  it('single-flight: in-flight 中に何回要求しても同時に 2 本投げない', () => {
    hoisted.status.value = 'disconnected'
    hoisted.gate.open = false
    const { result, unmount } = renderHook(() => useCmux())

    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
      void result.current.requestTopologyRefresh().catch(() => undefined)
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })

    const listCalls = hoisted.sent.filter((raw) => (JSON.parse(raw) as { method: string }).method === 'surface.list')
    expect(listCalls).toHaveLength(1)
    unmount()
  })

  it('in-flight 中に来た要求は 1 件だけ queue され、完了後に follow-up が 1 回走る', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.gate.open = false
    const { result } = renderHook(() => useCmux())
    act(() => {
      void result.current.requestTopologyRefresh()
    })
    act(() => {
      void result.current.requestTopologyRefresh()
      void result.current.requestTopologyRefresh()
    })

    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })

    const listCalls = hoisted.sent.filter((raw) => (JSON.parse(raw) as { method: string }).method === 'surface.list')
    expect(listCalls).toHaveLength(2)
  })

  it('follow-up の実行中にさらに要求すると、もう 1 回走る（dirty は開始前に消費する）', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.gate.open = false
    const { result } = renderHook(() => useCmux())
    act(() => {
      void result.current.requestTopologyRefresh()
      void result.current.requestTopologyRefresh()
    })
    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    act(() => {
      void result.current.requestTopologyRefresh()
    })
    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })

    const listCalls = hoisted.sent.filter((raw) => (JSON.parse(raw) as { method: string }).method === 'surface.list')
    expect(listCalls).toHaveLength(3)
  })

  it('requestTopologyRefresh は取得した一覧そのものを返す（React state のクロージャに依存しない）', async () => {
    hoisted.status.value = 'disconnected'
    const surface = topologySurface('surface:200', 'workspace:30')
    hoisted.responses['surface.list'] = { surfaces: [surface] }
    hoisted.responses['workspace.list'] = {
      workspaces: [{ id: 'W30', ref: 'workspace:30', title: 'new', index: 0 }],
    }
    const { result } = renderHook(() => useCmux())
    let snapshot: TopologySnapshot | undefined

    await act(async () => {
      snapshot = await result.current.requestTopologyRefresh()
    })

    expect(snapshot?.surfaces.map((candidate) => candidate.ref)).toEqual(['surface:200'])
    expect(snapshot?.workspaces.map((workspace) => workspace.ref)).toEqual(['workspace:30'])
  })

  it('取得に失敗した refresh は resolve せず reject する（古い一覧を適用済みとして扱わない）', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await expect(result.current.requestTopologyRefresh()).rejects.toThrow('boom')
    })
  })

  it('hidden 中に返った応答は state へ反映しない（D2.1 の E4）', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.responses['surface.list'] = { surfaces: [topologySurface('surface:1')] }
    hoisted.gate.open = false
    const { result } = renderHook(() => useCmux())
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })

    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })

    expect(result.current.surfaces).toHaveLength(0)
  })

  it('復帰イベントが重なっても T5 のタイマーは常に 1 本', async () => {
    vi.useFakeTimers()
    renderHook(() => useCmux())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pageshow'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    const before = hoisted.sent.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPOLOGY_POLL_INTERVAL)
    })

    const listCalls = hoisted.sent
      .slice(before)
      .filter((raw) => (JSON.parse(raw) as { method: string }).method === 'surface.list')
    expect(listCalls).toHaveLength(1)
    vi.useRealTimers()
  })

  it('requestTopologyRefresh は「自分の要求を包含する refresh の適用」まで resolve しない', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.gate.open = false
    const { result } = renderHook(() => useCmux())
    let first: TopologySnapshot | undefined
    let second: TopologySnapshot | undefined
    act(() => {
      void result.current.requestTopologyRefresh().then((snapshot) => {
        first = snapshot
      })
      void result.current.requestTopologyRefresh().then((snapshot) => {
        second = snapshot
      })
    })

    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    expect(first?.generation).toBe(1)
    expect(second).toBeUndefined()

    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    expect(second?.generation).toBe(2)
  })

  it('先行 refresh が失敗しても queued waiter は宙に浮かない（follow-up の成功で resolve）', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.gate.open = false
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    const { result } = renderHook(() => useCmux())
    let first: 'resolved' | 'rejected' | undefined
    let second: 'resolved' | 'rejected' | undefined
    act(() => {
      void result.current.requestTopologyRefresh().then(
        () => {
          first = 'resolved'
        },
        () => {
          first = 'rejected'
        },
      )
      void result.current.requestTopologyRefresh().then(
        () => {
          second = 'resolved'
        },
        () => {
          second = 'rejected'
        },
      )
    })

    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    expect(first).toBe('rejected')
    delete hoisted.errors['surface.list']
    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    expect(second).toBe('resolved')
  })

  it('follow-up も失敗すれば queued waiter は reject される（settle せずに残らない）', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.gate.open = false
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    const { result } = renderHook(() => useCmux())
    let second: 'resolved' | 'rejected' | undefined
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
      void result.current.requestTopologyRefresh().then(
        () => {
          second = 'resolved'
        },
        () => {
          second = 'rejected'
        },
      )
    })

    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    expect(second).toBe('rejected')
  })

  it('hidden 中はタイマーを張らず、復帰で再開する', async () => {
    vi.useFakeTimers()
    renderHook(() => useCmux())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const before = hoisted.sent.length
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPOLOGY_POLL_INTERVAL * 3)
    })
    expect(hoisted.sent.length).toBe(before)

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hoisted.sent.length).toBeGreaterThan(before)
    vi.useRealTimers()
  })

  it('T1・T2・T3・T5 の各契機が再取得を起こす', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCmux())
    const count = () =>
      hoisted.sent.filter((raw) => (JSON.parse(raw) as { method: string }).method === 'surface.list').length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(count()).toBe(1)

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(count()).toBe(2)

    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    expect(count()).toBe(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPOLOGY_POLL_INTERVAL)
    })
    expect(count()).toBe(4)
    vi.useRealTimers()
  })

  it('外部での create/close/move が一覧へ反映される', async () => {
    hoisted.status.value = 'disconnected'
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = { surfaces: [topologySurface('surface:1')] }
    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    act(() => {
      result.current.initializeFrom(result.current.surfaces, 'surface:1')
    })
    hoisted.responses['surface.list'] = {
      surfaces: [topologySurface('surface:2'), topologySurface('surface:119', 'workspace:26', 1)],
    }

    await act(async () => {
      await result.current.requestTopologyRefresh()
    })

    expect(result.current.surfaces.map((surface) => surface.ref)).toEqual(['surface:2', 'surface:119'])
    expect(result.current.view.subscriptions.map((subscription) => subscription.ref)).not.toContain('surface:1')
  })

  it('closeWorkspace の後に surface と workspace の一覧が同じ refresh で更新される', async () => {
    hoisted.status.value = 'disconnected'
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.closeWorkspace('workspace:26')
    })

    const methods = hoisted.sent.map((raw) => (JSON.parse(raw) as { method: string }).method)
    expect(methods.filter((method) => method === 'surface.list')).toHaveLength(1)
    expect(methods.filter((method) => method === 'workspace.list')).toHaveLength(1)
  })

  it('workspace.create の T3 が既存の T5 in-flight と衝突しても、作成後の snapshot を見る', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.gate.open = false
    const createdSurface = topologySurface('surface:200', 'workspace:30')
    const { result } = renderHook(() => useCmux())
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    hoisted.responses['workspace.create'] = { workspace_ref: 'workspace:30', surface_ref: 'surface:200' }
    hoisted.responses['surface.list'] = { surfaces: [createdSurface] }
    hoisted.responses['workspace.list'] = {
      workspaces: [{ id: 'W30', ref: 'workspace:30', title: 'new', index: 0 }],
    }

    await act(async () => {
      const done = result.current.createWorkspace()
      hoisted.gate.release()
      await vi.waitFor(() => {
        expect(hoisted.gate.held).toHaveLength(2)
      })
      hoisted.gate.release()
      await done
    })

    expect(result.current.view.foreground).toBe('surface:200')
  })

  it('mutation 後の follow-up が失敗したら前面を変えず、エラーにもしない', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.responses['surface.list'] = { surfaces: [topologySurface('surface:1')] }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    act(() => {
      result.current.initializeFrom(result.current.surfaces, 'surface:1')
    })
    hoisted.responses['workspace.create'] = { workspace_ref: 'workspace:30', surface_ref: 'surface:200' }
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }

    await act(async () => {
      await expect(result.current.createWorkspace()).resolves.toBeDefined()
    })

    expect(result.current.view.foreground).toBe('surface:1')
  })

  it('片方の list が先に失敗しても、もう片方が settle するまで follow-up を始めない', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    hoisted.gate.openFor = { 'surface.list': true, 'workspace.list': false }
    const { result } = renderHook(() => useCmux())
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    await act(async () => {
      await Promise.resolve()
    })
    const count = (method: string) =>
      hoisted.sent.filter((raw) => (JSON.parse(raw) as { method: string }).method === method).length
    expect(count('workspace.list')).toBe(1)

    await act(async () => {
      hoisted.gate.release('workspace.list')
      await Promise.resolve()
    })
    expect(count('workspace.list')).toBe(2)
  })

  it('hidden 中に溜めた waiter は unmount で reject される（永久未 settle にしない）', async () => {
    hoisted.status.value = 'disconnected'
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const { result, unmount } = renderHook(() => useCmux())
    let settled: 'resolved' | 'rejected' | undefined
    act(() => {
      void result.current.requestTopologyRefresh().then(
        () => {
          settled = 'resolved'
        },
        () => {
          settled = 'rejected'
        },
      )
    })
    expect(settled).toBeUndefined()

    await act(async () => {
      unmount()
    })
    expect(settled).toBe('rejected')
  })

  it('hidden 中の直接 requestTopologyRefresh は RPC を 0 件に保ち、復帰時に回収する', async () => {
    vi.useFakeTimers()
    hoisted.status.value = 'connected'
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const { result } = renderHook(() => useCmux())
    let settled = false
    act(() => {
      void result.current.requestTopologyRefresh().then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
    })
    expect(hoisted.sent).toHaveLength(0)
    expect(settled).toBe(false)

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(settled).toBe(true)
    vi.useRealTimers()
  })

  it('in-flight 中に dirty → hidden → 先行応答完了でも、復帰まで follow-up を開始しない', async () => {
    vi.useFakeTimers()
    hoisted.gate.open = false
    const { result } = renderHook(() => useCmux())
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const before = hoisted.sent.length

    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    expect(hoisted.sent).toHaveLength(before)

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hoisted.sent.length).toBeGreaterThan(before)
    await act(async () => {
      hoisted.gate.release()
      await Promise.resolve()
    })
    vi.useRealTimers()
  })

  it('失敗しても既存の一覧を捨てない', async () => {
    hoisted.status.value = 'disconnected'
    hoisted.responses['surface.list'] = { surfaces: [topologySurface('surface:1')] }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    expect(result.current.surfaces).toHaveLength(1)
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }

    await act(async () => {
      await result.current.requestTopologyRefresh().catch(() => undefined)
    })

    expect(result.current.surfaces).toHaveLength(1)
  })

  it('成功した空 snapshot でも topologyReady が true になる', async () => {
    hoisted.status.value = 'disconnected'
    const { result } = renderHook(() => useCmux())
    expect(result.current.topologyReady).toBe(false)

    await act(async () => {
      await result.current.requestTopologyRefresh()
    })

    expect(result.current.topologyReady).toBe(true)
    expect(result.current.surfaces).toEqual([])
  })

  it('bootstrap 前の初回 snapshot は reconcile せず、initializeFrom が preferred surface を最初に前面化する', async () => {
    hoisted.status.value = 'disconnected'
    const first = topologySurface('surface:1')
    const preferred = topologySurface('surface:2', 'workspace:2', 1)
    hoisted.responses['surface.list'] = { surfaces: [first, preferred] }
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    expect(result.current.view.foreground).toBeNull()

    act(() => {
      result.current.initializeFrom(result.current.surfaces, 'surface:2')
    })
    expect(result.current.view.foreground).toBe('surface:2')
  })
})
