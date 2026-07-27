// ライブ表示に常時併記するスクロールバック（履歴）の seam 処理。
//
// 実機プローブで確定した cmux ソケットの仕様（docs/superpowers/plans/2026-07-27-modeless-scrollback.md）:
// - surface.read_text { scrollback: true, lines: N } は「履歴 + 現在の可視画面」を連結した
//   テキストの末尾 N 行を返す（可視画面は必ず末尾に含まれる）。
// - テキストの末尾空行はソケット側でトリム済みのため、可視画面ぶんの行数は grid.rows でなく
//   「render_grid の最終非空行 + 1」と一致する（rows で削ると下部が空の端末で履歴を削りすぎる）。
import type { RenderGrid } from './render-grid'

// render_grid の「内容がある最終行 + 1」= read_text が画面ぶんとして返す行数。内容が無ければ 0。
export function visibleLineCount(grid: RenderGrid): number {
  let last = -1
  for (const span of grid.row_spans) {
    if (span.row > last && span.text.trim() !== '') last = span.row
  }
  return last + 1
}

// scrollback テキストから末尾の可視画面ぶん（visibleLines 行）を削り、履歴のみを返す。
// 下に色付きグリッド（可視画面）を併記するため、削らないと画面が二重に見える。
export function stripVisibleScreen(text: string, visibleLines: number): string {
  if (text === '') return ''
  const lines = text.split('\n')
  // 末尾の空行を除いてから削る（ソケット側でトリム済みのはずだが保険）。
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end--
  const cut = Math.max(0, end - visibleLines)
  return lines.slice(0, cut).join('\n')
}
