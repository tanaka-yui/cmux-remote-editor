// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'
import type { RenderGrid } from '../lib/render-grid'
import type { TerminalFeed, ViewState } from '../lib/view-state'

interface WorkspaceStub {
  id: string
  ref: string
  title: string
  index: number
  selected: boolean
  custom_color?: string | null
}

interface SurfaceStub {
  index: number
  ref: string
  selected: boolean
  title: string
  type: string
  workspace_ref: string
  workspace_title: string
  workspace_id: string
  url?: string
}

interface CmuxStateStub {
  status: 'connected'
  topologyReady: boolean
  workspaces: WorkspaceStub[]
  currentWorkspace: string | null
  surfaces: SurfaceStub[]
  notifications: never[]
  view: ViewState
  feeds: ReadonlyMap<string, TerminalFeed>
  createSurface: (workspaceId: string) => Promise<{ list: SurfaceStub[]; misplaced: boolean }>
  createWorkspace: () => Promise<SurfaceStub[]>
  closeSurface: (ref: string) => Promise<SurfaceStub[]>
  closeWorkspace: (ref: string) => Promise<WorkspaceStub[]>
  selectSurface: (surface: SurfaceStub) => void
  initializeFrom: (surfaces: SurfaceStub[], preferredRef: string | null) => void
  requestTopologyRefresh: () => Promise<{
    generation: number
    surfaces: SurfaceStub[]
    workspaces: WorkspaceStub[]
  }>
  readText: (ref: string, opts: { scrollback: boolean; lines: number }) => Promise<string>
  readGrid: (ref: string) => Promise<RenderGrid | null>
  sendText: (ref: string, text: string) => Promise<void>
  listNotifications: () => Promise<never[]>
  applyFeedResult: (action: { ref: string; epoch: number; grid: RenderGrid | null; now: number }) => void
  applyFeedHistory: (action: { ref: string; epoch: number; history: string }) => void
  applyFeedError: (action: { ref: string; epoch: number }) => void
  markDisconnected: () => void
  repromote: () => void
}

interface TerminalMockProps {
  grid: RenderGrid | null
  scrollback: string
  onPinnedChange: (pinned: boolean) => void
  resetKey: string | null
}

const cmux = vi.hoisted(() => ({
  state: {} as CmuxStateStub,
  terminalThrows: false,
  messageListener: { fn: (_event: MessageEvent) => {} },
}))

vi.mock('../hooks/useCmux', () => ({ useCmux: () => cmux.state }))
vi.mock('../components/Terminal', () => ({
  Terminal: ({ grid, scrollback, onPinnedChange, resetKey }: TerminalMockProps) => {
    if (cmux.terminalThrows) throw new Error("undefined is not an object (evaluating 'e.columns')")
    return (
      <div data-testid="wterm-root" data-reset-key={resetKey ?? ''}>
        {scrollback}
        {grid?.row_spans.map((span) => span.text).join('')}
        <button type="button" onClick={() => onPinnedChange(false)}>
          Unpin terminal
        </button>
      </div>
    )
  },
}))
vi.mock('../lib/token', () => ({ getAuthToken: () => 'tok', saveAuthToken: () => {} }))

const gridOf = (text: string): RenderGrid => ({
  columns: 80,
  rows: 24,
  styles: [],
  row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: text.length, text }],
})

const terminal = (ref: string, workspace = 'workspace:A', workspaceId = 'w1'): SurfaceStub => ({
  index: Number(ref.split(':')[1] ?? 0),
  ref,
  selected: ref === 'surface:1',
  title: `zsh-${ref}`,
  type: 'terminal',
  workspace_ref: workspace,
  workspace_title: workspace === 'workspace:A' ? 'A' : 'B',
  workspace_id: workspaceId,
})

const browser = (ref: string): SurfaceStub => ({
  ...terminal(ref),
  title: 'docs',
  type: 'browser',
  url: 'https://example.com/docs',
})

const feedOf = (overrides: Partial<TerminalFeed>): TerminalFeed => ({
  grid: null,
  history: '',
  updatedAt: null,
  activity: false,
  contentHash: '',
  status: 'loading',
  source: 'none',
  epoch: 1,
  promotedAt: 1,
  ...overrides,
})

function setForeground(surface: SurfaceStub, feed?: TerminalFeed): void {
  cmux.state.surfaces = cmux.state.surfaces.some((candidate) => candidate.ref === surface.ref)
    ? cmux.state.surfaces
    : [...cmux.state.surfaces, surface]
  cmux.state.view = {
    subscriptions:
      surface.type === 'browser'
        ? cmux.state.view.subscriptions
        : [{ ref: surface.ref, lastForegroundAt: 1, treeIndex: surface.index }],
    foreground: surface.ref,
    foregroundWorkspaceRef: surface.workspace_ref,
  }
  cmux.state.currentWorkspace = surface.workspace_ref
  if (feed) cmux.state.feeds = new Map([[surface.ref, feed]])
}

function renderAppWithFeed(feed: TerminalFeed) {
  const surface = terminal('surface:1')
  setForeground(surface, feed)
  return render(<App />)
}

beforeEach(() => {
  cmux.terminalThrows = false
  cmux.messageListener.fn = () => {}
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        cmux.messageListener.fn = listener
      },
      removeEventListener: vi.fn(),
    },
  })
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } satisfies MediaQueryList)
  cmux.state = {
    status: 'connected',
    topologyReady: true,
    workspaces: [{ id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true }],
    currentWorkspace: 'workspace:A',
    surfaces: [],
    notifications: [],
    view: { subscriptions: [], foreground: null, foregroundWorkspaceRef: null },
    feeds: new Map(),
    createSurface: vi.fn(() => Promise.resolve({ list: [], misplaced: false })),
    createWorkspace: vi.fn(() => Promise.resolve([])),
    closeSurface: vi.fn(() => Promise.resolve([])),
    closeWorkspace: vi.fn(() => Promise.resolve([])),
    selectSurface: vi.fn(),
    initializeFrom: vi.fn(),
    requestTopologyRefresh: vi.fn(() => Promise.resolve({ generation: 1, surfaces: [], workspaces: [] })),
    readText: vi.fn(() => Promise.resolve('history')),
    readGrid: vi.fn(() => Promise.resolve(gridOf('polled'))),
    sendText: vi.fn(() => Promise.resolve()),
    listNotifications: vi.fn(() => Promise.resolve([])),
    applyFeedResult: vi.fn(),
    applyFeedHistory: vi.fn(),
    applyFeedError: vi.fn(),
    markDisconnected: vi.fn(),
    repromote: vi.fn(),
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('App topology bootstrap', () => {
  it('topologyReady の一覧だけで initialize し、surface/workspace を直接取得しない', async () => {
    render(<App />)

    await waitFor(() => expect(cmux.state.initializeFrom).toHaveBeenCalledWith([], null))
    expect(cmux.state.listNotifications).toHaveBeenCalledOnce()
  })

  it('?workspace=<UUID> を Workspace.id で解決し、購読中 surface を優先する', async () => {
    const first = terminal('surface:1')
    const subscribed = terminal('surface:2')
    cmux.state.surfaces = [first, subscribed]
    cmux.state.view = {
      subscriptions: [{ ref: subscribed.ref, lastForegroundAt: 1, treeIndex: subscribed.index }],
      foreground: null,
      foregroundWorkspaceRef: null,
    }
    window.history.replaceState({}, '', '/?workspace=w1')

    render(<App />)

    await waitFor(() => expect(cmux.state.initializeFrom).toHaveBeenCalledWith(cmux.state.surfaces, subscribed.ref))
  })

  it('?workspace=<ref> は UUID として解決せず sessionStorage の生存 ref に fallback する', async () => {
    const first = terminal('surface:1')
    const stored = terminal('surface:2')
    cmux.state.surfaces = [first, stored]
    sessionStorage.setItem('cmux:foreground', stored.ref)
    window.history.replaceState({}, '', '/?workspace=workspace:A')

    render(<App />)

    await waitFor(() => expect(cmux.state.initializeFrom).toHaveBeenCalledWith(cmux.state.surfaces, stored.ref))
  })

  it('SW の workspace UUID を購読中 surface に解決して selectSurface する', () => {
    const first = terminal('surface:1')
    const subscribed = terminal('surface:2')
    cmux.state.surfaces = [first, subscribed]
    cmux.state.view = {
      subscriptions: [{ ref: subscribed.ref, lastForegroundAt: 1, treeIndex: subscribed.index }],
      foreground: first.ref,
      foregroundWorkspaceRef: first.workspace_ref,
    }

    render(<App />)
    act(() => {
      cmux.messageListener.fn(new MessageEvent('message', { data: { type: 'navigate', workspaceId: 'w1' } }))
    })

    expect(cmux.state.selectSurface).toHaveBeenCalledWith(subscribed)
    expect(cmux.state.initializeFrom).toHaveBeenCalledOnce()
  })

  it('SW の通知先に購読中 surface が無ければ workspace の先頭を選ぶ', () => {
    const first = terminal('surface:1')
    const second = terminal('surface:2')
    cmux.state.surfaces = [first, second]

    render(<App />)
    act(() => {
      cmux.messageListener.fn(new MessageEvent('message', { data: { type: 'navigate', workspaceId: 'w1' } }))
    })

    expect(cmux.state.selectSurface).toHaveBeenCalledWith(first)
  })
})

describe('App — 5 表示ケースの描画 (D3.1)', () => {
  it('1. live/memory: グリッドを描き、鮮度ラベルを出さない', () => {
    renderAppWithFeed(feedOf({ status: 'live', source: 'memory', grid: gridOf('live-content'), updatedAt: Date.now() }))

    expect(screen.getByText(/live-content/)).toBeTruthy()
    expect(screen.queryByText(/更新:/)).toBeNull()
    expect(screen.queryByText(/オフライン時点/)).toBeNull()
    expect(screen.queryByText(/接続なし/)).toBeNull()
  })

  it('2. warming/memory: 前回フレームを描き「更新: HH:MM:SS」を出す', () => {
    renderAppWithFeed(
      feedOf({ status: 'warming', source: 'memory', grid: gridOf('prev-frame'), updatedAt: Date.now() }),
    )

    expect(screen.getByText(/prev-frame/)).toBeTruthy()
    expect(screen.getByText(/^更新: \d{2}:\d{2}:\d{2}$/)).toBeTruthy()
  })

  it('3. warming/cache: キャッシュを描き「オフライン時点の内容」を出す', () => {
    renderAppWithFeed(
      feedOf({ status: 'warming', source: 'cache', grid: gridOf('cached-frame'), updatedAt: Date.now() }),
    )

    expect(screen.getByText(/cached-frame/)).toBeTruthy()
    expect(screen.getByText(/オフライン時点の内容 · 最終 \d{2}:\d{2}/)).toBeTruthy()
  })

  it('4. loading/none: 「読み込み中」を出し、Terminal を描かない', () => {
    renderAppWithFeed(feedOf({ status: 'loading', source: 'none' }))

    expect(screen.getByText('読み込み中')).toBeTruthy()
    expect(screen.queryByTestId('wterm-root')).toBeNull()
  })

  it('4. live/none: 「端末が停止しています」を出す（F5n）', () => {
    renderAppWithFeed(feedOf({ status: 'live', source: 'none', updatedAt: Date.now() }))

    expect(screen.getByText(/端末が停止しています/)).toBeTruthy()
    expect(screen.queryByTestId('wterm-root')).toBeNull()
  })

  it('5. error（描けるフレームあり）: フレームを残して「接続なし · 最終 HH:MM」', () => {
    renderAppWithFeed(feedOf({ status: 'error', source: 'memory', grid: gridOf('last-frame'), updatedAt: Date.now() }))

    expect(screen.getByText(/last-frame/)).toBeTruthy()
    expect(screen.getByText(/接続なし · 最終 \d{2}:\d{2}/)).toBeTruthy()
  })

  it('5. error（フレームなし・updatedAt なし）: 「接続なし」だけを出す', () => {
    renderAppWithFeed(feedOf({ status: 'error', source: 'none' }))

    expect(screen.getAllByText('接続なし')).toHaveLength(2)
    expect(screen.queryByText(/最終/)).toBeNull()
    expect(screen.queryByTestId('wterm-root')).toBeNull()
  })
})

describe('App — useTerminalFeeds と pin の結合', () => {
  it('unpin すると次の周期から read_text を止める', async () => {
    vi.useFakeTimers()
    renderAppWithFeed(feedOf({ status: 'live', source: 'memory', grid: gridOf('live'), updatedAt: 1 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cmux.state.readText).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Unpin terminal' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(cmux.state.readGrid).toHaveBeenCalledTimes(2)
    expect(cmux.state.readText).toHaveBeenCalledOnce()
  })

  it('unpin 中に返った read_text の遅延応答を捨てる', async () => {
    vi.useFakeTimers()
    let resolveText: ((text: string) => void) | undefined
    cmux.state.readText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveText = resolve
        }),
    )
    renderAppWithFeed(feedOf({ status: 'live', source: 'memory', grid: gridOf('live'), updatedAt: 1 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cmux.state.readText).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Unpin terminal' }))
    await act(async () => {
      resolveText?.('late-history')
      await Promise.resolve()
    })

    expect(cmux.state.applyFeedHistory).not.toHaveBeenCalled()
  })

  it('別サーフェスへ切り替えると pin が true に戻る', async () => {
    vi.useFakeTimers()
    const first = terminal('surface:1')
    const second = terminal('surface:2')
    cmux.state.surfaces = [first, second]
    setForeground(first, feedOf({ status: 'live', source: 'memory', grid: gridOf('one'), updatedAt: 1 }))
    const rendered = render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unpin terminal' }))

    setForeground(second, feedOf({ status: 'live', source: 'memory', grid: gridOf('two'), updatedAt: 1 }))
    rendered.rerender(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(cmux.state.readText).toHaveBeenCalledWith(second.ref, expect.objectContaining({ scrollback: true }))
  })
})

describe('App — 切替とタブ操作 (UR3/P8)', () => {
  it('切替時に前の端末画面を残さず、初見でも「読み込み中」を出す', () => {
    const first = terminal('surface:1')
    const second = terminal('surface:2')
    cmux.state.surfaces = [first, second]
    setForeground(first, feedOf({ status: 'live', source: 'memory', grid: gridOf('surface-1-content') }))
    const rendered = render(<App />)
    expect(screen.getByText(/surface-1-content/)).toBeTruthy()

    setForeground(second, feedOf({ status: 'loading', source: 'none' }))
    rendered.rerender(<App />)

    expect(screen.queryByText(/surface-1-content/)).toBeNull()
    expect(screen.getByText('読み込み中')).toBeTruthy()
  })

  it('タブの + は前面サーフェスの workspace_id を指定して作る', () => {
    const surface = terminal('surface:1', 'workspace:26', 'W26')
    setForeground(surface, feedOf({ status: 'loading', source: 'none' }))
    render(<App />)

    fireEvent.click(screen.getByLabelText('New tab'))

    expect(cmux.state.createSurface).toHaveBeenCalledWith('W26')
  })

  it('custom_color が無い複数ワークスペースのタブを既定パレットで区別する', () => {
    const first = terminal('surface:1')
    const second = terminal('surface:2', 'workspace:B', 'w2')
    cmux.state.workspaces = [
      { id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true },
      { id: 'w2', ref: 'workspace:B', title: 'B', index: 1, selected: false },
    ]
    cmux.state.surfaces = [first, second]
    setForeground(first, feedOf({ status: 'loading', source: 'none' }))
    render(<App />)

    const firstDot = screen.getByRole('tab', { name: /A \/ zsh-surface:1/ }).querySelector('span') as HTMLElement
    const secondDot = screen.getByRole('tab', { name: /B \/ zsh-surface:2/ }).querySelector('span') as HTMLElement
    expect(firstDot.style.backgroundColor).toBe('rgb(74, 92, 24)')
    expect(secondDot.style.backgroundColor).toBe('rgb(192, 57, 43)')
  })

  it('端末ゼロでも先頭ワークスペースの UUID を指定してタブを作る', () => {
    cmux.state.workspaces = [
      { id: 'W-first', ref: 'workspace:first', title: 'First', index: 0, selected: true },
      { id: 'W-second', ref: 'workspace:second', title: 'Second', index: 1, selected: false },
    ]
    render(<App />)

    fireEvent.click(screen.getByLabelText('New tab'))

    expect(cmux.state.createSurface).toHaveBeenCalledWith('W-first')
  })

  it('端末もワークスペースも無いときは作成先が無いことを表示する', () => {
    cmux.state.workspaces = []
    render(<App />)

    fireEvent.click(screen.getByLabelText('New tab'))

    expect(screen.getByRole('alert').textContent).toContain('作成先のワークスペースがありません')
    expect(cmux.state.createSurface).not.toHaveBeenCalled()
  })

  it('P8 の誤配置は端末を残したまま警告し、自動 rollback しない', async () => {
    const surface = terminal('surface:1', 'workspace:26', 'W26')
    setForeground(surface, feedOf({ status: 'live', source: 'memory', grid: gridOf('kept-terminal') }))
    cmux.state.createSurface = vi.fn(() => Promise.resolve({ list: [surface], misplaced: true }))
    render(<App />)

    fireEvent.click(screen.getByLabelText('New tab'))

    expect(await screen.findByText(/別のワークスペースに作成されました/)).toBeTruthy()
    expect(screen.getByText(/kept-terminal/)).toBeTruthy()
    expect(cmux.state.closeSurface).not.toHaveBeenCalled()
  })
})

describe('App — browser 分岐は現行維持 (D5)', () => {
  it('browser を前面化すると BrowserView を描き InputBar を無効化する', () => {
    const surface = browser('surface:9')
    setForeground(surface)
    render(<App />)

    expect(screen.getByText('新しいタブで開く ↗')).toBeTruthy()
    expect((screen.getByPlaceholderText('No tab selected') as HTMLInputElement).disabled).toBe(true)
  })

  it('browser には terminal.replay を一度も投げない', async () => {
    vi.useFakeTimers()
    const surface = browser('surface:9')
    setForeground(surface)
    render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(cmux.state.readGrid).not.toHaveBeenCalledWith(surface.ref)
  })
})

describe('App コンテンツのエラー境界分離', () => {
  it('Terminal の描画エラーでも TabBar は残り、別タブ選択/タブを閉じるで復帰できる', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cmux.terminalThrows = true
    const surface = terminal('surface:1')
    setForeground(surface, feedOf({ status: 'live', source: 'memory', grid: gridOf('broken') }))

    render(<App />)

    expect(screen.getByLabelText('New tab')).toBeTruthy()
    const tab = screen.getByRole('tab', { name: /A \/ zsh-surface:1/ })
    expect(tab.getAttribute('aria-keyshortcuts')).toContain('Delete')
    expect(screen.getByTestId('close-tab-hit')).toBeTruthy()
    errSpy.mockRestore()
  })
})
