import { describe, expect, it } from 'vitest'

import { type RenderGrid, type RenderStyle, renderGridToAnsi } from '../render-grid'

// デフォルトスタイル（id 指定 + 上書きのみ）を組むヘルパ。
function style(id: number, over: Partial<RenderStyle> = {}): RenderStyle {
  return {
    id,
    foreground: '#FFFFFF',
    background: '#1E1E1E',
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    blink: false,
    inverse: false,
    strikethrough: false,
    overline: false,
    invisible: false,
    ...over,
  }
}

function grid(over: Partial<RenderGrid>): RenderGrid {
  return { columns: 10, rows: 2, styles: [], row_spans: [], ...over }
}

describe('renderGridToAnsi', () => {
  it('先頭で画面全消去 + スクロールバック消去 + ホームを発行する', () => {
    // [3J を含めて wterm の wasm 内部スクロールバックを毎フレーム空にする。これが無いと
    // ライブポール毎に旧フレームが scrollback に積まれ、(1) タブ切替で wterm インスタンスを
    // 共有しているため別タブの過去フレームが見える、(2) scrollHeight が増え続けて
    // 「一番下」が下に逃げ続けてスクロールが追いつかなくなる、の 2 つの不具合になる。
    expect(renderGridToAnsi(grid({}))).toBe('\x1b[2J\x1b[3J\x1b[H\x1b[0m')
  })

  it('行ごとに連続描画し、先頭/span 間の隙間を既定スタイルの空白で埋める', () => {
    const ansi = renderGridToAnsi(
      grid({
        styles: [style(0)],
        row_spans: [
          { row: 0, column: 2, style_id: 0, cell_width: 2, text: 'hi' },
          { row: 0, column: 6, style_id: 0, cell_width: 2, text: 'yo' },
        ],
        cursor: { row: 0, column: 0, visible: false },
      }),
    )
    // row0 を ESC[1;1H で開始 → 先頭2列の空白 → 'hi'(col2..3) → col4..5 の隙間2空白 → 'yo'。
    // #FFFFFF=255;255;255、#1E1E1E=30;30;30。
    const sgr = '\x1b[0;38;2;255;255;255;48;2;30;30;30m'
    expect(ansi).toContain(`\x1b[1;1H\x1b[0m  ${sgr}hi\x1b[0m  ${sgr}yo`)
  })

  it('bold/italic/underline/inverse を SGR コードに変換する', () => {
    const ansi = renderGridToAnsi(
      grid({
        styles: [style(0, { bold: true, italic: true, underline: true, inverse: true })],
        row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 1, text: 'X' }],
      }),
    )
    expect(ansi).toContain('\x1b[0;1;3;4;7;38;2;255;255;255;48;2;30;30;30mX')
  })

  it('未知の style_id は reset のみで描く（クラッシュしない）', () => {
    const ansi = renderGridToAnsi(
      grid({ styles: [], row_spans: [{ row: 1, column: 0, style_id: 99, cell_width: 1, text: 'x' }] }),
    )
    expect(ansi).toContain('\x1b[2;1H\x1b[0mx')
  })

  it('カーソルが可視なら ?25h、不可視なら ?25l を末尾に発行する', () => {
    const visible = renderGridToAnsi(grid({ cursor: { row: 3, column: 4, visible: true } }))
    expect(visible).toContain('\x1b[4;5H\x1b[?25h')
    const hidden = renderGridToAnsi(grid({ cursor: { row: 0, column: 0, visible: false } }))
    expect(hidden).toContain('\x1b[?25l')
  })

  it('全角(CJK)テキストをそのまま保持する', () => {
    const ansi = renderGridToAnsi(
      grid({ styles: [style(0)], row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 4, text: '日本' }] }),
    )
    expect(ansi).toContain('日本')
  })
})
