// ポーリングごとの選択解決。優先順位:
// 1. アプリが選択中(prev)で、それがまだリストに存在 → prev を維持(アプリ優先)
// 2. アプリ未選択(初回など) → cmux の selected/focused を初期選択として採用
// 3. どちらも無い → 先頭へフォールバック(リモートで閉じられた時の退避)
export function resolveSelectedRef<T>(
  prev: string | null,
  list: T[],
  getRef: (item: T) => string,
  isActive: (item: T) => boolean,
): string | null {
  if (prev && list.some((item) => getRef(item) === prev)) return prev
  const active = list.find(isActive)
  if (active) return getRef(active)
  return list[0] ? getRef(list[0]) : null
}
