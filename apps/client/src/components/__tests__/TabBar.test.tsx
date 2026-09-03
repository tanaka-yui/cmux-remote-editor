// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { TerminalFeed } from '../../lib/view-state'
import { TabBar } from '../TabBar'

const surfaces = [
  {
    index: 0,
    ref: 'surface:1',
    selected: false,
    title: '[1] zsh',
    type: 'terminal',
    workspace_ref: 'workspace:1',
    workspace_title: 'influencer-platform',
    workspace_id: 'W1',
    pane_ref: 'pane:1',
  },
  {
    index: 1,
    ref: 'surface:2',
    selected: false,
    title: '[2] zsh',
    type: 'terminal',
    workspace_ref: 'workspace:26',
    workspace_title: 'freelance-jp-app',
    workspace_id: 'W26',
    pane_ref: 'pane:9',
  },
  {
    index: 2,
    ref: 'surface:9',
    selected: false,
    title: 'docs',
    type: 'browser',
    workspace_ref: 'workspace:26',
    workspace_title: 'freelance-jp-app',
    workspace_id: 'W26',
    pane_ref: 'pane:9',
    url: 'https://example.com',
  },
]

const base = {
  surfaces,
  foreground: 'surface:1',
  subscribedRefs: new Set(['surface:1']),
  feeds: new Map<string, TerminalFeed>(),
  workspaceColor: () => '#888',
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onCreate: vi.fn(),
}

describe('TabBar', () => {
  it('全ワークスペースのサーフェスを描画する（UR1）', () => {
    render(<TabBar {...base} />)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('aria-label に workspace 名と購読状態を含める（同名タブを区別できる）', () => {
    render(<TabBar {...base} />)
    expect(screen.getByRole('tab', { name: 'influencer-platform / zsh、ライブ購読中' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'freelance-jp-app / zsh、未購読' })).toBeTruthy()
  })

  it('browser タブは「購読対象外」と読み上げる', () => {
    render(<TabBar {...base} />)
    expect(screen.getByRole('tab', { name: 'freelance-jp-app / docs、browser、購読対象外' })).toBeTruthy()
  })

  it('購読中/非購読でドットを出し分ける（UR2 の回帰ガード）', () => {
    const { container } = render(<TabBar {...base} />)
    expect(container.querySelectorAll('[data-testid="live-dot"]')).toHaveLength(1)
  })

  it('browser にはドットを出さない', () => {
    const withBrowserSubscribed = { ...base, subscribedRefs: new Set(['surface:1', 'surface:9']) }
    const { container } = render(<TabBar {...withBrowserSubscribed} />)
    const dots = [...container.querySelectorAll('[data-testid="live-dot"]')]
    expect(dots.every((dot) => dot.closest('[role="tab"]')?.getAttribute('data-ref') !== 'surface:9')).toBe(true)
  })

  it('ワークスペースの変わり目に区切り線を引く', () => {
    const { container } = render(<TabBar {...base} />)
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect((tabs[1] as HTMLElement).style.borderLeft).toContain('--color-tab-group-border')
    expect((tabs[0] as HTMLElement).style.borderLeft).toBe('')
  })

  it('タップで onSelect に Surface を渡す（ref ではない）', () => {
    const onSelect = vi.fn()
    render(<TabBar {...base} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('tab', { name: /freelance-jp-app \/ zsh/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:2' }))
  })

  it('× で onClose、+ で onCreate', () => {
    const onClose = vi.fn()
    const onCreate = vi.fn()
    render(<TabBar {...base} onClose={onClose} onCreate={onCreate} />)
    fireEvent.click(screen.getAllByTestId('close-tab-hit')[0] as HTMLElement)
    expect(onClose).toHaveBeenCalledWith('surface:1')
    fireEvent.click(screen.getByLabelText('New tab'))
    expect(onCreate).toHaveBeenCalled()
  })

  it('前面が変わるとアクティブタブが scrollIntoView される', () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const { rerender } = render(<TabBar {...base} />)
    spy.mockClear()
    rerender(<TabBar {...base} foreground="surface:2" />)
    expect(spy).toHaveBeenCalled()
  })

  it('status が error のタブはドットが警告色になる', () => {
    const feeds = new Map<string, TerminalFeed>([
      [
        'surface:1',
        {
          status: 'error',
          source: 'memory',
          grid: null,
          history: '',
          updatedAt: null,
          activity: false,
          contentHash: '',
          epoch: 1,
          promotedAt: 0,
        },
      ],
    ])
    const { container } = render(<TabBar {...base} feeds={feeds} />)
    const dot = container.querySelector('[data-testid="live-dot"]') as HTMLElement
    expect(dot.style.backgroundColor).toContain('--color-warning')
  })

  it('非購読terminalの保持されたerror feedにも警告ドットを出す', () => {
    const feeds = new Map<string, TerminalFeed>([
      [
        'surface:2',
        {
          status: 'error',
          source: 'memory',
          grid: null,
          history: '',
          updatedAt: null,
          activity: false,
          contentHash: '',
          epoch: 1,
          promotedAt: 0,
        },
      ],
    ])
    render(<TabBar {...base} subscribedRefs={new Set()} feeds={feeds} />)
    const tab = screen.getByRole('tab', { name: 'freelance-jp-app / zsh、未購読' })
    const dot = tab.querySelector('[data-testid="live-dot"]') as HTMLElement
    expect(dot.style.backgroundColor).toContain('--color-warning')
  })

  it('activity を塗りと読み上げで伝え、更新なしは輪郭で区別する', () => {
    const feeds = new Map<string, TerminalFeed>([
      [
        'surface:1',
        {
          status: 'live',
          source: 'memory',
          grid: null,
          history: '',
          updatedAt: null,
          activity: true,
          contentHash: '',
          epoch: 1,
          promotedAt: 0,
        },
      ],
    ])
    const { container, rerender } = render(<TabBar {...base} feeds={feeds} />)
    const activeTab = screen.getByRole('tab', {
      name: 'influencer-platform / zsh、ライブ購読中、更新あり',
    })
    const activeDot = activeTab.querySelector('[data-testid="live-dot"]') as HTMLElement
    expect(activeDot.style.backgroundColor).toContain('--color-accent')
    expect(activeDot.style.border).not.toContain('--color-accent')

    rerender(<TabBar {...base} />)
    const idleDot = container.querySelector('[data-testid="live-dot"]') as HTMLElement
    expect(idleDot.style.backgroundColor).toBe('transparent')
    expect(idleDot.style.border).toContain('--color-accent')
  })

  it('tablist 内はロービング対象だけをTab停止点にし、+ は兄弟に保つ', () => {
    const onClose = vi.fn()
    render(<TabBar {...base} onClose={onClose} />)
    const tablist = screen.getByRole('tablist')
    const createButton = screen.getByRole('button', { name: 'New tab' })
    const activeTab = screen.getByRole('tab', {
      name: 'influencer-platform / zsh、ライブ購読中',
    })

    expect(tablist.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    expect(tablist.querySelectorAll('button[tabindex="-1"]')).toHaveLength(surfaces.length)
    expect([...tablist.querySelectorAll('button')].every((button) => button.tabIndex === -1)).toBe(true)
    expect(createButton.parentElement).toBe(tablist.parentElement)
    expect(tablist.contains(createButton)).toBe(false)
    expect(activeTab.getAttribute('aria-keyshortcuts')).toBe('Delete')
    fireEvent.keyDown(activeTab, { key: 'Delete' })
    expect(onClose).toHaveBeenCalledWith('surface:1')
  })

  it('タッチ用の閉じるボタンを読み上げ可能にしつつTab停止点にはしない', () => {
    render(<TabBar {...base} />)
    const activeTab = screen.getByRole('tab', {
      name: 'influencer-platform / zsh、ライブ購読中',
      description: 'Deleteキーでタブを閉じる',
    })
    const closeButtons = screen.getAllByRole('button', { name: 'タブを閉じる' })

    expect(closeButtons).toHaveLength(surfaces.length)
    expect(closeButtons.every((button) => button.tabIndex === -1)).toBe(true)
    expect(activeTab.hasAttribute('aria-description')).toBe(false)
    expect(activeTab.getAttribute('aria-describedby')).toBeTruthy()
  })

  it('Backspace はタブを閉じない', () => {
    const onClose = vi.fn()
    render(<TabBar {...base} onClose={onClose} />)
    const activeTab = screen.getByRole('tab', {
      name: 'influencer-platform / zsh、ライブ購読中',
    })

    fireEvent.keyDown(activeTab, { key: 'Backspace' })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('左右矢印でロービングフォーカスを移動する', () => {
    const onSelect = vi.fn()
    render(<TabBar {...base} onSelect={onSelect} />)
    const first = screen.getByRole('tab', { name: 'influencer-platform / zsh、ライブ購読中' })
    const second = screen.getByRole('tab', { name: 'freelance-jp-app / zsh、未購読' })

    first.focus()
    expect(first.tabIndex).toBe(0)
    expect(second.tabIndex).toBe(-1)
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(second)
    expect(first.tabIndex).toBe(-1)
    expect(second.tabIndex).toBe(0)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('前面でないロービング対象を閉じると次のタブへフォーカスを移し停止点を1つ保つ', () => {
    const onClose = vi.fn()
    const { rerender } = render(<TabBar {...base} onClose={onClose} />)
    const first = screen.getByRole('tab', { name: 'influencer-platform / zsh、ライブ購読中' })
    const second = screen.getByRole('tab', { name: 'freelance-jp-app / zsh、未購読' })
    const third = screen.getByRole('tab', { name: 'freelance-jp-app / docs、browser、購読対象外' })

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(second)

    fireEvent.keyDown(second, { key: 'Delete' })
    expect(onClose).toHaveBeenCalledWith('surface:2')
    expect(document.activeElement).toBe(third)

    const remainingSurfaces = surfaces.filter((surface) => surface.ref !== 'surface:2')
    rerender(<TabBar {...base} surfaces={remainingSurfaces} onClose={onClose} />)
    const tablist = screen.getByRole('tablist')
    expect(tablist.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
    expect(third.tabIndex).toBe(0)
    expect(document.activeElement).toBe(third)
  })

  it('最右タブを閉じると直前のタブへフォーカスを移す', () => {
    const onClose = vi.fn()
    render(<TabBar {...base} onClose={onClose} />)
    const first = screen.getByRole('tab', { name: 'influencer-platform / zsh、ライブ購読中' })
    const second = screen.getByRole('tab', { name: 'freelance-jp-app / zsh、未購読' })
    const third = screen.getByRole('tab', { name: 'freelance-jp-app / docs、browser、購読対象外' })

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    fireEvent.keyDown(second, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(third)

    fireEvent.keyDown(third, { key: 'Delete' })

    expect(onClose).toHaveBeenCalledWith('surface:9')
    expect(document.activeElement).toBe(second)
  })

  it('外部更新でロービング対象が消えても前面タブをTab停止点に戻す', () => {
    const { rerender } = render(<TabBar {...base} />)
    const first = screen.getByRole('tab', { name: 'influencer-platform / zsh、ライブ購読中' })
    const second = screen.getByRole('tab', { name: 'freelance-jp-app / zsh、未購読' })

    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(second.tabIndex).toBe(0)

    rerender(<TabBar {...base} surfaces={surfaces.filter((surface) => surface.ref !== 'surface:2')} />)
    const tablist = screen.getByRole('tablist')
    expect(tablist.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
    expect(first.tabIndex).toBe(0)
  })

  it('Space はスクロールせずタブを選択する', () => {
    const onSelect = vi.fn()
    render(<TabBar {...base} onSelect={onSelect} />)
    const tab = screen.getByRole('tab', { name: 'freelance-jp-app / zsh、未購読' })

    expect(fireEvent.keyDown(tab, { key: ' ' })).toBe(false)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:2' }))
  })

  it('× のポインター操作は親タブを選択しない', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<TabBar {...base} onSelect={onSelect} onClose={onClose} />)
    const closePath = screen.getAllByTestId('close-tab-hit')[0]?.querySelector('path')

    expect(closePath).toBeTruthy()
    if (!closePath) return
    fireEvent.click(closePath)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('閉じるボタン上の Delete は親タブの選択・閉じる処理へ伝播しない', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<TabBar {...base} onSelect={onSelect} onClose={onClose} />)
    const closeButton = screen.getAllByRole('button', { name: 'タブを閉じる' })[0]

    expect(closeButton).toBeTruthy()
    if (!closeButton) return
    fireEvent.keyDown(closeButton, { key: 'Delete' })

    expect(onClose).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('閉じるヒット領域を24px四方以上にし、アイコンとバーのサイズは維持する', () => {
    render(<TabBar {...base} />)
    const tablist = screen.getByRole('tablist')
    const tabBar = tablist.parentElement as HTMLElement
    const closeButton = screen.getAllByRole('button', { name: 'タブを閉じる' })[0] as HTMLButtonElement
    const closeIcon = closeButton.querySelector('svg')

    expect(Number.parseFloat(getComputedStyle(closeButton).width)).toBeGreaterThanOrEqual(24)
    expect(Number.parseFloat(getComputedStyle(closeButton).height)).toBeGreaterThanOrEqual(24)
    expect(closeIcon?.getAttribute('width')).toBe('14')
    expect(closeIcon?.getAttribute('height')).toBe('14')
    expect(tabBar.style.height).toBe('38px')
  })
})
