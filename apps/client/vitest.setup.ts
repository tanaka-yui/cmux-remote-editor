import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// 各テスト後に React ツリーをアンマウントして DOM を片付ける。これをしないと
// 同一ファイル内の複数 render が body に蓄積し、getByLabelText などが複数要素に
// マッチして失敗する。
afterEach(() => {
  cleanup()
})

// vitest 4 + jsdom 29 の組み合わせでは window.localStorage が空オブジェクトとして
// 露出し、getItem/setItem/clear などが未定義になる（getItem is not a function）。
// surface-cache・token・useCmux のテストは jsdom の localStorage を前提にしているため、
// テスト用に最小のインメモリ Storage を注入して本来の挙動を復元する。
function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) as string) : null
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, String(value))
    },
  }
}

function installStorage(target: object, storage: Storage) {
  const existing = Object.getOwnPropertyDescriptor(target, 'localStorage')
  // jsdom が機能する localStorage を既に提供している場合は触らない。
  if (existing && typeof (existing.value as Storage | undefined)?.getItem === 'function') return
  Object.defineProperty(target, 'localStorage', { value: storage, configurable: true, writable: true })
}

const storage = createMemoryStorage()
installStorage(globalThis, storage)
if (typeof window !== 'undefined') installStorage(window, storage)

// jsdom には matchMedia が無い。theme（'system' 解決）と radix が参照するため最小モックを入れる。
// 既定は light（matches:false）。テーマ系テストは window.matchMedia を各自で差し替える。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// radix Slider/一部プリミティブが要求する ResizeObserver を補う。
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// radix Slider/Dialog が使う pointer capture と scrollIntoView を no-op で補う。
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {}
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
}
