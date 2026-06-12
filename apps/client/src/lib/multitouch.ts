// 一本指タップ判定と二本指の中心点計算の純粋ロジック。
// スクロールはブラウザのネイティブに任せるため、パン/ピンチの判定は持たない。
// DOM 配線は Terminal.tsx 側で行い、ここは座標計算のみに閉じる。

export interface Point {
  x: number
  y: number
}

export interface TouchPoint {
  clientX: number
  clientY: number
}

// タップ（ほぼ動いていない）とみなす最大移動量（px）。これを超えたらドラッグ=スクロール扱い。
export const TAP_MAX_DISTANCE = 10

// 2 タッチの中心点（クライアント座標）。二本指タップ→右クリックの着弾位置に使う。
export function centroid(a: TouchPoint, b: TouchPoint): Point {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
}

// 2 タッチ間のユークリッド距離。二本指ピンチ（フォント増減）の判定に使う。
export function touchDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

// 移動量がタップ範囲内か。
export function isTap(dx: number, dy: number, max = TAP_MAX_DISTANCE): boolean {
  return Math.hypot(dx, dy) <= max
}
