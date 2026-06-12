import { classifyGesture } from './gesture-classify'
import { encodeMouse } from './sgr-mouse'
import { pixelToCell } from './terminal-coords'

interface Point {
  clientX: number
  clientY: number
}

export interface TouchToMouseArgs {
  useSgr: boolean
  start: Point
  end: Point
  rectLeft: number
  rectTop: number
  scrollLeft: number
  scrollTop: number
  cellWidth: number
  cellHeight: number
  padding: number
  cols: number
  rows: number
}

// touch 開始/終了から cmux へ送る SGR マウス列を組み立てる。送らない場合は null。
export function touchToMouseSequence(args: TouchToMouseArgs): string | null {
  if (!args.useSgr) return null

  const gesture = classifyGesture({
    dx: args.end.clientX - args.start.clientX,
    dy: args.end.clientY - args.start.clientY,
  })
  if (gesture.type === 'none') return null

  const cell = pixelToCell({
    clientX: args.start.clientX,
    clientY: args.start.clientY,
    rectLeft: args.rectLeft,
    rectTop: args.rectTop,
    scrollLeft: args.scrollLeft,
    scrollTop: args.scrollTop,
    cellWidth: args.cellWidth,
    cellHeight: args.cellHeight,
    padding: args.padding,
    cols: args.cols,
    rows: args.rows,
  })

  if (gesture.type === 'tap') {
    return (
      encodeMouse({ button: 'left', action: 'press', col: cell.col, row: cell.row }) +
      encodeMouse({ button: 'left', action: 'release', col: cell.col, row: cell.row })
    )
  }

  const button = gesture.direction === 'down' ? 'wheelDown' : 'wheelUp'
  const notch = encodeMouse({ button, action: 'press', col: cell.col, row: cell.row })
  return notch.repeat(gesture.count)
}
