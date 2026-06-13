import type { RenderGrid } from './render-grid'

// InputBar の特殊キーボタンが送る論理キー。
export type SpecialKey = 'up' | 'down' | 'left' | 'right' | 'enter' | 'escape' | 'tab' | 'ctrl+c'

// DECCKM (DEC private mode 1) が on のとき端末は「アプリケーションカーソルキー」モードで、
// 方向キーは \x1bO[A-D]。off（通常）なら \x1b[[A-D]。nvim 等は両方解釈するが正確に出し分ける。
export function isAppCursorMode(grid: RenderGrid | null): boolean {
  return grid?.modes?.some((m) => m.code === 1 && m.on) ?? false
}

const ARROW_FINAL: Record<'up' | 'down' | 'left' | 'right', string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
}

// QWERTY ソフトキーボード用のワンショット修飾キー。
export interface CharMods {
  ctrl: boolean
  shift: boolean
  option: boolean
}

// US ANSI 配列の Shift 記号（非英字キーの shift 押下時の出力）。英字は toUpperCase で扱う。
const SHIFT_MAP: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
}

// 1 文字(英数字/記号/スペース)を修飾キー込みの生バイト列へ変換する。Shift: 英字→大文字 / 記号→US 記号。
// Ctrl: 英字→制御バイト(大文字基準で &0x1f、例 c→\x03)、Space→NUL。Option: 先頭に ESC を前置(Meta)。
export function encodeChar(char: string, mods: CharMods): string {
  let base = char
  if (mods.shift) {
    if (char >= 'a' && char <= 'z') base = char.toUpperCase()
    else if (SHIFT_MAP[char]) base = SHIFT_MAP[char]
  }
  if (mods.ctrl) {
    const upper = char.toUpperCase()
    if (upper >= 'A' && upper <= 'Z') base = String.fromCharCode(upper.charCodeAt(0) & 0x1f)
    else if (char === ' ') base = '\x00'
  }
  return mods.option ? `\x1b${base}` : base
}

// 特殊キーを端末へ送る生バイト列へ変換する。cmux の surface.send_key は key 名の解釈に癖が
// あり方向キーが効かないため、マウス転送と同じ実証済みの send_text 経路で生シーケンスを送る。
export function encodeKey(key: SpecialKey, appCursor: boolean): string {
  switch (key) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return `\x1b${appCursor ? 'O' : '['}${ARROW_FINAL[key]}`
    case 'enter':
      return '\r'
    case 'escape':
      return '\x1b'
    case 'tab':
      return '\t'
    case 'ctrl+c':
      return '\x03'
  }
}
