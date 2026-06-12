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
