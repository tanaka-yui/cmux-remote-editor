export type MouseButton = 'left' | 'right'
export type MouseAction = 'press' | 'release'

export interface CmuxMouseEvent {
  button: MouseButton
  action: MouseAction
  // 1-based のセル座標。
  col: number
  row: number
}

const BUTTON_CODE: Record<MouseButton, number> = {
  left: 0,
  right: 2,
}

// SGR 拡張マウス（DECSET 1006）の 1 イベント。press は 'M'、release は 'm'。
export function encodeMouse(ev: CmuxMouseEvent): string {
  const code = BUTTON_CODE[ev.button]
  const final = ev.action === 'press' ? 'M' : 'm'
  return `\x1b[<${code};${ev.col};${ev.row}${final}`
}

// 1 クリック分（press → release）をまとめて返す。
export function encodeClick(button: MouseButton, col: number, row: number): string {
  return encodeMouse({ button, action: 'press', col, row }) + encodeMouse({ button, action: 'release', col, row })
}
