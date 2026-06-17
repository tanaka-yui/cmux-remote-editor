import { useCallback, useEffect, useState } from 'react'

import { applyTheme, loadTheme, resolveTheme, saveTheme, type ThemeSetting } from '../lib/theme'

// テーマ設定の状態を保持し、DOM への反映と OS 設定追従を担う。アプリ全体で 1 回だけ使う。
export function useTheme() {
  const [setting, setSetting] = useState<ThemeSetting>(loadTheme)

  useEffect(() => {
    applyTheme(resolveTheme(setting))
    // 'system' のときだけ OS 変更を購読して即追従する。light/dark 固定時は購読不要。
    if (setting !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(resolveTheme('system'))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [setting])

  const setTheme = useCallback((next: ThemeSetting) => {
    saveTheme(next)
    setSetting(next)
  }, [])

  return { setting, resolved: resolveTheme(setting), setTheme }
}
