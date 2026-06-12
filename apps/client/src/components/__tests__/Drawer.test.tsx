// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Workspace } from '../../lib/cmux-rpc'
import { Drawer } from '../Drawer'

const ws: Workspace = { id: 'w1', ref: 'workspace:A', title: 'Alpha', index: 0 }

function renderDrawer() {
  const onCloseWorkspace = vi.fn()
  render(
    <Drawer
      open
      workspaces={[ws]}
      currentWorkspace="workspace:A"
      notifications={[]}
      onSelect={() => {}}
      onCloseWorkspace={onCloseWorkspace}
      onClose={() => {}}
    />,
  )
  return onCloseWorkspace
}

describe('Drawer close workspace (2 段階確認)', () => {
  it('× を 1 回押しただけでは onCloseWorkspace を呼ばない', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    expect(onCloseWorkspace).not.toHaveBeenCalled()
  })

  it('× → 確定で onCloseWorkspace(ref) を呼ぶ', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    fireEvent.click(screen.getByLabelText('Confirm close'))
    expect(onCloseWorkspace).toHaveBeenCalledWith('workspace:A')
  })

  it('× → 取消で onCloseWorkspace を呼ばず、閉じるボタンへ戻る', () => {
    const onCloseWorkspace = renderDrawer()
    fireEvent.click(screen.getByLabelText('Close workspace'))
    fireEvent.click(screen.getByLabelText('Cancel close'))
    expect(onCloseWorkspace).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Close workspace')).toBeDefined()
  })
})
