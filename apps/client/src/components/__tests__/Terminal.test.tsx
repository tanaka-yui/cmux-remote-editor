// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import type { CSSProperties } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderGrid } from '../../lib/render-grid'

// @wterm/react をモックし、ルート要素 (.wterm) へ渡る style prop を捕捉する。
// 実機の横スクロールは jsdom がレイアウトを計算しない（scrollWidth=0）ため検証不能。
// ここでは「grid モードで .wterm を内容幅に広げる」配線だけを回帰ガードする —
// この幅指定が無いと .wterm(overflow:hidden) が wrapper 幅に張り付き、横パンが死に
// scrollWidth から導く cellWidth が過小になってタップが別セルへ着弾する。
const { wtermProps } = vi.hoisted(() => ({
  wtermProps: { current: {} as Record<string, unknown> },
}))

vi.mock('@wterm/react', () => ({
  useTerminal: () => ({ ref: { current: null }, write: () => {} }),
  Terminal: (props: Record<string, unknown>) => {
    wtermProps.current = props
    return null
  },
}))

import { Terminal } from '../Terminal'

const grid: RenderGrid = {
  columns: 120,
  rows: 40,
  styles: [],
  row_spans: [],
}

const baseProps = {
  content: '',
  fontSize: 14,
  mouseEnabled: false,
  useSgr: false,
  onSendMouse: () => {},
  onAdjustFontSize: () => {},
}

describe('Terminal width sizing', () => {
  it('grid モードでは幅を max(100%, 実測 px) にし、未計測時はコンテナ(100%)を満たす', () => {
    render(<Terminal grid={grid} {...baseProps} />)
    const style = wtermProps.current.style as CSSProperties
    // 幅はコンテナ(100%=pane)を満たしつつ、実コンテンツ(末尾空白除外の実測)が超えたら広げる。
    // jsdom はレイアウト非計算で計測 0 → 100% フォールバックの配線を回帰ガードする。
    expect(style.width).toBe('max(100%, 0px)')
  })

  it('プレーンテキスト(履歴)モードでは幅を固定せずコンテナに合わせる', () => {
    render(<Terminal grid={null} {...baseProps} content="hello" />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.width).toBeUndefined()
  })
})

describe('Terminal tap handling', () => {
  afterEach(cleanup)

  // jsdom はレイアウト非計算のため着弾セルは検証できないが、合成 click の抑止
  // (preventDefault) は検証できる。これが無いと wterm が画面外 textarea を focus() し、
  // 仮想キーボードが出てパン位置も左端へ戻る。fireEvent は default 抑止時に false を返す。
  it('一本指タップは合成 click(仮想キーボード)を抑止しつつ左クリックを送る', () => {
    const onSendMouse = vi.fn()
    const { container } = render(<Terminal grid={grid} {...baseProps} mouseEnabled useSgr onSendMouse={onSendMouse} />)
    const wrapper = container.firstChild as HTMLElement
    fireEvent.touchStart(wrapper, { touches: [{ clientX: 20, clientY: 20 }] })
    const notPrevented = fireEvent.touchEnd(wrapper, {
      touches: [],
      changedTouches: [{ clientX: 20, clientY: 20 }],
    })
    expect(notPrevented).toBe(false)
    expect(onSendMouse).toHaveBeenCalledTimes(1)
  })

  it('マウスモード無効でもタップは合成 click を抑止する(無機能なキーボードを出さない)', () => {
    const onSendMouse = vi.fn()
    const { container } = render(<Terminal grid={grid} {...baseProps} onSendMouse={onSendMouse} />)
    const wrapper = container.firstChild as HTMLElement
    fireEvent.touchStart(wrapper, { touches: [{ clientX: 20, clientY: 20 }] })
    const notPrevented = fireEvent.touchEnd(wrapper, {
      touches: [],
      changedTouches: [{ clientX: 20, clientY: 20 }],
    })
    expect(notPrevented).toBe(false)
    expect(onSendMouse).not.toHaveBeenCalled()
  })

  // 一本指ドラッグはネイティブスクロール。閾値超えの移動があれば click は送らず、default も
  // 抑止しない（preventDefault するとスクロール慣性が止まるため）。fireEvent は非抑止時 true を返す。
  it('一本指ドラッグ(スクロール)は click を送らず default も抑止しない', () => {
    const onSendMouse = vi.fn()
    const { container } = render(<Terminal grid={grid} {...baseProps} mouseEnabled useSgr onSendMouse={onSendMouse} />)
    const wrapper = container.firstChild as HTMLElement
    fireEvent.touchStart(wrapper, { touches: [{ clientX: 20, clientY: 20 }] })
    fireEvent.touchMove(wrapper, { touches: [{ clientX: 20, clientY: 90 }] })
    const notPrevented = fireEvent.touchEnd(wrapper, {
      touches: [],
      changedTouches: [{ clientX: 20, clientY: 90 }],
    })
    expect(notPrevented).toBe(true)
    expect(onSendMouse).not.toHaveBeenCalled()
  })
})
