// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { getAuthToken, saveAuthToken } from '../token'

describe('token', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('トークンが未保存かつ URL にも無い場合は空文字を返す', () => {
    expect(getAuthToken()).toBe('')
  })

  it('saveAuthToken で保存したトークンを getAuthToken が返す', () => {
    saveAuthToken('abc123')
    expect(getAuthToken()).toBe('abc123')
  })

  it('前後の空白・改行を除いて保存する', () => {
    saveAuthToken('  abc123\n')
    expect(getAuthToken()).toBe('abc123')
  })

  it('URL の ?token= は保存済みトークンより優先され、localStorage にも保存される', () => {
    saveAuthToken('old')
    window.history.replaceState(null, '', '/?token=new')
    expect(getAuthToken()).toBe('new')
    window.history.replaceState(null, '', '/')
    expect(getAuthToken()).toBe('new')
  })
})
