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
  responses: {} as Record<string, unknown>,
}))

vi.mock('../useWebSocket', () => ({
  useWebSocket: ({ onMessage }: { onMessage: (data: string) => void }) => {
    hoisted.onMessage.fn = onMessage
    return {
      status: 'connected' as const,
      send: (data: string) => {
        hoisted.sent.push(data)
        const req = JSON.parse(data) as { id: string; method: string }
        const result = hoisted.responses[req.method] ?? {}
        hoisted.onMessage.fn(JSON.stringify({ id: req.id, ok: true, result }))
      },
    }
  },
}))

beforeEach(() => {
  hoisted.sent.length = 0
  hoisted.responses = {}
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
})

describe('useCmux createSurface', () => {
  it('新規サーフェス作成時に、作成したサーフェスのタブへ切り替える', async () => {
    hoisted.responses['surface.list'] = {
      surfaces: [{ index: 0, ref: 'surface:a1', selected: true, title: 'a1', type: 'terminal' }],
    }

    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.listSurfaces()
    })
    expect(result.current.currentSurface).toBe('surface:a1')

    // 作成後の surface.list は新サーフェス a2 を含む（cmux 側は focus:true で a2 を選択）。
    hoisted.responses['surface.list'] = {
      surfaces: [
        { index: 0, ref: 'surface:a1', selected: false, title: 'a1', type: 'terminal' },
        { index: 1, ref: 'surface:a2', selected: true, title: 'a2', type: 'terminal' },
      ],
    }
    await act(async () => {
      await result.current.createSurface()
    })

    // 旧タブの維持ではなく、新規作成したサーフェスへ切り替わっていること
    expect(result.current.surfaces).toHaveLength(2)
    expect(result.current.currentSurface).toBe('surface:a2')
  })
})

describe('useCmux selectWorkspace', () => {
  it('ワークスペース切替時に前ワークスペースの surfaces/currentSurface を残さない', async () => {
    hoisted.responses['workspace.list'] = {
      workspaces: [
        { id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true },
        { id: 'w2', ref: 'workspace:B', title: 'B', index: 1 },
      ],
    }
    hoisted.responses['surface.list'] = {
      surfaces: [{ index: 0, ref: 'surface:a1', selected: true, title: 'a1', type: 'terminal' }],
    }

    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.listWorkspaces()
      await result.current.listSurfaces('workspace:A')
    })

    // 前提: ワークスペース A の surface が選択された状態
    expect(result.current.currentWorkspace).toBe('workspace:A')
    expect(result.current.currentSurface).toBe('surface:a1')
    expect(result.current.surfaces).toHaveLength(1)

    // ワークスペース B へ切替（B の surface.list はまだ反映していない状態を模す）
    act(() => {
      result.current.selectWorkspace('workspace:B')
    })

    // 切替直後、古い A の view を残さず即座にクリアされていること
    expect(result.current.currentWorkspace).toBe('workspace:B')
    expect(result.current.surfaces).toEqual([])
    expect(result.current.currentSurface).toBeNull()
  })

  it('cmux 側のワークスペースも workspace.select で追従させる（非選択ワークスペースのターミナルは読めないため）', async () => {
    const { result } = renderHook(() => useCmux())

    act(() => {
      result.current.selectWorkspace('workspace:B')
    })

    const selectReq = hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, unknown> })
      .find((req) => req.method === 'workspace.select')

    expect(selectReq).toBeDefined()
    expect(selectReq?.params).toEqual({ workspace_id: 'workspace:B' })
  })
})

describe('useCmux closeWorkspace', () => {
  const findReq = (method: string) =>
    hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, unknown> })
      .find((req) => req.method === method)

  it('workspace.close を workspace_id パラメータで送る（ref ではなく id キー）', async () => {
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.closeWorkspace('workspace:B')
    })
    const req = findReq('workspace.close')
    expect(req).toBeDefined()
    expect(req?.params).toEqual({ workspace_id: 'workspace:B' })
    expect(req?.params).not.toHaveProperty('workspace_ref')
  })

  it('現在のワークスペースを閉じると、残りの selected ワークスペースへフォールバックする', async () => {
    hoisted.responses['workspace.list'] = {
      workspaces: [
        { id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true },
        { id: 'w2', ref: 'workspace:B', title: 'B', index: 1 },
      ],
    }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.listWorkspaces()
    })
    expect(result.current.currentWorkspace).toBe('workspace:A')

    // A を閉じた後の workspace.list は B のみ（cmux が B を selected にする）。
    hoisted.responses['workspace.list'] = {
      workspaces: [{ id: 'w2', ref: 'workspace:B', title: 'B', index: 1, selected: true }],
    }
    await act(async () => {
      await result.current.closeWorkspace('workspace:A')
    })
    expect(result.current.currentWorkspace).toBe('workspace:B')
  })

  it('非現在のワークスペースを閉じても currentWorkspace は維持される', async () => {
    hoisted.responses['workspace.list'] = {
      workspaces: [
        { id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true },
        { id: 'w2', ref: 'workspace:B', title: 'B', index: 1 },
      ],
    }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.listWorkspaces()
    })
    expect(result.current.currentWorkspace).toBe('workspace:A')

    // B を閉じた後の list は A のみ（A は selected 維持）。
    hoisted.responses['workspace.list'] = {
      workspaces: [{ id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true }],
    }
    await act(async () => {
      await result.current.closeWorkspace('workspace:B')
    })
    expect(result.current.currentWorkspace).toBe('workspace:A')
  })

  it('現在のワークスペースを閉じると surfaces/currentSurface をクリアする', async () => {
    hoisted.responses['workspace.list'] = {
      workspaces: [{ id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true }],
    }
    hoisted.responses['surface.list'] = {
      surfaces: [{ index: 0, ref: 'surface:a1', selected: true, title: 'a1', type: 'terminal' }],
    }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.listWorkspaces()
      await result.current.listSurfaces('workspace:A')
    })
    expect(result.current.surfaces).toHaveLength(1)
    expect(result.current.currentSurface).toBe('surface:a1')

    // A を閉じた後の list は空（最後の WS）。
    hoisted.responses['workspace.list'] = { workspaces: [] }
    await act(async () => {
      await result.current.closeWorkspace('workspace:A')
    })
    expect(result.current.surfaces).toEqual([])
    expect(result.current.currentSurface).toBeNull()
  })
})
