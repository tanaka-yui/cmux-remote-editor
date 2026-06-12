// 蓋を閉じた（スクリーンロック / occlusion）状態では cmux 側がテキストモデルの
// 更新を止め、PWA も切断/リロードで内容が揮発しうる。最後に取得済みの画面と
// スクロールバックをサーフェスごとに localStorage へ保存し、オフライン/復帰時に
// 「直前までの履歴」を読み取り専用で表示できるようにする。IndexedDB ではなく
// localStorage を使うのは、数百KB に収まり jsdom で追加依存なく単体テストできるため。
import type { RenderGrid } from './render-grid'

const KEY_PREFIX = 'cmux-surface-cache:'

// 1 サーフェスあたりの保存上限（文字数）。超過分は末尾（最新行）を残して切り詰める。
export const MAX_CACHED_CHARS = 200_000

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

export function saveSurfaceScreen(surfaceRef: string, screen: CachedScreen): void {
  if (typeof window === 'undefined') return

  // 未指定のフィールドは既存値を引き継ぐ（ライブ poll は grid のみ、履歴 fetch は
  // scrollback のみ、を渡すため）。これで text/scrollback/grid が互いを潰さない。
  const prev = loadSurfaceScreen(surfaceRef)
  const clamped: CachedScreen = { updatedAt: screen.updatedAt }

  const text = screen.text ?? prev?.text
  if (text !== undefined) clamped.text = clampTail(text)

  const scrollback = screen.scrollback ?? prev?.scrollback
  if (scrollback !== undefined) clamped.scrollback = clampTail(scrollback)

  const grid = screen.grid ?? prev?.grid
  if (grid !== undefined) clamped.grid = grid

  try {
    localStorage.setItem(keyFor(surfaceRef), JSON.stringify(clamped))
  } catch {
    // クォータ超過等は無視する（キャッシュは best-effort）。
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
