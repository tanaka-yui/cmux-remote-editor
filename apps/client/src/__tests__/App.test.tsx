// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'

// useCmux をモックし、listSurfaces/listPanes に渡された workspaceRef を記録する。
const cmux = vi.hoisted(() => ({
  // biome-ignore lint/suspicious/noExplicitAny: テスト用のフック戻り値スタブ
  state: {} as any,
  listSurfaceCalls: [] as (string | undefined)[],
}))

vi.mock('../hooks/useCmux', () => ({ useCmux: () => cmux.state }))
vi.mock('../hooks/useGesture', () => ({ useGesture: () => () => {} }))
vi.mock('../components/Terminal', () => ({ Terminal: () => null }))
vi.mock('../lib/token', () => ({ getAuthToken: () => 'tok', saveAuthToken: () => {} }))

beforeEach(() => {
  cmux.listSurfaceCalls = []
  // jsdom は matchMedia 未実装のためスタブする。
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: matchMedia スタブ
  }) as any
  cmux.state = {
    status: 'connected',
    workspaces: [{ id: 'w1', ref: 'workspace:A', title: 'A', index: 0, selected: true }],
    currentWorkspace: 'workspace:A',
    surfaces: [],
    currentSurface: null,
    notifications: [],
    listWorkspaces: vi.fn(() => Promise.resolve([{ ref: 'workspace:A', selected: true }])),
    selectWorkspace: vi.fn(),
    listPanes: vi.fn(() => Promise.resolve([])),
    listSurfaces: vi.fn((ref?: string) => {
      cmux.listSurfaceCalls.push(ref)
      return Promise.resolve([])
    }),
    createSurface: vi.fn(() => Promise.resolve([])),
    closeSurface: vi.fn(() => Promise.resolve([])),
    focusSurface: vi.fn(),
    readText: vi.fn(() => Promise.resolve('')),
    sendText: vi.fn(() => Promise.resolve()),
    sendKey: vi.fn(() => Promise.resolve()),
    listNotifications: vi.fn(() => Promise.resolve([])),
    navigateSurface: vi.fn(),
  }
})

describe('App surface フェッチ', () => {
  it('surface.list を常に workspace_ref 付きで取得し、全ワークスペースの混入を招く未指定取得をしない', async () => {
    render(<App />)

    // 初期化チェーン（listWorkspaces → listNotifications）の完了を待つ。
    await waitFor(() => expect(cmux.state.listNotifications).toHaveBeenCalled())

    expect(cmux.listSurfaceCalls.length).toBeGreaterThan(0)
    // workspaceRef 未指定（undefined）の呼び出しがあると、サーバーは全ワークスペースの
    // surface を返してしまい、他ワークスペースのタブが混入する。
    expect(cmux.listSurfaceCalls.every((ref) => ref === 'workspace:A')).toBe(true)
  })
})
