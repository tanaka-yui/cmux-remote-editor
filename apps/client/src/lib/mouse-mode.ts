import type { RenderGrid } from './render-grid'

export interface MouseMode {
  // 端末がマウス入力を受け付ける状態か（DECSET 1000/1002/1003 のいずれか on）。
  mouseEnabled: boolean
  // SGR 拡張座標形式（DECSET 1006）が有効か。
  useSgr: boolean
}

const TRACKING_CODES = [1000, 1002, 1003]
const SGR_CODE = 1006

export function deriveMouseMode(grid: RenderGrid | null): MouseMode {
  const modes = grid?.modes
  if (!modes) return { mouseEnabled: false, useSgr: false }
  const isOn = (code: number) => modes.some((m) => m.code === code && m.on)
  return {
    mouseEnabled: TRACKING_CODES.some(isOn),
    useSgr: isOn(SGR_CODE),
  }
}
