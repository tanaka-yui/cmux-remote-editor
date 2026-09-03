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
    fireEvent.click(screen.getAllByLabelText('Close tab')[0] as HTMLElement)
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

  it('activity のあるタブはドットが 6px に拡大する', () => {
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
    const { container } = render(<TabBar {...base} feeds={feeds} />)
    const dot = container.querySelector('[data-testid="live-dot"]') as HTMLElement
    expect(dot.style.width).toBe('6px')
  })
})
