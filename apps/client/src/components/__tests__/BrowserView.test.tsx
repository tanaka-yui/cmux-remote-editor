// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BrowserView } from '../BrowserView'

describe('BrowserView', () => {
  afterEach(cleanup)

  it('iframe は描画しない', () => {
    const { container } = render(<BrowserView url="https://example.com/" title="Example Domain" />)
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('「新しいタブで開く」リンクの href が url と一致する', () => {
    render(<BrowserView url="https://example.com/" title="Example Domain" />)
    const link = screen.getByRole('link', { name: /新しいタブで開く/ })
    expect(link.getAttribute('href')).toBe('https://example.com/')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('title と url を表示する', () => {
    render(<BrowserView url="https://example.com/" title="Example Domain" />)
    expect(screen.getByText('Example Domain')).toBeTruthy()
    expect(screen.getByText('https://example.com/')).toBeTruthy()
  })

  it('url が空ならリンクを描画せず代替表示する', () => {
    render(<BrowserView url="" title="空タブ" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('URL を取得できませんでした')).toBeTruthy()
  })
})
