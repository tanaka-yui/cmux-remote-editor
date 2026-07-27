// cmux ソケットの terminal.replay が返す描画グリッド（format "cmux.render-grid.v1"）を
// ANSI シーケンスへ変換する。surface.read_text のプレーンテキストと違い、色・属性・
// カーソル・グリッド位置を保持できるため、@wterm に書き込めば TUI を忠実に描画できる。

export interface RenderStyle {
  id: number
  foreground: string
  background: string
  bold: boolean
  faint: boolean
  italic: boolean
  underline: boolean
  blink: boolean
  inverse: boolean
  strikethrough: boolean
  overline: boolean
  invisible: boolean
}

export interface RowSpan {
  row: number
  column: number
  style_id: number
  cell_width: number
  text: string
}

export interface GridCursor {
  row: number
  column: number
  visible: boolean
  style?: string
  blinking?: boolean
}

export interface TerminalMode {
  code: number
  ansi: boolean
  on: boolean
}

export interface RenderGrid {
  columns: number
  rows: number
  styles: RenderStyle[]
  row_spans: RowSpan[]
  cursor?: GridCursor
  active_screen?: string
  modes?: TerminalMode[]
}

const ESC = '\x1b'

// "#RRGGBB" → [r, g, b]。不正値は黒にフォールバックする。
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
  if (!m || m[1] === undefined) return [0, 0, 0]
  const n = Number.parseInt(m[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

// 1 span 分の SGR（必ず先頭で 0 リセットしてから属性を積む）。
function sgrFor(style: RenderStyle | undefined): string {
  const codes: number[] = [0]
  if (style) {
    if (style.bold) codes.push(1)
    if (style.faint) codes.push(2)
    if (style.italic) codes.push(3)
    if (style.underline) codes.push(4)
    if (style.blink) codes.push(5)
    if (style.inverse) codes.push(7)
    if (style.invisible) codes.push(8)
    if (style.strikethrough) codes.push(9)
    if (style.overline) codes.push(53)
    const [fr, fg, fb] = hexToRgb(style.foreground)
    codes.push(38, 2, fr, fg, fb)
    const [br, bg, bb] = hexToRgb(style.background)
    codes.push(48, 2, br, bg, bb)
  }
  return `${ESC}[${codes.join(';')}m`
}

export function renderGridToAnsi(grid: RenderGrid): string {
  const styleById = new Map<number, RenderStyle>()
  for (const s of grid.styles) styleById.set(s.id, s)

  // [2J=可視画面消去, [3J=wterm wasm 内部スクロールバック消去, [H=カーソル原点。
  // [3J を毎フレーム発行することで、ライブポール毎に scrollback が積み増しされ
  // (1) タブ切替で旧サーフェスの過去フレームが透ける、(2) scrollHeight が伸び続けて
  // 最下部に追いつけなくなる、の両不具合を断つ。grid モードでは scrollback は
  // 使わない(履歴は wterm 外の <pre> に readText 経由で描画する)ため副作用なし。
  const parts: string[] = [`${ESC}[2J${ESC}[3J${ESC}[H`]

  // 行ごとに span をまとめ、行頭から「隙間を空白で埋めつつ」連続描画する。span を絶対位置(ESC[colH)で
  // 置くと、wterm コアの CJK セル勘定(width=1)が cmux(全角=2)と食い違い、cmux が全角の「2セル目(継続
  // セル)」とみなすセルが wterm 側で空セル=余分な空白になって隔間ズレが出る。連続描画なら絶対位置に
  // 依存せず、span 間は cmux の列差分(cell_width 込み)の空白で埋まるので cmux と一致する。
  const byRow = new Map<number, RowSpan[]>()
  for (const span of grid.row_spans) {
    const arr = byRow.get(span.row)
    if (arr) arr.push(span)
    else byRow.set(span.row, [span])
  }
  for (const [row, spans] of byRow) {
    spans.sort((a, b) => a.column - b.column)
    parts.push(`${ESC}[${row + 1};1H`)
    let col = 0
    for (const span of spans) {
      // 先頭/前の span との隙間は既定スタイルの空白で詰める（重なり時は span が後勝ちで上書き）。
      if (span.column > col) parts.push(`${ESC}[0m${' '.repeat(span.column - col)}`)
      parts.push(sgrFor(styleById.get(span.style_id)))
      parts.push(span.text)
      col = Math.max(col, span.column + span.cell_width)
    }
  }
  parts.push(`${ESC}[0m`)

  const cur = grid.cursor
  if (cur) {
    parts.push(`${ESC}[${cur.row + 1};${cur.column + 1}H`)
    parts.push(cur.visible ? `${ESC}[?25h` : `${ESC}[?25l`)
  }
  return parts.join('')
}
