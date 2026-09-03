// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import type { RenderGrid } from '../../lib/render-grid'
import type { SurfaceLike, TerminalFeed, ViewState } from '../../lib/view-state'
import { BACKGROUND_POLL_INTERVAL, BACKGROUND_STAGGER, FOREGROUND_POLL_INTERVAL } from '../../lib/view-state'
import { useTerminalFeeds } from '../useTerminalFeeds'

type ReadGridMock = Mock<(ref: string) => Promise<RenderGrid | null>>

const mockReadGrid = (implementation: (ref: string) => Promise<RenderGrid | null>): ReadGridMock =>
  vi.fn(implementation)

const gridOf = (text: string): RenderGrid => ({
  columns: 80,
  rows: 1,
  styles: [],
  row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: text.length, text }],
})

const feedOf = (over: Partial<TerminalFeed> = {}): TerminalFeed => ({
  grid: null,
  history: '',
  updatedAt: null,
  activity: false,
  contentHash: '',
  status: 'loading',
  source: 'none',
  epoch: 1,
  promotedAt: 0,
  ...over,
})

const surfaceOf = (ref: string, type = 'terminal', index = 0): SurfaceLike => ({
  ref,
  type,
  workspace_ref: 'workspace:1',
  index,
})

interface Harness {
  props: Parameters<typeof useTerminalFeeds>[0]
  readGrid: ReadGridMock
  readText: ReturnType<typeof vi.fn>
  applyFeedResult: ReturnType<typeof vi.fn>
  applyFeedHistory: ReturnType<typeof vi.fn>
  applyFeedError: ReturnType<typeof vi.fn>
  requestTopologyRefresh: ReturnType<typeof vi.fn>
  markDisconnected: ReturnType<typeof vi.fn>
  repromote: ReturnType<typeof vi.fn>
}

// 購読集合・feeds・visibleRefs を指定して props を組む。
function harness(opts: {
  subscribed: string[]
  visible: string[]
  feeds?: Record<string, TerminalFeed>
  surfaces?: SurfaceLike[]
  pinned?: boolean
  readGrid?: ReadGridMock
}): Harness {
  const view: ViewState = {
    subscriptions: opts.subscribed.map((ref, i) => ({ ref, lastForegroundAt: 1000 + i, treeIndex: i })),
    foreground: opts.visible[0] ?? null,
    foregroundWorkspaceRef: 'workspace:1',
  }
  const readGrid = opts.readGrid ?? mockReadGrid(() => Promise.resolve(gridOf('hello')))
  const readText = vi.fn().mockResolvedValue('history text')
  const applyFeedResult = vi.fn()
  const applyFeedHistory = vi.fn()
  const applyFeedError = vi.fn()
  const requestTopologyRefresh = vi.fn().mockResolvedValue({ generation: 1, surfaces: [], workspaces: [] })
  const markDisconnected = vi.fn()
  const repromote = vi.fn()
  const feeds = new Map<string, TerminalFeed>(
    Object.entries(opts.feeds ?? Object.fromEntries(opts.subscribed.map((r) => [r, feedOf()]))),
  )
  return {
    readGrid,
    readText,
    applyFeedResult,
    applyFeedHistory,
    applyFeedError,
    requestTopologyRefresh,
    markDisconnected,
    repromote,
    props: {
      status: 'connected',
      view,
      surfaces: opts.surfaces ?? opts.subscribed.map((r, i) => surfaceOf(r, 'terminal', i)),
      feeds,
      visibleRefs: opts.visible,
      pinned: opts.pinned ?? true,
      historyLines: 2000,
      readGrid,
      readText,
      applyFeedResult,
      applyFeedHistory,
      applyFeedError,
      requestTopologyRefresh,
      markDisconnected,
      repromote,
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTerminalFeeds — 実行規律', () => {
  it('サーフェスごとに正しい ref で readGrid が飛ぶ', async () => {
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_STAGGER * 2)
    })
    expect(h.readGrid.mock.calls.map((c) => c[0]).sort()).toEqual(['surface:1', 'surface:2'])
  })

  it('背面では scrollback を取らない（前面かつピン留め中のみ）', async () => {
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_STAGGER * 2)
    })
    expect(h.readText.mock.calls.map((c) => c[0])).toEqual(['surface:1'])
  })

  it('ピン留めを外している間は scrollback を取らない', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL)
    })
    expect(h.readText).not.toHaveBeenCalled()
  })

  it('非購読と browser には一度も投げない', async () => {
    const h = harness({
      subscribed: ['surface:1'],
      visible: ['surface:1'],
      surfaces: [surfaceOf('surface:1'), surfaceOf('surface:3'), surfaceOf('surface:9', 'browser')],
    })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 3)
    })
    const refs = h.readGrid.mock.calls.map((c) => c[0])
    expect(refs).not.toContain('surface:3')
    expect(refs).not.toContain('surface:9')
  })

  it('E4: hidden のまま mount してもタイマーを 1 本も張らない', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    expect(vi.getTimerCount()).toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('E4: hidden 中に planKey が変わって effect が作り直されてもタイマーを張らない', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // 購読集合を変えて effect を作り直す
    const view2 = { ...h.props.view, subscriptions: [{ ref: 'surface:2', lastForegroundAt: 1, treeIndex: 1 }] }
    rerender({ ...h.props, view: view2, visibleRefs: ['surface:2'] })
    expect(vi.getTimerCount()).toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('E4: plan 変更の handoff を待つ間に hidden になってもタイマーを張らず、復帰後に再開する', async () => {
    let resolveGrid: ((grid: RenderGrid | null) => void) | undefined
    const readGrid = mockReadGrid(() => Promise.resolve(gridOf('next'))).mockImplementationOnce(
      () =>
        new Promise<RenderGrid | null>((resolve) => {
          resolveGrid = resolve
        }),
    )
    const h = harness({
      subscribed: ['surface:1'],
      visible: ['surface:1'],
      surfaces: [surfaceOf('surface:1'), surfaceOf('surface:2', 'browser', 1)],
      pinned: false,
      readGrid,
    })
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    rerender({
      ...h.props,
      view: { ...h.props.view, foreground: 'surface:2' },
      visibleRefs: ['surface:2'],
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      resolveGrid?.(gridOf('discarded'))
      await vi.advanceTimersByTimeAsync(0)
    })
    const timersWhileHidden = vi.getTimerCount()
    h.readGrid.mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL * 2)
    })
    const requestsWhileHidden = h.readGrid.mock.calls.map((call) => call[0])

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL)
    })

    expect(timersWhileHidden).toBe(0)
    expect(requestsWhileHidden).toEqual([])
    expect(h.readGrid.mock.calls.map((call) => call[0])).toEqual(['surface:1'])
  })

  it('E4: hidden になったら全タイマーを clear し、復帰で前面即時・背面 interval+stagger で再開する', async () => {
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'], pinned: false })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_STAGGER * 2)
    })
    h.readGrid.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // タイマーが「張られていない」ことを本数で確認する（RPC が 0 件なだけでは足りない）
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL * 4)
    })
    expect(h.readGrid).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.readGrid.mock.calls.map((c) => c[0])).toEqual(['surface:1']) // 前面は即時
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL + BACKGROUND_STAGGER * 2)
    })
    expect(h.readGrid.mock.calls.map((c) => c[0])).toContain('surface:2') // 背面も再開する
  })

  it('E4: readGrid の待機中に hidden になった応答は反映しない', async () => {
    let resolveGrid: ((g: RenderGrid | null) => void) | undefined
    const readGrid = mockReadGrid(() => Promise.resolve(gridOf('x'))).mockImplementationOnce(
      () =>
        new Promise<RenderGrid | null>((r) => {
          resolveGrid = r
        }),
    )
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false, readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      resolveGrid?.(gridOf('discarded'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.applyFeedResult).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.applyFeedResult).toHaveBeenCalled() // 復帰で再開する
  })

  it('readGrid の待機中に前面が切り替わったら、旧 ref の read_text と localStorage 保存を行わない', async () => {
    let resolveGrid: ((g: RenderGrid | null) => void) | undefined
    const readGrid = mockReadGrid(() => Promise.resolve(gridOf('x'))).mockImplementationOnce(
      () =>
        new Promise<RenderGrid | null>((r) => {
          resolveGrid = r
        }),
    )
    const setItem = vi.spyOn(localStorage, 'setItem')
    const h = harness({
      subscribed: ['surface:1'],
      visible: ['surface:1'],
      surfaces: [surfaceOf('surface:1'), surfaceOf('surface:2', 'browser', 1)],
      pinned: true,
      readGrid,
    })
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    setItem.mockClear()
    h.readText.mockClear()
    // surface:1 の replay 待機中に surface:2 へ切り替える
    rerender({
      ...h.props,
      view: { ...h.props.view, foreground: 'surface:2' },
      visibleRefs: ['surface:2'],
    })
    await act(async () => {
      resolveGrid?.(gridOf('a'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // surface:1 はもう背面。scrollback も localStorage 保存もしない。
    expect(h.readText.mock.calls.filter((c) => c[0] === 'surface:1')).toHaveLength(0)
    expect(setItem.mock.calls.filter((c) => (c[0] as string).includes('surface:1'))).toHaveLength(0)
    // grid 自体は epoch が一致するので適用してよい
    expect(h.applyFeedResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'surface:1',
        grid: expect.objectContaining({ row_spans: [expect.objectContaining({ text: 'a' })] }),
      }),
    )
  })

  it('readGrid の待機中に ref が poll plan から消えたら遅延応答を反映しない', async () => {
    let resolveGrid: ((grid: RenderGrid | null) => void) | undefined
    const readGrid = mockReadGrid(
      () =>
        new Promise<RenderGrid | null>((resolve) => {
          resolveGrid = resolve
        }),
    )
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false, readGrid })
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(readGrid).toHaveBeenCalledTimes(1)

    rerender({
      ...h.props,
      view: { subscriptions: [], foreground: null, foregroundWorkspaceRef: null },
      visibleRefs: [],
    })
    await act(async () => {
      resolveGrid?.(gridOf('removed'))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(h.applyFeedResult).not.toHaveBeenCalled()
    expect(h.applyFeedError).not.toHaveBeenCalled()
  })

  it('取得待機中に hidden になってから返った rejection は feed も T4 も更新しない', async () => {
    let rejectGrid: ((e: Error) => void) | undefined
    const readGrid = mockReadGrid(() => Promise.resolve(gridOf('x'))).mockImplementationOnce(
      () =>
        new Promise<RenderGrid | null>((_, rej) => {
          rejectGrid = rej
        }),
    )
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false, readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      rejectGrid?.(Object.assign(new Error('Missing or invalid terminal_id'), { code: 'invalid_params' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.applyFeedError).not.toHaveBeenCalled()
    expect(h.requestTopologyRefresh).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('E4: read_text の待機中に hidden になったら history も localStorage も更新しない', async () => {
    let resolveText: ((t: string) => void) | undefined
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: true })
    h.readText.mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          resolveText = r
        }),
    )
    const setItem = vi.spyOn(localStorage, 'setItem')
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    setItem.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      resolveText?.('late history')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.applyFeedHistory).not.toHaveBeenCalled()
    expect(setItem.mock.calls.filter((c) => (c[0] as string).startsWith('cmux-surface-cache:'))).toHaveLength(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('ref ごとのタイマーは常に 1 本（復帰イベントが重なっても増殖しない）', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    h.readGrid.mockClear()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pageshow'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // 3 イベントが重なっても、即時再取得は 1 回だけ
    expect(h.readGrid).toHaveBeenCalledTimes(1)
  })

  it('hidden 中は RPC が 0 件（E4）', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 5)
    })
    expect(h.readGrid).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('同一サーフェスの in-flight が 1 件を超えない（E2）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const readGrid = mockReadGrid(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, FOREGROUND_POLL_INTERVAL * 3)) // interval より長い
      inFlight--
      return gridOf('x')
    })
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 10)
    })
    expect(maxInFlight).toBe(1)
  })

  it('E1: 次回は「完了時刻」から interval だけ待つ（開始時刻起点で取り戻さない）', async () => {
    const at: number[] = []
    const readGrid = mockReadGrid(async () => {
      at.push(Date.now())
      await new Promise((r) => setTimeout(r, 500)) // 取得に 500ms かかる
      return gridOf('x')
    })
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false, readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 3 + 2000)
    })
    // 開始間隔は 500(取得) + 1000(interval) = 1500ms になる（1000ms ではない）
    expect((at[1] as number) - (at[0] as number)).toBe(1500)
  })

  it('E1: plan 変更中の旧 in-flight 完了から新 interval を待って次を開始する', async () => {
    const at: number[] = []
    const readGrid = mockReadGrid(async () => {
      at.push(Date.now())
      return gridOf('next')
    }).mockImplementationOnce(async () => {
      at.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, 500))
      return gridOf('first')
    })
    const h = harness({
      subscribed: ['surface:1'],
      visible: ['surface:1'],
      surfaces: [surfaceOf('surface:1'), surfaceOf('surface:2', 'browser', 1)],
      pinned: false,
      readGrid,
    })
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    rerender({
      ...h.props,
      view: { ...h.props.view, foreground: 'surface:2' },
      visibleRefs: ['surface:2'],
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3499)
    })
    expect(at).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(at).toHaveLength(2)
    expect((at[1] as number) - (at[0] as number)).toBe(3500)
  })

  it('E3: 背面の初回発火が index * BACKGROUND_STAGGER ずれる', async () => {
    const at = new Map<string, number>()
    const readGrid = mockReadGrid(async (ref: string) => {
      if (!at.has(ref)) at.set(ref, Date.now())
      return gridOf('x')
    })
    const h = harness({
      subscribed: ['surface:0', 'surface:1', 'surface:2'],
      visible: ['surface:0'],
      pinned: false,
      readGrid,
    })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_STAGGER * 4)
    })
    const base = at.get('surface:1') as number
    expect((at.get('surface:2') as number) - base).toBe(BACKGROUND_STAGGER)
  })

  it('前面は 1Hz、背面は 3s の間隔で回る', async () => {
    const counts = new Map<string, number>()
    const readGrid = mockReadGrid(async (ref: string) => {
      counts.set(ref, (counts.get(ref) ?? 0) + 1)
      return gridOf('x')
    })
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'], pinned: false, readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL * 2)
    })
    // 6 秒で前面は約 6 回、背面は約 2 回
    expect(counts.get('surface:1') as number).toBeGreaterThan(counts.get('surface:2') as number)
    expect(counts.get('surface:2') as number).toBeLessThanOrEqual(3)
  })
})

describe('useTerminalFeeds — 状態遷移', () => {
  it('F5: 成功で live/memory になり updatedAt が入る', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.applyFeedResult).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'surface:1', epoch: 1, grid: expect.objectContaining({ rows: 1 }) }),
    )
  })

  it('F5n: render_grid が null なら grid: null を渡す（呼び出し側が live/none にする）', async () => {
    const readGrid = mockReadGrid(() => Promise.resolve(null))
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.applyFeedResult).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:1', grid: null }))
    // 停止端末では read_text 自体が失敗するので scrollback は取りに行かない
    expect(h.readText).not.toHaveBeenCalled()
  })

  it('F6: 失敗で applyFeedError が呼ばれる', async () => {
    const readGrid = mockReadGrid(() => Promise.reject(new Error('timeout')))
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.applyFeedError).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:1', epoch: 1 }))
  })

  it('replay 成功後に read_text だけ失敗しても live grid を error にしない', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    h.readText.mockRejectedValueOnce(new Error('read_text timeout'))
    renderHook(() => useTerminalFeeds(h.props))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(h.applyFeedResult).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'surface:1', epoch: 1, grid: expect.objectContaining({ rows: 1 }) }),
    )
    expect(h.applyFeedHistory).not.toHaveBeenCalled()
    expect(h.applyFeedError).not.toHaveBeenCalled()
  })

  it('F7: replay 待機中に epoch が進んだ成功応答は cache と read_text を更新しない', async () => {
    let resolveGrid: ((grid: RenderGrid | null) => void) | undefined
    const readGrid = mockReadGrid(() => Promise.resolve(gridOf('next'))).mockImplementationOnce(
      () =>
        new Promise<RenderGrid | null>((resolve) => {
          resolveGrid = resolve
        }),
    )
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: true, readGrid })
    const setItem = vi.spyOn(localStorage, 'setItem')
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    rerender({
      ...h.props,
      feeds: new Map(h.props.feeds).set('surface:1', feedOf({ epoch: 2, promotedAt: 2000 })),
    })

    await act(async () => {
      resolveGrid?.(gridOf('stale'))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(h.applyFeedResult).not.toHaveBeenCalled()
    expect(h.readText).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(h.requestTopologyRefresh).not.toHaveBeenCalled()
  })

  it('F7: replay 待機中に epoch が進んだ stale error は feed と topology を更新しない', async () => {
    let rejectGrid: ((error: Error) => void) | undefined
    const readGrid = mockReadGrid(() => Promise.resolve(gridOf('next'))).mockImplementationOnce(
      () =>
        new Promise<RenderGrid | null>((_, reject) => {
          rejectGrid = reject
        }),
    )
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: true, readGrid })
    const setItem = vi.spyOn(localStorage, 'setItem')
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    rerender({
      ...h.props,
      feeds: new Map(h.props.feeds).set('surface:1', feedOf({ epoch: 2, promotedAt: 2000 })),
    })

    await act(async () => {
      rejectGrid?.(Object.assign(new Error('Missing or invalid terminal_id'), { code: 'invalid_params' }))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(h.applyFeedError).not.toHaveBeenCalled()
    expect(h.readText).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(h.requestTopologyRefresh).not.toHaveBeenCalled()
  })
})

describe('useTerminalFeeds — 接続状態 (F8/F9)', () => {
  it('F8: 切断で markDisconnected が 1 回だけ呼ばれる', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    const { rerender } = renderHook((p: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(p), {
      initialProps: h.props,
    })
    rerender({ ...h.props, status: 'disconnected' })
    rerender({ ...h.props, status: 'disconnected' }) // 同じ status での再 render では呼ばない
    expect(h.markDisconnected).toHaveBeenCalledTimes(1)
    expect(h.repromote).not.toHaveBeenCalled()
  })

  it('F9: 切断 → 再接続で repromote が 1 回だけ呼ばれる', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    const { rerender } = renderHook((p: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(p), {
      initialProps: { ...h.props, status: 'disconnected' },
    })
    rerender({ ...h.props, status: 'connected' })
    expect(h.repromote).toHaveBeenCalledTimes(1)
  })

  it('切断中はポーリングを止める', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds({ ...h.props, status: 'disconnected' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 5)
    })
    expect(h.readGrid).not.toHaveBeenCalled()
  })
})

describe('useTerminalFeeds — stale 検出と永続化', () => {
  it('T4: stale surface エラーはサーフェスごとに 1 回だけ requestTopologyRefresh する', async () => {
    const staleErr = Object.assign(new Error('Missing or invalid terminal_id'), { code: 'invalid_params' })
    const readGrid = mockReadGrid(() => Promise.reject(staleErr))
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 5)
    })
    expect(h.requestTopologyRefresh).toHaveBeenCalledTimes(1)
  })

  it('C1/C6: localStorage への保存は前面かつ内容変化時のみ。背面は書かない', async () => {
    const spy = vi.spyOn(localStorage, 'setItem')
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'], pinned: false })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL * 2)
    })
    const written = spy.mock.calls.map((c) => c[0] as string).filter((k) => k.startsWith('cmux-surface-cache:'))
    expect(written.every((k) => k === 'cmux-surface-cache:surface:1')).toBe(true)
    // 内容が変化していないので、6 秒間で書き込みは 1 回だけ
    expect(written).toHaveLength(1)
  })

  it('poll plan から外れた ref の重複排除値を破棄する', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem')
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: true })
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.readText).toHaveBeenCalledTimes(1)
    setItem.mockClear()

    rerender({
      ...h.props,
      view: { subscriptions: [], foreground: null, foregroundWorkspaceRef: null },
      visibleRefs: [],
    })
    rerender(h.props)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    const writes = setItem.mock.calls.filter((call) => call[0] === 'cmux-surface-cache:surface:1')
    expect(writes).toHaveLength(2)
    expect(writes[1]?.[1]).toContain('"scrollback":"history text"')
  })
})
