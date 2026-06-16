// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '../ErrorBoundary'

afterEach(cleanup)

// crashKey が 'bad' のときだけ投げる子。停止端末での描画クラッシュ→別タブ切替での復帰を模す。
function Boom({ crashKey }: { crashKey: string }) {
  if (crashKey === 'bad') throw new Error('boom')
  return <div>ok: {crashKey}</div>
}

describe('ErrorBoundary（コンテンツ領域・inline）', () => {
  it('描画例外を捕捉してコンテンツ用の文言を出す', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getByText } = render(
      <ErrorBoundary inline resetKey="bad">
        <Boom crashKey="bad" />
      </ErrorBoundary>,
    )
    expect(getByText('このタブの表示でエラーが発生しました')).toBeTruthy()
    errSpy.mockRestore()
  })

  it('resetKey が変わると（別タブへ切替）エラーを解除し、健全な子を再描画する', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender, queryByText, getByText } = render(
      <ErrorBoundary inline resetKey="bad">
        <Boom crashKey="bad" />
      </ErrorBoundary>,
    )
    expect(getByText('このタブの表示でエラーが発生しました')).toBeTruthy()

    // 別 surface へ切替（resetKey 変化）→ 子の再マウント無しでエラー解除、健全な内容が出る。
    rerender(
      <ErrorBoundary inline resetKey="good">
        <Boom crashKey="good" />
      </ErrorBoundary>,
    )
    expect(queryByText('このタブの表示でエラーが発生しました')).toBeNull()
    expect(getByText('ok: good')).toBeTruthy()
    errSpy.mockRestore()
  })
})
