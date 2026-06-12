// フェーズ1の閾値（px）。実機で調整する（plan Task 9）。
export const TAP_MAX_DISTANCE = 10
export const WHEEL_MIN_DISTANCE = 16
export const WHEEL_STEP_PX = 24
export const WHEEL_MAX_COUNT = 10

export type Gesture = { type: 'tap' } | { type: 'wheel'; direction: 'up' | 'down'; count: number } | { type: 'none' }

export function classifyGesture(args: { dx: number; dy: number }): Gesture {
  const distance = Math.hypot(args.dx, args.dy)
  if (distance <= TAP_MAX_DISTANCE) return { type: 'tap' }

  const isVertical = Math.abs(args.dy) > Math.abs(args.dx) && Math.abs(args.dy) >= WHEEL_MIN_DISTANCE
  if (isVertical) {
    // 指を上へ（dy<0）= コンテンツを上に押し上げ = 次行へ = wheel down。
    const direction = args.dy < 0 ? 'down' : 'up'
    const count = Math.min(WHEEL_MAX_COUNT, Math.max(1, Math.floor(Math.abs(args.dy) / WHEEL_STEP_PX)))
    return { type: 'wheel', direction, count }
  }
  return { type: 'none' }
}
