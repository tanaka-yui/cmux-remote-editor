// スクロール位置の純粋判定。DOM から数値を渡して判定だけ行う（副作用なし＝単体テスト可能）。

const DEFAULT_BOTTOM_EPSILON = 2

// スクロール位置が最下部（誤差 epsilon 内）に達しているか。ピン留め（末尾追従）判定に使う。
export function isAtBottom(args: {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  epsilon?: number
}): boolean {
  const { scrollTop, clientHeight, scrollHeight, epsilon = DEFAULT_BOTTOM_EPSILON } = args
  return scrollHeight - (scrollTop + clientHeight) <= epsilon
}
