import { describe, expect, it } from 'vitest'

import { centroid, isTap, touchDistance } from '../multitouch'

describe('centroid', () => {
  it('2 タッチの中点を返す', () => {
    expect(centroid({ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 20 })).toEqual({ x: 5, y: 10 })
  })
})

describe('touchDistance', () => {
  it('2 タッチ間のユークリッド距離', () => {
    expect(touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5)
  })
})

describe('isTap', () => {
  it('わずかな移動は tap', () => {
    expect(isTap(2, -3)).toBe(true)
  })

  it('閾値を超える移動は tap ではない', () => {
    expect(isTap(20, 0)).toBe(false)
  })
})
