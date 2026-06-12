import { describe, expect, it } from 'vitest'

import { cellSize, pixelToCell } from '../terminal-coords'

describe('cellSize', () => {
  it('padding を除いた描画領域を cols/rows で割る', () => {
    // contentWidth 808 - padding*2(16) = 792 / 80 = 9.9 / 行: 408-16=392 / 24 ≒ 16.33
    expect(cellSize({ contentWidth: 808, contentHeight: 408, cols: 80, rows: 24, padding: 8 })).toEqual({
      cellWidth: 9.9,
      cellHeight: (408 - 16) / 24,
    })
  })
})

describe('pixelToCell', () => {
  const base = {
    rectLeft: 0,
    rectTop: 0,
    scrollLeft: 0,
    scrollTop: 0,
    cellWidth: 10,
    cellHeight: 20,
    padding: 8,
    cols: 80,
    rows: 24,
  }

  it('左上 padding 内は (1,1)', () => {
    expect(pixelToCell({ ...base, clientX: 8, clientY: 8 })).toEqual({ col: 1, row: 1 })
  })

  it('1 セル分進むと (2,1)', () => {
    expect(pixelToCell({ ...base, clientX: 8 + 10, clientY: 8 })).toEqual({ col: 2, row: 1 })
  })

  it('rect オフセットと scroll を差し引く', () => {
    expect(pixelToCell({ ...base, rectLeft: 100, scrollLeft: 50, clientX: 100 - 50 + 8 + 20, clientY: 8 })).toEqual({
      col: 3,
      row: 1,
    })
  })

  it('範囲外は端に clamp する', () => {
    expect(pixelToCell({ ...base, clientX: 100000, clientY: 100000 })).toEqual({ col: 80, row: 24 })
    expect(pixelToCell({ ...base, clientX: -100, clientY: -100 })).toEqual({ col: 1, row: 1 })
  })
})
