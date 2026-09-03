// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { CmuxNotification, Surface, Workspace } from '../../lib/cmux-rpc'
import { Drawer } from '../Drawer'

const ws: Workspace = { id: 'w1', ref: 'workspace:A', title: 'influencer-platform', index: 0 }
const secondWorkspace: Workspace = { id: 'w2', ref: 'workspace:B', title: 'freelance-jp-app', index: 1 }
const surfaces: Surface[] = [
  {
    index: 0,
    ref: 'surface:1',
    selected: false,
    title: '[1] zsh',
    type: 'terminal',
    workspace_ref: 'workspace:A',
    workspace_title: 'influencer-platform',
    workspace_id: 'w1',
  },
  {
    index: 1,
    ref: 'surface:2',
    selected: false,
    title: '[2] zsh',
    type: 'terminal',
    workspace_ref: 'workspace:B',
    workspace_title: 'freelance-jp-app',
    workspace_id: 'w2',
  },
]

const base = {
  open: true,
  workspaces: [ws, secondWorkspace],
  currentWorkspace: 'workspace:A',
  notifications: [] as CmuxNotification[],
  surfaces,
  foreground: 'surface:1',
  subscribedRefs: new Set<string>(),
  onSelectSurface: vi.fn(),
  onCloseSurface: vi.fn(),
  onCloseWorkspace: vi.fn(),
  onNewWorkspace: vi.fn().mockResolvedValue(undefined),
  onClose: vi.fn(),
}

function renderDrawer(notifications: CmuxNotification[] = []) {
  const onCloseWorkspace = vi.fn()
  render(<Drawer {...base} notifications={notifications} onCloseWorkspace={onCloseWorkspace} />)
  return onCloseWorkspace
}

const waitingUnread: CmuxNotification = {
  id: 'n1',
  title: 'Alpha',
  subtitle: 'waiting',
  body: 'waiting for your input',
  workspace_id: 'w1',
  surface_id: 's1',
  is_read: false,
}

describe('Drawer close workspace (確認ダイアログ)', () => {
  it('× → 確認ダイアログで「閉じる」を押すと onCloseWorkspace(ref) を呼ぶ', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getAllByLabelText('Close workspace')[0] as HTMLElement)
    // AlertDialog の確認アクション
    fireEvent.click(screen.getByRole('button', { name: 'ワークスペースを閉じる' }))
    expect(onCloseWorkspace).toHaveBeenCalledWith('workspace:A')
  })

  it('× → 確認ダイアログでキャンセルすると onCloseWorkspace を呼ばない', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getAllByLabelText('Close workspace')[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCloseWorkspace).not.toHaveBeenCalled()
  })
})

describe('Drawer workspace row', () => {
  it('ワークスペース行のタップは展開/折りたたみだけで、サーフェスの前面化を起こさない', () => {
    const onSelectSurface = vi.fn()
    render(<Drawer {...base} foreground={null} onSelectSurface={onSelectSurface} />)
    fireEvent.click(screen.getByText('freelance-jp-app'))
    expect(screen.getByText('[2] zsh')).toBeTruthy()
    expect(onSelectSurface).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('freelance-jp-app'))
    expect(screen.queryByText('[2] zsh')).toBeNull()
    expect(onSelectSurface).not.toHaveBeenCalled()
  })

  it('サーフェス行タップで onSelectSurface に Surface を渡す', () => {
    const onSelectSurface = vi.fn()
    render(<Drawer {...base} onSelectSurface={onSelectSurface} />)
    fireEvent.click(screen.getByText('[1] zsh'))
    expect(onSelectSurface).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:1' }))
  })

  it('サーフェス行は前面と購読状態を読み上げられる', () => {
    render(<Drawer {...base} subscribedRefs={new Set(['surface:1'])} />)
    const currentSurface = screen.getByRole('button', {
      name: 'influencer-platform / [1] zsh、ライブ購読中',
    })

    expect(currentSurface.getAttribute('aria-current')).toBe('true')
  })

  it('独立した閉じるボタンでサーフェスを選択せず閉じる', () => {
    const onSelectSurface = vi.fn()
    const onCloseSurface = vi.fn()
    render(<Drawer {...base} onSelectSurface={onSelectSurface} onCloseSurface={onCloseSurface} />)
    const selectButton = screen.getByRole('button', {
      name: 'influencer-platform / [1] zsh、未購読',
    })
    const closeButton = screen.getByRole('button', {
      name: 'influencer-platform / [1] zshを閉じる',
    })

    expect(closeButton.parentElement).toBe(selectButton.parentElement)
    fireEvent.click(closeButton)
    expect(onCloseSurface).toHaveBeenCalledWith('surface:1')
    expect(onSelectSurface).not.toHaveBeenCalled()
  })

  it('既定で展開されるのは前面サーフェスがあるワークスペースだけ', () => {
    render(<Drawer {...base} foreground="surface:1" />)
    expect(screen.getByText('[1] zsh')).toBeTruthy()
    expect(screen.queryByText('[2] zsh')).toBeNull()
  })

  it('購読中のサーフェス行には行頭にドットを出す（タブ行と表現を揃える）', () => {
    const { container } = render(<Drawer {...base} subscribedRefs={new Set(['surface:1'])} />)
    expect(container.querySelectorAll('[data-testid="live-dot"]').length).toBeGreaterThan(0)
  })
})

describe('Drawer status badge (is_read ゲート)', () => {
  it('未読の waiting 通知は Needs input を表示する', () => {
    renderDrawer([waitingUnread])
    expect(screen.getByText('Needs input')).toBeDefined()
  })

  it('既読の waiting 通知は Needs input を表示しない（cmux で応答済み）', () => {
    renderDrawer([{ ...waitingUnread, is_read: true }])
    expect(screen.queryByText('Needs input')).toBeNull()
  })
})

describe('Drawer new workspace button', () => {
  function renderWithNewWorkspace(onNewWorkspace: () => Promise<void>) {
    render(<Drawer {...base} onNewWorkspace={onNewWorkspace} />)
  }

  it('フッターに新規ワークスペースボタンを描画する', () => {
    renderWithNewWorkspace(vi.fn().mockResolvedValue(undefined))
    expect(screen.getByLabelText('New workspace')).toBeDefined()
  })

  it('クリックで onNewWorkspace を呼ぶ', async () => {
    const onNewWorkspace = vi.fn().mockResolvedValue(undefined)
    renderWithNewWorkspace(onNewWorkspace)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('New workspace'))
    })
    expect(onNewWorkspace).toHaveBeenCalledTimes(1)
  })
})
