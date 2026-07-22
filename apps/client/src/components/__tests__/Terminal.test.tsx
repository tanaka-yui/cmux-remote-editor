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
  onEnterHistory: () => {},
  onExitHistory: () => {},
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

  it('grid が undefined（停止端末で replay が空）でも落ちず、プレーンテキスト扱いにする', () => {
    // render_grid 欠落で grid が undefined になっても null と同様「グリッド無し」に扱う。
    // `grid !== null` の厳密比較だと undefined がすり抜け cols={grid.columns} で落ちる回帰を防ぐ。
    // 型は RenderGrid | null だが、実機では undefined が混入し得るためキャストで再現する。
    const undefinedGrid = undefined as unknown as RenderGrid | null
    render(<Terminal grid={undefinedGrid} {...baseProps} content="hello" />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.width).toBeUndefined()
  })
})

describe('Terminal history→live scroll', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  // 履歴(grid=null)→ライブ(grid)復帰時、wrapper を最下部へ戻して最新行を見せる。これが無いと
  // 履歴中 scrollTop=0 のまま grid(viewport より高い)が描かれ、最新のやりとりが下に隠れる。
  // jsdom はレイアウト非計算なので scrollTop/scrollHeight を定義して「最下部代入」の配線を回帰ガード。
  it('履歴→ライブ復帰で wrapper を最下部(scrollHeight)へスクロールする', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { container, rerender } = render(<Terminal grid={null} {...baseProps} content="old" />)
    const wrapper = container.firstChild as HTMLElement
    let scrollTopVal = 0
    Object.defineProperty(wrapper, 'scrollTop', {
      configurable: true,
      get: () => scrollTopVal,
      set: (v: number) => {
        scrollTopVal = v
      },
    })
    Object.defineProperty(wrapper, 'scrollHeight', { configurable: true, get: () => 1000 })
    rerender(<Terminal grid={grid} {...baseProps} />)
    expect(wrapper.scrollTop).toBe(1000)
  })

  // 立ち上がりの一回だけ。ライブ継続中(grid→grid)は動かさない(動かすと上スクロールでの履歴進入が不能)。
  it('ライブ継続中(grid→grid)は最下部へ戻さない', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { container, rerender } = render(<Terminal grid={grid} {...baseProps} />)
    const wrapper = container.firstChild as HTMLElement
    let scrollTopVal = 123
    Object.defineProperty(wrapper, 'scrollTop', {
      configurable: true,
      get: () => scrollTopVal,
      set: (v: number) => {
        scrollTopVal = v
      },
    })
    Object.defineProperty(wrapper, 'scrollHeight', { configurable: true, get: () => 1000 })
    rerender(<Terminal grid={{ ...grid, rows: 41 }} {...baseProps} />)
    expect(wrapper.scrollTop).toBe(123)
  })
})

describe('Terminal history rendering', () => {
  afterEach(cleanup)

  // 履歴(grid=null)は wterm でなく <pre> に全行を直描画する。wterm の WASM コアは
  // スクロールバックを 1000 行でハードコード頭打ちにする(変更 API なし)ため、wterm に
  // 書き込むと historyLines を 1000 超に上げても遡れる範囲が変わらない（本バグの根本原因）。
  it('プレーンテキストは pre に全行描画される（1000 行超も欠けない）', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}`)
    const { container } = render(<Terminal grid={null} {...baseProps} content={lines.join('\n')} />)
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('line-0')
    expect(pre?.textContent).toContain('line-2999')
  })

  it('履歴中は wterm を display:none で隠す', () => {
    render(<Terminal grid={null} {...baseProps} content="hello" />)
    const style = wtermProps.current.style as CSSProperties
    expect(style.display).toBe('none')
  })

  it('ライブ(grid)中は pre を描画せず wterm を表示する', () => {
    const { container } = render(<Terminal grid={grid} {...baseProps} />)
    expect(container.querySelector('pre')).toBeNull()
    const style = wtermProps.current.style as CSSProperties
    expect(style.display).not.toBe('none')
  })

  // 進入直後に最新(末尾)を見せる。従来は wterm の書込み後末尾追従に頼っていたが、
  // pre 直描画では自前で wrapper を最下部へスクロールする必要がある。
  it('履歴進入時に wrapper を最下部(scrollHeight)へスクロールする', () => {
    const { container, rerender } = render(<Terminal grid={grid} {...baseProps} />)
    const wrapper = container.firstChild as HTMLElement
    let scrollTopVal = 0
    Object.defineProperty(wrapper, 'scrollTop', {
      configurable: true,
      get: () => scrollTopVal,
      set: (v: number) => {
        scrollTopVal = v
      },
    })
    Object.defineProperty(wrapper, 'scrollHeight', { configurable: true, get: () => 5000 })
    rerender(<Terminal grid={null} {...baseProps} content="history" />)
    expect(wrapper.scrollTop).toBe(5000)
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
