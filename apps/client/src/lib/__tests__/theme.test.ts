// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, loadTheme, resolveTheme, saveTheme } from '../theme'

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
})

function mockPrefersDark(matches: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  )
}

describe('loadTheme / saveTheme', () => {
  it('未設定は system を返す', () => {
    expect(loadTheme()).toBe('system')
  })

  it('保存した値を読み戻す', () => {
    saveTheme('dark')
    expect(loadTheme()).toBe('dark')
  })

  it('不正値は system にフォールバック', () => {
    localStorage.setItem('cmux:theme', 'bogus')
    expect(loadTheme()).toBe('system')
  })
})

describe('resolveTheme', () => {
  it('light/dark はそのまま返す', () => {
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('system は prefers-color-scheme: dark に従う', () => {
    mockPrefersDark(true)
    expect(resolveTheme('system')).toBe('dark')
    mockPrefersDark(false)
    expect(resolveTheme('system')).toBe('light')
  })
})

describe('applyTheme', () => {
  it('data-theme 属性と theme-color メタを更新する', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('content', '#000000')
    document.head.appendChild(meta)

    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(meta.getAttribute('content')).toBe('#f4f5f7')

    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(meta.getAttribute('content')).toBe('#1a1a2e')

    meta.remove()
  })
})
