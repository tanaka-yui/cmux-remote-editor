export interface CellPos {
  col: number
  row: number
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

// wterm 描画要素の実寸（padding 込みの content サイズ）から 1 セルの px を求める。
export function cellSize(args: {
  contentWidth: number
  contentHeight: number
  cols: number
  rows: number
  padding: number
}): { cellWidth: number; cellHeight: number } {
  return {
    cellWidth: (args.contentWidth - args.padding * 2) / args.cols,
    cellHeight: (args.contentHeight - args.padding * 2) / args.rows,
  }
}

// クライアント座標 → 1-based セル位置（範囲 clamp）。
export function pixelToCell(args: {
  clientX: number
  clientY: number
  rectLeft: number
  rectTop: number
  scrollLeft: number
  scrollTop: number
  cellWidth: number
  cellHeight: number
  padding: number
  cols: number
  rows: number
}): CellPos {
  const x = args.clientX - args.rectLeft + args.scrollLeft - args.padding
  const y = args.clientY - args.rectTop + args.scrollTop - args.padding
  const col = clamp(Math.floor(x / args.cellWidth) + 1, 1, args.cols)
  const row = clamp(Math.floor(y / args.cellHeight) + 1, 1, args.rows)
  return { col, row }
}
