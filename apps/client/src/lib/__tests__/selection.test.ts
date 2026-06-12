import { describe, expect, it } from 'vitest'

import { resolveSelectedRef } from '../selection'

interface Item {
  ref: string
  active: boolean
}

const getRef = (i: Item) => i.ref
const isActive = (i: Item) => i.active

describe('resolveSelectedRef', () => {
  it('初回(prev=null)は active な項目を採用する', () => {
    const list: Item[] = [
      { ref: 'a', active: false },
      { ref: 'b', active: true },
    ]
    expect(resolveSelectedRef(null, list, getRef, isActive)).toBe('b')
  })

  it('アプリ選択(prev)が存在する限り、active が別へ移っても上書きしない', () => {
    const list: Item[] = [
      { ref: 'a', active: false },
      { ref: 'b', active: true },
    ]
    expect(resolveSelectedRef('a', list, getRef, isActive)).toBe('a')
  })

  it('prev がリストから消えたら active へ退避する', () => {
    const list: Item[] = [
      { ref: 'b', active: true },
      { ref: 'c', active: false },
    ]
    expect(resolveSelectedRef('a', list, getRef, isActive)).toBe('b')
  })

  it('prev も active も無ければ先頭へフォールバックする', () => {
    const list: Item[] = [
      { ref: 'b', active: false },
      { ref: 'c', active: false },
    ]
    expect(resolveSelectedRef('a', list, getRef, isActive)).toBe('b')
  })

  it('空リストでは null を返す', () => {
    expect(resolveSelectedRef('a', [], getRef, isActive)).toBeNull()
  })
})
