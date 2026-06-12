// 蓋を閉じた（スクリーンロック / occlusion）状態では cmux 側がテキストモデルの
// 更新を止め、PWA も切断/リロードで内容が揮発しうる。最後に取得済みの画面と
// スクロールバックをサーフェスごとに localStorage へ保存し、オフライン/復帰時に
// 「直前までの履歴」を読み取り専用で表示できるようにする。IndexedDB ではなく
// localStorage を使うのは、数百KB に収まり jsdom で追加依存なく単体テストできるため。
const KEY_PREFIX = 'cmux-surface-cache:'

// 1 サーフェスあたりの保存上限（文字数）。超過分は末尾（最新行）を残して切り詰める。
export const MAX_CACHED_CHARS = 200_000

export interface CachedScreen {
  text: string
  scrollback?: string
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

  const clamped: CachedScreen = {
    text: clampTail(screen.text),
    updatedAt: screen.updatedAt,
  }
  // ライブポーリングは可視画面のみ保存し scrollback を渡さない。直近に取得済みの
  // scrollback をオフライン閲覧用に維持するため、未指定時は既存値を引き継ぐ。
  const scrollback = screen.scrollback ?? loadSurfaceScreen(surfaceRef)?.scrollback
  if (scrollback !== undefined) clamped.scrollback = clampTail(scrollback)

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
    if (typeof parsed.text !== 'string' || typeof parsed.updatedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}
