import { describe, expect, it } from 'vitest'

import { isAtBottom, isOverscrollUp } from '../scroll-intent'

describe('isOverscrollUp', () => {
  it('上端で過去方向(負)に閾値超え → true', () => {
    expect(isOverscrollUp({ scrollTop: 0, deltaY: -20, threshold: 8 })).toBe(true)
  })
  it('上端でも下方向(正)は false', () => {
    expect(isOverscrollUp({ scrollTop: 0, deltaY: 20, threshold: 8 })).toBe(false)
  })
  it('上端でも閾値未満は false', () => {
    expect(isOverscrollUp({ scrollTop: 0, deltaY: -3, threshold: 8 })).toBe(false)
  })
  it('上端でない(scrollTop>atTopEpsilon)なら過去方向でも false', () => {
    expect(isOverscrollUp({ scrollTop: 50, deltaY: -20, threshold: 8 })).toBe(false)
  })
  it('atTopEpsilon 以内は上端扱い', () => {
    expect(isOverscrollUp({ scrollTop: 1, deltaY: -20, threshold: 8, atTopEpsilon: 1 })).toBe(true)
  })
  it('境界: deltaY がちょうど -threshold なら発動する（at-or-beyond）', () => {
    expect(isOverscrollUp({ scrollTop: 0, deltaY: -8, threshold: 8 })).toBe(true)
  })
  it('atTopEpsilon 省略時はデフォルト 1 が使われる', () => {
    expect(isOverscrollUp({ scrollTop: 1, deltaY: -20, threshold: 8 })).toBe(true)
  })
})

describe('isAtBottom', () => {
  it('最下部 → true', () => {
    expect(isAtBottom({ scrollTop: 980, clientHeight: 20, scrollHeight: 1000 })).toBe(true)
  })
  it('途中 → false', () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 20, scrollHeight: 1000 })).toBe(false)
  })
  it('epsilon 以内は最下部扱い', () => {
    expect(isAtBottom({ scrollTop: 979, clientHeight: 20, scrollHeight: 1000, epsilon: 2 })).toBe(true)
  })
  it('epsilon を狭めると同じ位置でも最下部扱いにならない', () => {
    expect(isAtBottom({ scrollTop: 979, clientHeight: 20, scrollHeight: 1000, epsilon: 0 })).toBe(false)
  })
  it('epsilon 省略時はデフォルト 2 が使われる', () => {
    expect(isAtBottom({ scrollTop: 978, clientHeight: 20, scrollHeight: 1000 })).toBe(true)
  })
})
