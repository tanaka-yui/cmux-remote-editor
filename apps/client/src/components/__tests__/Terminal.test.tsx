// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import type { CSSProperties } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderGrid } from '../../lib/render-grid'

// @wterm/react をモックし、ルート要素 (.wterm) へ渡る style prop を捕捉する。
// 実機の横スクロールは jsdom がレイアウトを計算しない（scrollWidth=0）ため検証不能。
// 実装はタップ座標の基準に .wterm を querySelector するため、モックもクラス付き要素を実 DOM に出す。
const { wtermProps } = vi.hoisted(() => ({
  wtermProps: { current: {} as Record<string, unknown> },
}))

vi.mock('@wterm/react', () => ({
  useTerminal: () => ({ ref: { current: null }, write: () => {} }),
  Terminal: (props: Record<string, unknown>) => {
    wtermProps.current = props
    return <div className="wterm" style={props.style as CSSProperties} />
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
  scrollback: '',
  fontSize: 14,
  mouseEnabled: false,
  useSgr: false,
  onSendMouse: () => {},
  onAdjustFontSize: () => {},
  onPinnedChange: () => {},
  resetKey: 'surface:1',
}

// jsdom はレイアウト非計算のため、スクロール寸法を明示定義して「代入の配線」を回帰ガードする。
function defineScrollMetrics(
  el: HTMLElement,
  init: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {},
) {
  let scrollTopVal = init.scrollTop ?? 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTopVal,
    set: (v: number) => {
      scrollTopVal = v
    },
  })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => init.scrollHeight ?? 1000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => init.clientHeight ?? 100 })
}

// jsdom の getBoundingClientRect は全て 0 を返すため、.wterm の rect を明示して
// 「タップが grid 領域の内/外」の判定を再現する。
function stubWtermRect(container: HTMLElement, rect: { left: number; top: number; right: number; bottom: number }) {
  const el = container.querySelector<HTMLElement>('.wterm')
  if (!el) throw new Error('wterm not found')
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect
}

describe('Terminal width sizing', () => {
  afterEach(cleanup)

  it('grid モードでは幅を max(100%, 実測 px) にし、未計測時はコンテナ(100%)を満たす', () => {
    render(<Terminal grid={grid} {...baseProps} />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.width).toBe('max(100%, 0px)')
  })

  it('grid なし(プレーンテキストのみ)では幅を固定せずコンテナに合わせる', () => {
    render(<Terminal grid={null} {...baseProps} scrollback="hello" />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.width).toBeUndefined()
  })

  it('grid が undefined（停止端末で replay が空）でも落ちず、グリッド無し扱いにする', () => {
    // 型は RenderGrid | null だが、実機では undefined が混入し得るためキャストで再現する。
    const undefinedGrid = undefined as unknown as RenderGrid | null
    render(<Terminal grid={undefinedGrid} {...baseProps} scrollback="hello" />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.width).toBeUndefined()
  })
})

describe('Terminal scrollback rendering', () => {
  afterEach(cleanup)

  // モードレスの核: ライブ(grid)中も scrollback が pre として「上に」常時併記される。
  it('ライブ(grid)中も scrollback を pre で wterm の上に併記する', () => {
    const { container } = render(<Terminal grid={grid} {...baseProps} scrollback={'h1\nh2'} />)
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('h1')
    // wterm(色付きライブ)は隠されない
    const style = wtermProps.current.style as CSSProperties
    expect(style.display).not.toBe('none')
    // pre は wterm より前(上)
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.firstElementChild?.tagName).toBe('PRE')
  })

  it('scrollback が空なら pre を描画しない', () => {
    const { container } = render(<Terminal grid={grid} {...baseProps} />)
    expect(container.querySelector('pre')).toBeNull()
  })

  // wterm の WASM スクロールバックは 1000 行でハードコード頭打ちのため、プレーンテキストは
  // wterm に流さず pre へ全行直描画する（historyLines>1000 でも欠けない）。
  it('grid なしでは wterm を隠し scrollback 全文を pre に描画する（1000 行超も欠けない）', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}`)
    const { container } = render(<Terminal grid={null} {...baseProps} scrollback={lines.join('\n')} />)
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toContain('line-0')
    expect(pre?.textContent).toContain('line-2999')
    const style = wtermProps.current.style as CSSProperties
    expect(style.display).toBe('none')
  })
})

describe('Terminal pinned follow', () => {
  afterEach(cleanup)

  it('ピン留め中(既定)は内容更新で最下部(scrollHeight)へ追従する', () => {
    const { container, rerender } = render(<Terminal grid={grid} {...baseProps} scrollback="a" />)
    const wrapper = container.firstChild as HTMLElement
    defineScrollMetrics(wrapper)
    rerender(<Terminal grid={grid} {...baseProps} scrollback={'a\nb'} />)
    expect(wrapper.scrollTop).toBe(1000)
  })

  it('上へスクロールすると onPinnedChange(false)、以後の内容更新では scrollTop を触らない(据え置き)', () => {
    const onPinnedChange = vi.fn()
    const { container, rerender } = render(
      <Terminal grid={grid} {...baseProps} scrollback="a" onPinnedChange={onPinnedChange} />,
    )
    const wrapper = container.firstChild as HTMLElement
    defineScrollMetrics(wrapper, { scrollTop: 500 })
    fireEvent.scroll(wrapper)
    expect(onPinnedChange).toHaveBeenLastCalledWith(false)
    rerender(<Terminal grid={grid} {...baseProps} scrollback={'a\nb'} onPinnedChange={onPinnedChange} />)
    expect(wrapper.scrollTop).toBe(500)
  })

  it('最下部へ戻ると onPinnedChange(true) を通知する', () => {
    const onPinnedChange = vi.fn()
    const { container } = render(<Terminal grid={grid} {...baseProps} scrollback="a" onPinnedChange={onPinnedChange} />)
    const wrapper = container.firstChild as HTMLElement
    defineScrollMetrics(wrapper, { scrollTop: 500 })
    fireEvent.scroll(wrapper)
    // scrollHeight(1000) - (900 + clientHeight(100)) = 0 <= epsilon → 最下部
    wrapper.scrollTop = 900
    fireEvent.scroll(wrapper)
    expect(onPinnedChange).toHaveBeenLastCalledWith(true)
  })

  it('resetKey 変化(サーフェス切替)でピン留めへ戻し最下部へスクロールする', () => {
    const { container, rerender } = render(<Terminal grid={grid} {...baseProps} scrollback="a" />)
    const wrapper = container.firstChild as HTMLElement
    defineScrollMetrics(wrapper, { scrollTop: 500 })
    fireEvent.scroll(wrapper) // ピン解除
    rerender(<Terminal grid={grid} {...baseProps} scrollback="b" resetKey="surface:2" />)
    expect(wrapper.scrollTop).toBe(1000)
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
    stubWtermRect(container, { left: 0, top: 0, right: 200, bottom: 200 })
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

  // pre(履歴)領域のタップを弾く回帰ガード。pixelToCell は範囲外を clamp するため、bounds 判定が
  // 無いと履歴上のタップが row=1 の左クリックとしてライブ端末へ誤送信される。
  it('pre(履歴)領域のタップはクリックを送らない(グリッド rect 外は無視)', () => {
    const onSendMouse = vi.fn()
    const { container } = render(
      <Terminal grid={grid} {...baseProps} scrollback={'h1\nh2'} mouseEnabled useSgr onSendMouse={onSendMouse} />,
    )
    // wterm は pre の下(タップ位置 y=20 より下)にある想定の rect
    stubWtermRect(container, { left: 0, top: 100, right: 200, bottom: 300 })
    const wrapper = container.firstChild as HTMLElement
    fireEvent.touchStart(wrapper, { touches: [{ clientX: 20, clientY: 20 }] })
    const notPrevented = fireEvent.touchEnd(wrapper, {
      touches: [],
      changedTouches: [{ clientX: 20, clientY: 20 }],
    })
    expect(notPrevented).toBe(false)
    expect(onSendMouse).not.toHaveBeenCalled()
  })
})
