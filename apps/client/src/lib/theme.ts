// テーマ設定の永続化・実テーマ解決・DOM 反映。設定値は 'system'|'light'|'dark' の 3 択で、
// 'system' のときだけ OS の prefers-color-scheme を参照する。lib/settings.ts と同じ流儀で
// localStorage ガードを置く。
export type ThemeSetting = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const KEY = 'cmux:theme'

// data-theme ごとの theme-color（PWA/iOS ステータスバー色）。各 --color-bg と一致させる。
const THEME_COLORS: Record<ResolvedTheme, string> = {
  dark: '#1a1a2e',
  light: '#f4f5f7',
}

export function loadTheme(): ThemeSetting {
  if (typeof localStorage === 'undefined') return 'system'
  const raw = localStorage.getItem(KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

export function saveTheme(setting: ThemeSetting): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, setting)
}

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting === 'light' || setting === 'dark') return setting
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolved)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved])
}
