import { describe, expect, it } from 'vitest'
import type { RenderGrid } from '../render-grid'
import { type CharMods, encodeChar, encodeKey, isAppCursorMode } from '../terminal-keys'

const NO_MODS: CharMods = { ctrl: false, shift: false, option: false }

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

describe('encodeChar', () => {
  it('修飾なしはそのまま', () => {
    expect(encodeChar('a', NO_MODS)).toBe('a')
    expect(encodeChar('1', NO_MODS)).toBe('1')
    expect(encodeChar(' ', NO_MODS)).toBe(' ')
  })

  it('Shift は英字→大文字・数字/記号→US Shift 記号', () => {
    expect(encodeChar('a', { ...NO_MODS, shift: true })).toBe('A')
    expect(encodeChar('1', { ...NO_MODS, shift: true })).toBe('!')
    expect(encodeChar('0', { ...NO_MODS, shift: true })).toBe(')')
    expect(encodeChar('-', { ...NO_MODS, shift: true })).toBe('_')
    expect(encodeChar('=', { ...NO_MODS, shift: true })).toBe('+')
    expect(encodeChar('[', { ...NO_MODS, shift: true })).toBe('{')
    expect(encodeChar('\\', { ...NO_MODS, shift: true })).toBe('|')
    expect(encodeChar(';', { ...NO_MODS, shift: true })).toBe(':')
    expect(encodeChar('/', { ...NO_MODS, shift: true })).toBe('?')
    expect(encodeChar('`', { ...NO_MODS, shift: true })).toBe('~')
  })

  it('Ctrl は英字→制御バイト・Space→NUL', () => {
    expect(encodeChar('c', { ...NO_MODS, ctrl: true })).toBe('\x03')
    expect(encodeChar('a', { ...NO_MODS, ctrl: true })).toBe('\x01')
    expect(encodeChar(' ', { ...NO_MODS, ctrl: true })).toBe('\x00')
  })

  it('Ctrl+Shift は大文字基準で同じ制御バイト', () => {
    expect(encodeChar('c', { ctrl: true, shift: true, option: false })).toBe('\x03')
  })

  it('Option は先頭に ESC を前置', () => {
    expect(encodeChar('f', { ...NO_MODS, option: true })).toBe('\x1bf')
    expect(encodeChar('a', { ctrl: true, shift: false, option: true })).toBe('\x1b\x01')
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
