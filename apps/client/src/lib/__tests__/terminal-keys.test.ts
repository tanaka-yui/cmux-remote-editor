import { describe, expect, it } from 'vitest'
import type { RenderGrid } from '../render-grid'
import { encodeKey, isAppCursorMode } from '../terminal-keys'

describe('encodeKey', () => {
  it('通常カーソルキーモードの方向キーは \\x1b[ 系', () => {
    expect(encodeKey('up', false)).toBe('\x1b[A')
    expect(encodeKey('down', false)).toBe('\x1b[B')
    expect(encodeKey('right', false)).toBe('\x1b[C')
    expect(encodeKey('left', false)).toBe('\x1b[D')
  })

  it('アプリケーションカーソルキーモードの方向キーは \\x1bO 系', () => {
    expect(encodeKey('up', true)).toBe('\x1bOA')
    expect(encodeKey('down', true)).toBe('\x1bOB')
    expect(encodeKey('right', true)).toBe('\x1bOC')
    expect(encodeKey('left', true)).toBe('\x1bOD')
  })

  it('特殊キーは生バイト列', () => {
    expect(encodeKey('enter', false)).toBe('\r')
    expect(encodeKey('escape', false)).toBe('\x1b')
    expect(encodeKey('tab', false)).toBe('\t')
    expect(encodeKey('ctrl+c', false)).toBe('\x03')
  })
})

describe('isAppCursorMode', () => {
  const base: RenderGrid = { columns: 80, rows: 24, styles: [], row_spans: [] }

  it('mode 1 が on なら true', () => {
    expect(isAppCursorMode({ ...base, modes: [{ code: 1, ansi: false, on: true }] })).toBe(true)
  })

  it('mode 1 が off / 無し / grid 不在なら false', () => {
    expect(isAppCursorMode({ ...base, modes: [{ code: 1, ansi: false, on: false }] })).toBe(false)
    expect(isAppCursorMode(base)).toBe(false)
    expect(isAppCursorMode(null)).toBe(false)
  })
})
