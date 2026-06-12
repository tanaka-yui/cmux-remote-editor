import { describe, expect, it } from 'vitest'

import { touchToMouseSequence } from '../touch-to-mouse'

const geo = {
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

describe('touchToMouseSequence', () => {
  it('SGR 無効なら null（送らない）', () => {
    const out = touchToMouseSequence({
      useSgr: false,
      start: { clientX: 18, clientY: 28 },
      end: { clientX: 18, clientY: 28 },
      ...geo,
    })
    expect(out).toBeNull()
  })

  it('タップは start 位置の左クリック press+release', () => {
    // x=18 → col2, y=28 → row2
    const out = touchToMouseSequence({
      useSgr: true,
      start: { clientX: 18, clientY: 28 },
      end: { clientX: 19, clientY: 27 },
      ...geo,
    })
    expect(out).toBe('\x1b[<0;2;2M\x1b[<0;2;2m')
  })

  it('上スワイプは start 位置のホイール下を count 回', () => {
    // dy=-48 → wheel down count2、start x=18→col2 y=28→row2
    const out = touchToMouseSequence({
      useSgr: true,
      start: { clientX: 18, clientY: 28 },
      end: { clientX: 18, clientY: 28 - 48 },
      ...geo,
    })
    expect(out).toBe('\x1b[<65;2;2M\x1b[<65;2;2M')
  })

  it('横移動主は null', () => {
    const out = touchToMouseSequence({
      useSgr: true,
      start: { clientX: 18, clientY: 28 },
      end: { clientX: 18 + 60, clientY: 30 },
      ...geo,
    })
    expect(out).toBeNull()
  })
})
