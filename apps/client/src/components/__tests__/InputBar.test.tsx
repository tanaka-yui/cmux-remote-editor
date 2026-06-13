// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InputBar } from '../InputBar'

afterEach(cleanup)

function setup() {
  const onSendText = vi.fn()
  const onSendKey = vi.fn()
  render(<InputBar disabled={false} onSendText={onSendText} onSendKey={onSendKey} onAdjustFontSize={() => {}} />)
  // QWERTY パネルを開く。
  fireEvent.click(screen.getByLabelText('キーボード表示切替'))
  return { onSendText, onSendKey }
}

describe('InputBar QWERTY パネル', () => {
  it('武装した Ctrl は次の1キーに適用され、その後自動解除される', () => {
    const { onSendText } = setup()
    fireEvent.click(screen.getByText('Ctrl'))
    fireEvent.click(screen.getByText('c'))
    expect(onSendText).toHaveBeenLastCalledWith('\x03') // Ctrl+C
    // ワンショットなので次の 'c' は素の 'c'。
    fireEvent.click(screen.getByText('c'))
    expect(onSendText).toHaveBeenLastCalledWith('c')
  })

  it('Shift 武装中は英字が大文字表示になり大文字を送る', () => {
    const { onSendText } = setup()
    fireEvent.click(screen.getByText('Shift'))
    fireEvent.click(screen.getByText('A')) // 'a' が 'A' 表示になっている
    expect(onSendText).toHaveBeenLastCalledWith('A')
  })

  it('⌫/⏎ は生シーケンス、Option 武装時は ESC 前置', () => {
    const { onSendText } = setup()
    fireEvent.click(screen.getByLabelText('Backspace'))
    expect(onSendText).toHaveBeenLastCalledWith('\x7f')
    fireEvent.click(screen.getByText('Opt'))
    fireEvent.click(screen.getByLabelText('Enter'))
    expect(onSendText).toHaveBeenLastCalledWith('\x1b\r') // Alt+Enter
  })
})
