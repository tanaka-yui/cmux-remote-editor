export type MouseButton = 'left' | 'wheelUp' | 'wheelDown'
export type MouseAction = 'press' | 'release'

export interface MouseEvent {
  button: MouseButton
  action: MouseAction
  // 1-based のセル座標。
  col: number
  row: number
}

const BUTTON_CODE: Record<MouseButton, number> = {
  left: 0,
  wheelUp: 64,
  wheelDown: 65,
}

// SGR 拡張マウス（DECSET 1006）の 1 イベント。press は 'M'、release は 'm'。
export function encodeMouse(ev: MouseEvent): string {
  const code = BUTTON_CODE[ev.button]
  const final = ev.action === 'press' ? 'M' : 'm'
  return `\x1b[<${code};${ev.col};${ev.row}${final}`
}
