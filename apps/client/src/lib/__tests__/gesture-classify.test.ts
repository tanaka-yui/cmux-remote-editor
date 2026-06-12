import { describe, expect, it } from 'vitest'

import { classifyGesture } from '../gesture-classify'

describe('classifyGesture', () => {
  it('ほぼ動かなければ tap', () => {
    expect(classifyGesture({ dx: 2, dy: -3 })).toEqual({ type: 'tap' })
  })

  it('指を上へ大きく動かすと wheel down（コンテンツが次行へ）', () => {
    // dy = -48 → count = floor(48/24) = 2
    expect(classifyGesture({ dx: 1, dy: -48 })).toEqual({ type: 'wheel', direction: 'down', count: 2 })
  })

  it('指を下へ動かすと wheel up', () => {
    expect(classifyGesture({ dx: 0, dy: 30 })).toEqual({ type: 'wheel', direction: 'up', count: 1 })
  })

  it('横移動が主なら none（タブ切替は App 側で処理）', () => {
    expect(classifyGesture({ dx: 60, dy: 5 })).toEqual({ type: 'none' })
  })

  it('ホイール数は上限で頭打ち', () => {
    expect(classifyGesture({ dx: 0, dy: -10000 })).toEqual({ type: 'wheel', direction: 'down', count: 10 })
  })
})
