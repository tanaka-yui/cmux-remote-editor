// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../SettingsModal'

function setup(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const props = {
    open: true,
    themeSetting: 'system' as const,
    onThemeChange: vi.fn(),
    historyLines: 2000,
    pushSupported: true,
    pushEnabled: false,
    onTogglePush: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<SettingsModal {...props} />)
  return props
}

describe('SettingsModal', () => {
  it('テーマセグメントの選択で onThemeChange を呼ぶ', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(props.onThemeChange).toHaveBeenCalledWith('dark')
  })

  it('通知 Switch の操作で onTogglePush を呼ぶ', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('switch'))
    expect(props.onTogglePush).toHaveBeenCalledWith(true)
  })

  it('保存で現在の履歴行数を onSave して閉じる', () => {
    const props = setup()
    fireEvent.click(screen.getByText('保存'))
    expect(props.onSave).toHaveBeenCalledWith(2000)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('open=false では中身を描画しない', () => {
    setup({ open: false })
    expect(screen.queryByText('保存')).toBeNull()
  })
})
