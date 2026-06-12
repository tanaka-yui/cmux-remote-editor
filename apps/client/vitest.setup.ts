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
