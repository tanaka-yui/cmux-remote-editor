// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTheme } from '../useTheme'

type Listener = (this: MediaQueryList, ev: MediaQueryListEvent) => void

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
})

// change を発火できる matchMedia モック。matches は可変。
function installMatchMedia(initialDark: boolean) {
  const state = { matches: initialDark, listeners: new Set<Listener>() }
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return state.matches
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: Listener) => state.listeners.add(cb),
        removeEventListener: (_: string, cb: Listener) => state.listeners.delete(cb),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
  return {
    emit(dark: boolean) {
      state.matches = dark
      for (const cb of state.listeners) cb.call({} as MediaQueryList, {} as MediaQueryListEvent)
    },
  }
}

describe('useTheme', () => {
  it('setTheme で data-theme を更新し localStorage に永続する', () => {
    installMatchMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setTheme('dark'))
    expect(result.current.setting).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('cmux:theme')).toBe('dark')
  })

  it('setting=system の間は OS の変更に追従する', () => {
    const mq = installMatchMedia(false)
    renderHook(() => useTheme()) // 既定 system
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    act(() => mq.emit(true))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
