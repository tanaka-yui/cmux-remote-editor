import { registerSW } from 'virtual:pwa-register'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
// ターミナル用の等幅 CJK フォント(M PLUS 1 Code, CJK=2×Latin)。Menlo 等は CJK を持たず、システム
// フォールバック(Hiragino)が 1.66:1 でセル(cmux は全角=2セル)とズレ隔間が出るため、2:1 のフォントを同梱。
// Latin と日本語サブセット(weight 400)のみ取り込み precache を抑える。bold は faux-bold(等幅維持)。
import '@fontsource/m-plus-1-code/latin-400.css'
import '@fontsource/m-plus-1-code/japanese-400.css'
import './styles/global.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Auto-updating service worker managed by vite-plugin-pwa.
registerSW({ immediate: true })
