// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { CmuxNotification, Workspace } from '../../lib/cmux-rpc'
import { Drawer } from '../Drawer'

const ws: Workspace = { id: 'w1', ref: 'workspace:A', title: 'Alpha', index: 0 }

function renderDrawer(notifications: CmuxNotification[] = []) {
  const onCloseWorkspace = vi.fn()
  render(
    <Drawer
      open
      workspaces={[ws]}
      currentWorkspace="workspace:A"
      notifications={notifications}
      onCloseWorkspace={onCloseWorkspace}
      onNewWorkspace={vi.fn().mockResolvedValue(undefined)}
      onClose={() => {}}
    />,
  )
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
    fireEvent.click(screen.getByLabelText('Close workspace'))
    // AlertDialog の確認アクション
    fireEvent.click(screen.getByRole('button', { name: 'ワークスペースを閉じる' }))
    expect(onCloseWorkspace).toHaveBeenCalledWith('workspace:A')
  })

  it('× → 確認ダイアログでキャンセルすると onCloseWorkspace を呼ばない', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCloseWorkspace).not.toHaveBeenCalled()
  })
})

describe('Drawer workspace row', () => {
  function renderWorkspaceRow(innerWidth: number) {
    Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true, writable: true })
    const onClose = vi.fn()
    render(
      <Drawer
        open
        workspaces={[ws]}
        currentWorkspace="workspace:A"
        notifications={[]}
        onCloseWorkspace={() => {}}
        onNewWorkspace={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />,
    )
    return onClose
  }

  it('行タップは workspace.select 相当の callback を要求せず、ドロワーも閉じない', () => {
    const onClose = renderWorkspaceRow(500)
    fireEvent.click(screen.getByText('Alpha'))
    expect(onClose).not.toHaveBeenCalled()
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
    render(
      <Drawer
        open
        workspaces={[ws]}
        currentWorkspace="workspace:A"
        notifications={[]}
        onCloseWorkspace={() => {}}
        onNewWorkspace={onNewWorkspace}
        onClose={() => {}}
      />,
    )
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
