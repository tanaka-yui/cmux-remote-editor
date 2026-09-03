// 蓋を閉じた（スクリーンロック / occlusion）状態では cmux 側がテキストモデルの
// 更新を止め、PWA も切断/リロードで内容が揮発しうる。最後に取得済みの画面と
// スクロールバックをサーフェスごとに localStorage へ保存し、オフライン/復帰時に
// 「直前までの履歴」を読み取り専用で表示できるようにする。IndexedDB ではなく
// localStorage を使うのは、数百KB に収まり jsdom で追加依存なく単体テストできるため。
import type { RenderGrid } from './render-grid'

const KEY_PREFIX = 'cmux-surface-cache:'

// 1 サーフェスあたりの保存上限（文字数）。超過分は末尾（最新行）を残して切り詰める。
export const MAX_CACHED_CHARS = 200_000
// 直列化後の 1 entry の上限（実バイト数）。text/scrollback に別々の文字数上限をかけても
// grid と JSON のオーバーヘッドが載るため、1 件で 500KB を超えうる。
export const MAX_CACHED_ENTRY_BYTES = 256 * 1024
// C3 が働く前に件数が無限に増えないようにする二次ガード。
export const MAX_CACHED_SURFACES = 12

const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).length
}

export interface CachedScreen {
  text?: string
  scrollback?: string
  // ライブ描画のオフライン表示用に最後の render_grid を保持する。
  grid?: RenderGrid
  updatedAt: number
}

function keyFor(surfaceRef: string): string {
  return `${KEY_PREFIX}${surfaceRef}`
}

// ターミナル出力は末尾が最新なので、上限超過時は先頭を捨てて末尾を残す。
function clampTail(value: string): string {
  return value.length > MAX_CACHED_CHARS ? value.slice(value.length - MAX_CACHED_CHARS) : value
}

function cacheKeys(): { key: string; updatedAt: number }[] {
  const out: { key: string; updatedAt: number }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key === null || !key.startsWith(KEY_PREFIX)) continue

    const raw = localStorage.getItem(key)
    let updatedAt = 0
    if (raw !== null) {
      try {
        updatedAt = (JSON.parse(raw) as CachedScreen).updatedAt ?? 0
      } catch {
        updatedAt = 0
      }
    }
    out.push({ key, updatedAt })
  }
  return out.sort((a, b) => a.updatedAt - b.updatedAt)
}

// C5: scrollback -> text -> grid の順に削って entry を上限に収める。
// grid だけでも超えるなら null を返し、その entry は保存しない。
function fitEntry(entry: CachedScreen): string | null {
  const attempt = (candidate: CachedScreen): string | null => {
    const json = JSON.stringify(candidate)
    return byteLength(json) <= MAX_CACHED_ENTRY_BYTES ? json : null
  }

  const fitTail = (candidate: CachedScreen, field: 'text' | 'scrollback'): string | null => {
    const value = candidate[field]
    if (value === undefined) return null

    let lower = 0
    let upper = value.length
    let payload: string | null = null
    while (lower <= upper) {
      const retained = Math.floor((lower + upper) / 2)
      const json = attempt({ ...candidate, [field]: value.slice(value.length - retained) })
      if (json === null) {
        upper = retained - 1
      } else {
        payload = json
        lower = retained + 1
      }
    }
    return payload
  }

  const full = attempt(entry)
  if (full !== null) return full

  const trimmedScrollback = fitTail(entry, 'scrollback')
  if (trimmedScrollback !== null) return trimmedScrollback

  const withoutScrollback: CachedScreen = { ...entry, scrollback: undefined }
  const noScrollback = attempt(withoutScrollback)
  if (noScrollback !== null) return noScrollback

  const trimmedText = fitTail(withoutScrollback, 'text')
  if (trimmedText !== null) return trimmedText

  return attempt({ grid: entry.grid, updatedAt: entry.updatedAt })
}

export function saveSurfaceScreen(surfaceRef: string, screen: CachedScreen): void {
  if (typeof window === 'undefined') return

  // 未指定のフィールドは既存値を引き継ぐ（ライブ poll は grid のみ、履歴 fetch は
  // scrollback のみ、を渡すため）。これで text/scrollback/grid が互いを潰さない。
  const prev = loadSurfaceScreen(surfaceRef)
  const merged: CachedScreen = { updatedAt: screen.updatedAt }

  const text = screen.text ?? prev?.text
  if (text !== undefined) merged.text = clampTail(text)

  const scrollback = screen.scrollback ?? prev?.scrollback
  if (scrollback !== undefined) merged.scrollback = clampTail(scrollback)

  const grid = screen.grid ?? prev?.grid
  if (grid !== undefined) merged.grid = grid

  const payload = fitEntry(merged)
  if (payload === null) return

  const key = keyFor(surfaceRef)
  const others = cacheKeys().filter((entry) => entry.key !== key)
  while (others.length >= MAX_CACHED_SURFACES) {
    const oldest = others.shift()
    if (!oldest) break
    localStorage.removeItem(oldest.key)
  }

  const candidates = cacheKeys().filter((entry) => entry.key !== key)
  for (;;) {
    try {
      localStorage.setItem(key, payload)
      return
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'QuotaExceededError') return
      const victim = candidates.shift()
      if (!victim) return
      localStorage.removeItem(victim.key)
    }
  }
}

export function loadSurfaceScreen(surfaceRef: string): CachedScreen | null {
  if (typeof window === 'undefined') return null

  const raw = localStorage.getItem(keyFor(surfaceRef))
  if (raw === null) return null

  try {
    const parsed = JSON.parse(raw) as CachedScreen
    if (typeof parsed.updatedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}
