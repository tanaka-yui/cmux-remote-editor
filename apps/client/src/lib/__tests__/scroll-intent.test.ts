import { describe, expect, it } from 'vitest'

import { isAtBottom } from '../scroll-intent'

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
