import { describe, expect, it } from 'vitest'

import { encodeMouse } from '../sgr-mouse'

describe('encodeMouse', () => {
  it('左クリック press は \\x1b[<0;col;rowM', () => {
    expect(encodeMouse({ button: 'left', action: 'press', col: 5, row: 3 })).toBe('\x1b[<0;5;3M')
  })

  it('左クリック release は小文字 m', () => {
    expect(encodeMouse({ button: 'left', action: 'release', col: 5, row: 3 })).toBe('\x1b[<0;5;3m')
  })

  it('ホイール上は code 64（press 固定）', () => {
    expect(encodeMouse({ button: 'wheelUp', action: 'press', col: 1, row: 1 })).toBe('\x1b[<64;1;1M')
  })

  it('ホイール下は code 65', () => {
    expect(encodeMouse({ button: 'wheelDown', action: 'press', col: 10, row: 20 })).toBe('\x1b[<65;10;20M')
  })
})
