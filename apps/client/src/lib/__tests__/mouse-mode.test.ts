import { describe, expect, it } from 'vitest'
import { deriveMouseMode } from '../mouse-mode'
import type { RenderGrid } from '../render-grid'

function gridWith(modes: { code: number; on: boolean }[]): RenderGrid {
  return {
    columns: 80,
    rows: 24,
    styles: [],
    row_spans: [],
    modes: modes.map((m) => ({ code: m.code, ansi: false, on: m.on })),
  }
}

describe('deriveMouseMode', () => {
  it('grid が null なら無効', () => {
    expect(deriveMouseMode(null)).toEqual({ mouseEnabled: false, useSgr: false })
  })

  it('modes 未定義なら無効', () => {
    const grid = gridWith([])
    grid.modes = undefined
    expect(deriveMouseMode(grid)).toEqual({ mouseEnabled: false, useSgr: false })
  })

  it('1002 と 1006 が on（mouse=a の nvim）なら有効 + SGR', () => {
    const grid = gridWith([
      { code: 1000, on: false },
      { code: 1002, on: true },
      { code: 1006, on: true },
    ])
    expect(deriveMouseMode(grid)).toEqual({ mouseEnabled: true, useSgr: true })
  })

  it('1000 が on なら有効（1006 off は useSgr false）', () => {
    const grid = gridWith([{ code: 1000, on: true }])
    expect(deriveMouseMode(grid)).toEqual({ mouseEnabled: true, useSgr: false })
  })

  it('全マウスモード off（通常シェル）なら無効', () => {
    const grid = gridWith([
      { code: 1000, on: false },
      { code: 1002, on: false },
      { code: 1003, on: false },
      { code: 1006, on: false },
    ])
    expect(deriveMouseMode(grid)).toEqual({ mouseEnabled: false, useSgr: false })
  })
})
