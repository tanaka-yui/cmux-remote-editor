import { describe, expect, it } from 'vitest'

import type { RenderGrid } from '../render-grid'
import { stripVisibleScreen, visibleLineCount } from '../scrollback'

// row ごとのテキストだけ指定して RenderGrid を作るヘルパ（他フィールドは判定に関与しない）。
function gridWith(spans: { row: number; text: string }[]): RenderGrid {
  return {
    columns: 80,
    rows: 24,
    styles: [],
    row_spans: spans.map((s) => ({ row: s.row, column: 0, style_id: 0, cell_width: s.text.length, text: s.text })),
  }
}

describe('visibleLineCount', () => {
  it('span が無い空グリッドは 0', () => {
    expect(visibleLineCount(gridWith([]))).toBe(0)
  })

  it('内容の最終行+1 を返す（rows=24 でも下部が空なら小さくなる）', () => {
    // read_text は末尾空行をトリムするため、画面ぶんの行数は rows でなく「最終非空行+1」。
    expect(
      visibleLineCount(
        gridWith([
          { row: 0, text: 'a' },
          { row: 16, text: 'status' },
        ]),
      ),
    ).toBe(17)
  })

  it('空白のみの span は内容行とみなさない', () => {
    expect(
      visibleLineCount(
        gridWith([
          { row: 2, text: 'x' },
          { row: 10, text: '   ' },
        ]),
      ),
    ).toBe(3)
  })

  it('span の順序に依存しない', () => {
    expect(
      visibleLineCount(
        gridWith([
          { row: 5, text: 'b' },
          { row: 1, text: 'a' },
        ]),
      ),
    ).toBe(6)
  })
})

describe('stripVisibleScreen', () => {
  it('末尾の可視画面ぶんを削り履歴のみ返す', () => {
    expect(stripVisibleScreen('h1\nh2\ns1\ns2\ns3', 3)).toBe('h1\nh2')
  })

  it('全行が画面（履歴なし）なら空文字', () => {
    expect(stripVisibleScreen('s1\ns2', 2)).toBe('')
  })

  it('行数が visibleLines 未満でも空文字（負にならない）', () => {
    expect(stripVisibleScreen('s1', 5)).toBe('')
  })

  it('末尾に空行があっても画面ぶんを正しく削る（ソケットはトリム済みだが保険）', () => {
    expect(stripVisibleScreen('h1\ns1\ns2\n\n', 2)).toBe('h1')
  })

  it('visibleLines=0 は末尾空行だけ落とした全文を返す', () => {
    expect(stripVisibleScreen('h1\nh2\n', 0)).toBe('h1\nh2')
  })

  it('空文字は空文字のまま', () => {
    expect(stripVisibleScreen('', 3)).toBe('')
  })
})
