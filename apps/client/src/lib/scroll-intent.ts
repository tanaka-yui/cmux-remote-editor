// スクロール意図の純粋判定。DOM/タッチから数値を渡して判定だけ行う（副作用なし＝単体テスト可能）。
// deltaY の符号規約: 過去を見る方向（上スクロール／遡り）を負とする。
//   wheel: e.deltaY をそのまま（上スクロール時に負）。
//   touch: 指が下へ動く＝上端のコンテンツが出る＝遡り。startY - currentY を渡す（指が下=負）。

const DEFAULT_TOP_EPSILON = 1
const DEFAULT_BOTTOM_EPSILON = 2

// 上端でさらに過去方向（負）へ閾値を超えて動かそうとしたか。
export function isOverscrollUp(args: {
  scrollTop: number
  deltaY: number
  threshold: number
  atTopEpsilon?: number
}): boolean {
  const { scrollTop, deltaY, threshold, atTopEpsilon = DEFAULT_TOP_EPSILON } = args
  // 境界はちょうど threshold で発動する（at-or-beyond, deltaY === -threshold も true）。
  return scrollTop <= atTopEpsilon && deltaY <= -threshold
}

// スクロール位置が最下部（誤差 epsilon 内）に達しているか。
export function isAtBottom(args: {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  epsilon?: number
}): boolean {
  const { scrollTop, clientHeight, scrollHeight, epsilon = DEFAULT_BOTTOM_EPSILON } = args
  return scrollHeight - (scrollTop + clientHeight) <= epsilon
}
