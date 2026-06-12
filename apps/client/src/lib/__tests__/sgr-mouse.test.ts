import { describe, expect, it } from 'vitest'

import { encodeClick, encodeMouse } from '../sgr-mouse'

describe('encodeMouse', () => {
  it('左クリック press は \\x1b[<0;col;rowM', () => {
    expect(encodeMouse({ button: 'left', action: 'press', col: 5, row: 3 })).toBe('\x1b[<0;5;3M')
  })

  it('左クリック release は小文字 m', () => {
    expect(encodeMouse({ button: 'left', action: 'release', col: 5, row: 3 })).toBe('\x1b[<0;5;3m')
  })

  it('右クリックは code 2', () => {
    expect(encodeMouse({ button: 'right', action: 'press', col: 10, row: 20 })).toBe('\x1b[<2;10;20M')
  })
})

describe('encodeClick', () => {
  it('左クリックは press+release をまとめて返す', () => {
    expect(encodeClick('left', 2, 2)).toBe('\x1b[<0;2;2M\x1b[<0;2;2m')
  })

  it('右クリックは code 2 の press+release', () => {
    expect(encodeClick('right', 4, 6)).toBe('\x1b[<2;4;6M\x1b[<2;4;6m')
  })
})
