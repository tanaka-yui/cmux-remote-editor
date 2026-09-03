// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'

interface WorkspaceStub {
  id: string
  ref: string
  title: string
  index: number
  selected: boolean
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
}

interface CmuxStateStub {
  status: 'connected'
  topologyReady: boolean
  workspaces: WorkspaceStub[]
  currentWorkspace: string | null
  surfaces: SurfaceStub[]
  currentSurface: string | null
  notifications: never[]
  view: { subscriptions: { ref: string }[] }
  listWorkspaces: () => Promise<WorkspaceStub[]>
  listPanes: () => Promise<never[]>
  listSurfaces: (ref?: string) => Promise<SurfaceStub[]>
  createSurface: (workspaceId: string) => Promise<{ list: SurfaceStub[]; misplaced: boolean }>
  createWorkspace: () => Promise<SurfaceStub[]>
  closeSurface: (ref: string) => Promise<SurfaceStub[]>
  closeWorkspace: (ref: string) => Promise<WorkspaceStub[]>
  focusSurface: (ref: string) => void
  selectSurface: (surface: SurfaceStub) => void
  initializeFrom: (surfaces: SurfaceStub[], preferredRef: string | null) => void
  requestTopologyRefresh: () => Promise<{
    generation: number
    surfaces: SurfaceStub[]
    workspaces: WorkspaceStub[]
  }>
  readText: () => Promise<string>
  readGrid: () => Promise<{ columns: number; rows: number; styles: never[]; row_spans: never[] }>
  sendText: () => Promise<void>
  sendKey: () => Promise<void>
  listNotifications: () => Promise<never[]>
  navigateSurface: () => void
}

// useCmux をモックし、listSurfaces の呼び出し引数を記録する。
const cmux = vi.hoisted(() => ({
  state: {} as CmuxStateStub,
  listSurfaceCalls: [] as (string | undefined)[],
  // true のとき Terminal がレンダリング例外を投げる（停止端末の grid.columns クラッシュを再現）。
  terminalThrows: false,
  messageListener: { fn: (_event: MessageEvent) => {} },
}))

vi.mock('../hooks/useCmux', () => ({ useCmux: () => cmux.state }))
vi.mock('../components/Terminal', () => ({
  Terminal: () => {
    if (cmux.terminalThrows) throw new Error("undefined is not an object (evaluating 'e.columns')")
    return null
  },
}))
vi.mock('../lib/token', () => ({ getAuthToken: () => 'tok', saveAuthToken: () => {} }))

beforeEach(() => {
  cmux.listSurfaceCalls = []
  cmux.terminalThrows = false
  cmux.messageListener.fn = () => {}
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        cmux.messageListener.fn = listener
      },
      removeEventListener: vi.fn(),
    },
  })
  // jsdom は matchMedia 未実装のためスタブする。
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
    currentSurface: null,
    notifications: [],
    view: { subscriptions: [] },
    listWorkspaces: vi.fn(() =>
      Promise.resolve([{ id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true }]),
    ),
    listPanes: vi.fn(() => Promise.resolve([])),
    listSurfaces: vi.fn((ref?: string) => {
      cmux.listSurfaceCalls.push(ref)
      return Promise.resolve([])
    }),
    createSurface: vi.fn(() => Promise.resolve({ list: [], misplaced: false })),
    createWorkspace: vi.fn(() => Promise.resolve([])),
    closeSurface: vi.fn(() => Promise.resolve([])),
    closeWorkspace: vi.fn(() => Promise.resolve([])),
    focusSurface: vi.fn(),
    selectSurface: vi.fn(),
    initializeFrom: vi.fn(),
    requestTopologyRefresh: vi.fn(() => Promise.resolve({ generation: 1, surfaces: [], workspaces: [] })),
    readText: vi.fn(() => Promise.resolve('')),
    readGrid: vi.fn(() => Promise.resolve({ columns: 80, rows: 24, styles: [], row_spans: [] })),
    sendText: vi.fn(() => Promise.resolve()),
    sendKey: vi.fn(() => Promise.resolve()),
    listNotifications: vi.fn(() => Promise.resolve([])),
    navigateSurface: vi.fn(),
  }
})

describe('App topology bootstrap', () => {
  it('topologyReady の一覧だけで initialize し、surface/workspace を直接取得しない', async () => {
    render(<App />)

    await waitFor(() => expect(cmux.state.initializeFrom).toHaveBeenCalledWith([], null))

    expect(cmux.listSurfaceCalls).toHaveLength(0)
    expect(cmux.state.listWorkspaces).not.toHaveBeenCalled()
    expect(cmux.state.listNotifications).toHaveBeenCalledOnce()
  })

  it('SW の workspace UUID を購読中 surface に解決して selectSurface する', () => {
    const surface: SurfaceStub = {
      index: 0,
      ref: 'surface:1',
      selected: true,
      title: 'zsh',
      type: 'terminal',
      workspace_ref: 'workspace:A',
      workspace_title: 'A',
      workspace_id: 'w1',
    }
    cmux.state.surfaces = [surface]
    cmux.state.view = { subscriptions: [{ ref: 'surface:1' }] }

    render(<App />)
    act(() => {
      cmux.messageListener.fn(new MessageEvent('message', { data: { type: 'navigate', workspaceId: 'w1' } }))
    })

    expect(cmux.state.selectSurface).toHaveBeenCalledWith(surface)
  })
})

describe('App コンテンツのエラー境界分離', () => {
  it('Terminal の描画エラーでも TabBar は残り、別タブ選択/タブを閉じるで復帰できる', () => {
    // 停止端末(zsh 未起動)などで Terminal がレンダリング例外を投げても、エラー境界をコンテンツ領域
    // だけに分離してあるので TabBar は生き続ける。最上位境界がアプリ全体を畳むと、再読み込みでも
    // 同じ surface が復元されて即再クラッシュし逃げ場が消えるための回帰ガード。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    cmux.terminalThrows = true
    cmux.state.surfaces = [
      {
        ref: 'surface:1',
        title: 't1',
        type: 'terminal',
        index: 0,
        selected: true,
        workspace_ref: 'workspace:A',
        workspace_title: 'A',
        workspace_id: 'w1',
      },
    ]
    cmux.state.currentSurface = 'surface:1'

    const { getByLabelText } = render(<App />)

    // 新規タブと当該タブの「閉じる」が残る = 別タブへ切替/このタブを閉じるが可能。
    expect(getByLabelText('New tab')).toBeTruthy()
    expect(getByLabelText('Close tab')).toBeTruthy()
    errSpy.mockRestore()
  })
})
