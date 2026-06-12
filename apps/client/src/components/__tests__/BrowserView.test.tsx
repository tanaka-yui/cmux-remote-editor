// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BrowserView } from '../BrowserView'

const noop = () => {}

describe('BrowserView', () => {
  afterEach(cleanup)

  it('url を iframe の src に反映する', () => {
    const { container } = render(<BrowserView url="https://example.com/" title="Example Domain" gestureRef={noop} />)
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('src')).toBe('https://example.com/')
  })

  it('「新しいタブで開く」リンクの href が url と一致する', () => {
    render(<BrowserView url="https://example.com/" title="Example Domain" gestureRef={noop} />)
    const link = screen.getByRole('link', { name: /新しいタブで開く/ })
    expect(link.getAttribute('href')).toBe('https://example.com/')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('title を表示する', () => {
    render(<BrowserView url="https://example.com/" title="Example Domain" gestureRef={noop} />)
    expect(screen.getByText('Example Domain')).toBeTruthy()
  })

  it('url が空なら iframe を描画せず代替表示する', () => {
    const { container } = render(<BrowserView url="" title="空タブ" gestureRef={noop} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByText('URL を取得できませんでした')).toBeTruthy()
  })
})
