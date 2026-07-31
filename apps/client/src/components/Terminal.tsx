import { useTerminal, Terminal as WTerminal } from '@wterm/react'
import type { CSSProperties, TouchEvent as ReactTouchEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '@wterm/react/css'
import { centroid, isTap, touchDistance } from '../lib/multitouch'
import { type RenderGrid, renderGridToAnsi } from '../lib/render-grid'
import { isAtBottom } from '../lib/scroll-intent'
import { encodeClick } from '../lib/sgr-mouse'
import { cellSize, pixelToCell } from '../lib/terminal-coords'

interface TerminalProps {
  // ライブ表示用の描画グリッド。null のとき scrollback(プレーンテキスト)のみを描く。
  grid: RenderGrid | null
  // グリッドの上へ常時併記するスクロールバック(履歴・プレーンテキスト、seam 除去済み)。
  // grid=null(停止端末/オフライン)のときは画面込みの全文が渡る。空文字なら描画しない。
  scrollback: string
  fontSize: number
  // マウス送信（render_grid.modes から App が導出）。
  mouseEnabled: boolean
  useSgr: boolean
  onSendMouse: (text: string) => void
  // 二本指ピンチでのフォントサイズ増減（+1 = 拡大 / -1 = 縮小）。
  onAdjustFontSize: (delta: number) => void
  // 最下部ピン留め状態の変化通知。App が scrollback フェッチの可否（据え置き）に使う。
  onPinnedChange: (pinned: boolean) => void
  // サーフェス切替でピン留め＋最下部へリセットするためのキー。
  resetKey: string | null
}

// スクロールバックの <pre> 描画用整形。末尾空白を落として横幅の無駄な肥大
// （read_text は行を cols 幅まで空白で埋める）を防ぐ。行頭インデントは保持する。
function cleanScreen(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
}

const PADDING = 8
// Latin/CJK の両方をこの 2:1 等幅フォントで描き、全角を確実に 2×Latin にする(セル=cmux と一致)。
// 未ロード時のフォールバックに Menlo 系を残す。wterm(--term-font-family)とスクロールバックの <pre> で共用する。
const TERM_FONT_FAMILY = "'M PLUS 1 Code', Menlo, Consolas, 'DejaVu Sans Mono', 'Courier New', monospace"
// ピンチでフォントを 1 段変えるのに必要な指間距離の変化（px）。
const PINCH_STEP_PX = 32

// アクティブなタッチジェスチャーの状態。スクロールはブラウザのネイティブに任せ、ここでは
// タップ/ピンチ/右クリックだけを判定する。閾値を超えて動いた or ピンチした場合は moved=true で、
// touchend のクリック（タップ）送信を抑止する。
type GestureState =
  | { kind: 'single'; startX: number; startY: number; moved: boolean }
  | { kind: 'double'; centerX: number; centerY: number; lastDistance: number; zoomAccum: number; moved: boolean }

export function Terminal({
  grid,
  scrollback,
  fontSize,
  mouseEnabled,
  useSgr,
  onSendMouse,
  onAdjustFontSize,
  onPinnedChange,
  resetKey,
}: TerminalProps) {
  const { ref, write } = useTerminal()
  const gridRef = useRef<RenderGrid | null>(null)
  const readyRef = useRef(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // grid モードの横幅に使う実測コンテンツ幅(px)。0 のうちは下の termStyle が cols*ch フォールバック。
  const [measuredWidth, setMeasuredWidth] = useState(0)

  // wterm に書くのは grid のみ。プレーンテキスト(スクロールバック/オフライン)は wterm の WASM
  // スクロールバックが 1000 行でハードコード頭打ち(変更 API なし)のため wterm に流さず、
  // <pre> に全行を直描画する。これが無いと設定の履歴バッファ(historyLines)を 1000 超に
  // 上げても遡れる範囲が変わらない。
  const repaint = useCallback(
    (g: RenderGrid | null) => {
      if (g) write(renderGridToAnsi(g))
    },
    [write],
  )

  useEffect(() => {
    gridRef.current = grid
    if (readyRef.current) repaint(grid)
  }, [grid, repaint])

  const onReady = useCallback(() => {
    readyRef.current = true
    // wterm は click で画面外(left:-9999px)の textarea を focus() する。本ビューアは onData を捨てる
    // ためキーボード入力は無機能で、focus は (1) モバイル仮想キーボード表示 (2) その textarea を見せ
    // ようと wrapper を左端へスクロールさせる、という害しか生まない。textarea を disabled にして
    // フォーカス自体を無効化し、合成 click が漏れても副作用を断つ。
    const textarea = wrapperRef.current?.querySelector('textarea')
    if (textarea) textarea.disabled = true
    repaint(gridRef.current)
  }, [repaint])

  // grid モードの実コンテンツ幅を計測する。wterm は通常文字をセル幅非固定の素 span で描くため
  // 全角(日本語/絵文字)を含む行は cols*ch を超える。行コンテナ .term-grid の scrollWidth が(制約幅
  // より広い)実最長行幅を反映するのでそれを採る。grow-only(既存以下は無視)にして、wterm が再描画で
  // grid DOM を一瞬空にするフレームや縮小フレームでも明示幅を絶対に潰さない=左へ飛ぶチラつきを断つ。
  const measure = useCallback(() => {
    // grid モード時のみ。プレーンテキスト(grid=null)は termStyle が width を付けず measuredWidth を
    // 使わないので、長いスクロールバック行で値を肥大(=grid 復帰時の過剰確保)させないよう測らない。
    if (!gridRef.current) return
    const gridEl = wrapperRef.current?.querySelector('.term-grid')
    if (!gridEl) return
    // 寸法変化直後の「空行だけ(setup の innerHTML='' 後)」フレームは無視する — 空行は span を持たない。
    // これを測ると幅が誤って潰れ/膨らみ、scrollLeft が左へ飛ぶ(チラつき)。
    if (!gridEl.querySelector('.term-row > span')) return
    // 実コンテンツ幅 = 「末尾空白を除いた最右の文字位置」。端末は行を cols 幅まで空白で埋めるため、行全体や
    // .term-grid を測ると「内容より右の空セル」まで含め、grid が pane より広いと右に余白/横スクロールが出る。
    // 各テキストノードで末尾空白を除いた Range の right を取り、その最大を content 幅とする(全角は実ジオメトリ
    // で正しく反映)。Range はコンテナ幅に依存しないのでフィードバックも無い。allow-shrink で現在画面にフィット。
    const gridLeft = gridEl.getBoundingClientRect().left
    const range = document.createRange()
    const walker = document.createTreeWalker(gridEl, NodeFilter.SHOW_TEXT)
    let maxRight = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const end = (node.nodeValue ?? '').replace(/\s+$/, '').length
      if (end === 0) continue
      range.setStart(node, 0)
      range.setEnd(node, end)
      const right = range.getBoundingClientRect().right
      if (right > maxRight) maxRight = right
    }
    if (maxRight === 0) return
    // .wterm は border-box。コンテンツ幅に padding(2*PADDING) を足したものが必要な .wterm 幅。
    setMeasuredWidth(Math.ceil(maxRight - gridLeft) + PADDING * 2)
  }, [])

  // wterm は write 後に setTimeout(0)+rAF で非同期に行を再描画する。その DOM 変化を MutationObserver
  // で捉え、rAF でデバウンスして実幅を計測する(.term-grid は WTerm コンストラクタで同期生成済み)。
  useEffect(() => {
    const gridEl = wrapperRef.current?.querySelector('.term-grid')
    if (!gridEl) return
    let raf = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    observer.observe(gridEl, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [measure])

  // フォント増減はセル寸法を変えるため積み上げた実幅をリセットして再計測する(縮小時の過剰確保を防ぐ)。
  // フォント変更は CSS 反映のみで DOM mutation を起こさず MutationObserver が発火しないので明示再計測。
  // 寸法(cols/rows)変化ではリセットしない: floor=cols*ch が現寸法に追従し measuredWidth は grow-only で
  // 据え置くため幅が下がらず、リモートのペイン再サイズ(自動イベント)でもチラつかない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: fontSize は再計測トリガーで本体では未参照。
  useEffect(() => {
    setMeasuredWidth(0)
    const raf = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(raf)
  }, [fontSize, measure])

  // grid モードはネイティブ寸法に固定（autoResize 廃止）。@wterm は cols/rows prop 変化時に
  // 自動で resize() するため、グリッドの幅・行数どおりに表示しデスクトップ cmux と一致させる。
  // `!= null` で null と undefined の両方を「グリッド無し」とする。`!== null` だと停止端末で
  // render_grid 欠落→undefined になった grid が cols={grid.columns} まで到達して落ちる。
  const useGrid = grid != null

  // 最下部ピン留め。スクロールコンテナである wrapper 自身の scroll だけを監視して
  // isAtBottom を判定し、変化時のみ App へ通知する。App はピン留め中のみ scrollback をフェッチする
  // ため、上へ遡って読んでいる間は <pre> が据え置きになる（読んでいる行が流れない）。
  const pinnedRef = useRef(true)
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onScroll = () => {
      const pinned = isAtBottom({
        scrollTop: wrapper.scrollTop,
        clientHeight: wrapper.clientHeight,
        scrollHeight: wrapper.scrollHeight,
      })
      if (pinned !== pinnedRef.current) {
        pinnedRef.current = pinned
        onPinnedChange(pinned)
      }
    }
    wrapper.addEventListener('scroll', onScroll)
    return () => wrapper.removeEventListener('scroll', onScroll)
  }, [onPinnedChange])

  // サーフェス切替(resetKey 変化)時はピン留めへ戻し最下部から再開する。下の追従 effect より
  // 先に宣言し、同一コミットで両方発火しても「リセット→追従」の順で整合させる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey は切替検知トリガーで本体では未参照。
  useLayoutEffect(() => {
    pinnedRef.current = true
    const el = wrapperRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [resetKey])

  // ピン留め中の末尾追従。<pre>(scrollback)/grid の高さ変化・フォント変更のたびに最下部へ合わせる。
  // 非ピン中は一切触らない（ネイティブ慣性・読取位置を維持）。プログラム的な scrollTop 代入も
  // scroll イベントを発火するが、最下部への代入は isAtBottom=true → pinned 変化なしで無害。
  // biome-ignore lint/correctness/useExhaustiveDependencies: grid/scrollback/fontSize は高さ変化のトリガーで本体では未参照。
  useLayoutEffect(() => {
    if (!pinnedRef.current) return
    const el = wrapperRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [grid, scrollback, fontSize])

  const gestureStateRef = useRef<GestureState | null>(null)

  // クリック送信が有効なのは「マウス入力 + SGR + grid（cols/rows 既知）」が揃ったときだけ。
  // スクロールはマウスモードに関係なくネイティブで常に効く。
  const clickActive = mouseEnabled && useSgr && grid !== null

  // クライアント座標 → 1-based セル位置。grid 不在なら null。
  // 上に <pre>(スクロールバック) が積まれるため wrapper でなく .wterm(グリッド描画要素) を基準にする。
  // rect はスクロール済み位置を反映するので scrollLeft/scrollTop の補正は不要(0 を渡す)。
  const pointToCell = useCallback(
    (clientX: number, clientY: number) => {
      const el = wrapperRef.current?.querySelector<HTMLElement>('.wterm')
      if (!el || !grid) return null
      const rect = el.getBoundingClientRect()
      // <pre>(スクロールバック) 上のタップを弾く。pixelToCell は範囲外を clamp するため、
      // 判定しないと履歴領域のタップが row=1 のクリックとしてライブ端末へ誤送信される。
      if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null
      const { cellWidth, cellHeight } = cellSize({
        contentWidth: el.offsetWidth,
        contentHeight: el.offsetHeight,
        cols: grid.columns,
        rows: grid.rows,
        padding: PADDING,
      })
      return pixelToCell({
        clientX,
        clientY,
        rectLeft: rect.left,
        rectTop: rect.top,
        scrollLeft: 0,
        scrollTop: 0,
        cellWidth,
        cellHeight,
        padding: PADDING,
        cols: grid.columns,
        rows: grid.rows,
      })
    },
    [grid],
  )

  const onTouchStart = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    const a = e.touches[0]
    const b = e.touches[1]
    if (a && b) {
      const c = centroid(a, b)
      gestureStateRef.current = {
        kind: 'double',
        centerX: c.x,
        centerY: c.y,
        lastDistance: touchDistance(a, b),
        zoomAccum: 0,
        moved: false,
      }
    } else if (a) {
      gestureStateRef.current = { kind: 'single', startX: a.clientX, startY: a.clientY, moved: false }
    }
  }, [])

  const onTouchMove = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      const state = gestureStateRef.current
      if (!state) return
      const a = e.touches[0]
      const b = e.touches[1]

      if (state.kind === 'single') {
        // 一本指の縦横スクロールはブラウザのネイティブに任せる（preventDefault しないので慣性が残る）。
        // 閾値を超えて動いたらタップではなくスクロールと判定する。
        if (a && !isTap(a.clientX - state.startX, a.clientY - state.startY)) state.moved = true
        return
      }

      if (!a || !b) return
      // 二本指: 指間距離の変化を貯め 1 段ごとにフォント増減（ピンチズーム）。中心の平行移動は
      // ネイティブの二本指スクロールに任せる。距離変化=ピンチ／中心移動=スクロールのいずれでも
      // タップではないので moved=true にし、touchend での右クリック送信を抑止する。
      const c = centroid(a, b)
      const d = touchDistance(a, b)
      state.zoomAccum += d - state.lastDistance
      state.lastDistance = d
      while (state.zoomAccum >= PINCH_STEP_PX) {
        onAdjustFontSize(1)
        state.zoomAccum -= PINCH_STEP_PX
        state.moved = true
      }
      while (state.zoomAccum <= -PINCH_STEP_PX) {
        onAdjustFontSize(-1)
        state.zoomAccum += PINCH_STEP_PX
        state.moved = true
      }
      if (!isTap(c.x - state.centerX, c.y - state.centerY)) state.moved = true
    },
    [onAdjustFontSize],
  )

  const onTouchEnd = useCallback(
    (e: ReactTouchEvent<HTMLDivElement>) => {
      // 指がすべて離れたタイミングでジェスチャーを確定する（多指は最後の touchend で評価）。
      if (e.touches.length > 0) return
      const state = gestureStateRef.current
      gestureStateRef.current = null
      // 動いた = ドラッグ（スクロール）。クリックも preventDefault もしない（ネイティブ慣性を維持）。
      if (!state || state.moved) return

      // タップ確定: 合成 click を抑止し、wterm の textarea focus 由来のキーボード/スクロール副作用を断つ。
      e.preventDefault()
      if (!clickActive) return

      if (state.kind === 'single') {
        const t = e.changedTouches[0]
        if (!t) return
        const cell = pointToCell(t.clientX, t.clientY)
        if (cell) onSendMouse(encodeClick('left', cell.col, cell.row))
        return
      }

      // 二本指タップ → 右クリック（開始時の中心位置へ）。
      const cell = pointToCell(state.centerX, state.centerY)
      if (cell) onSendMouse(encodeClick('right', cell.col, cell.row))
    },
    [clickActive, onSendMouse, pointToCell],
  )

  const onTouchCancel = useCallback(() => {
    gestureStateRef.current = null
  }, [])

  const wrapperStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    width: '100%',
    // <pre>(スクロールバック)＋wterm(ライブ) の縦積みを縦に、cols がスマホ幅を超える grid や
    // 長いスクロールバック行を横に、ひとつのネイティブスクロールで扱う。
    overflow: 'auto',
    // 一本指でブラウザのネイティブ縦横スクロール（慣性付き）。タップ/右クリックは touchend で判定する。
    touchAction: 'pan-x pan-y',
    backgroundColor: 'var(--color-terminal-bg)',
  }

  // wterm reads font/colors from CSS custom properties on the terminal element.
  const termStyle = {
    padding: PADDING,
    borderRadius: 0,
    boxShadow: 'none',
    // grid モードの横幅。wterm の renderer は通常文字を「セル幅非固定の素の <span>」で描く
    // (width:1ch が付くのは罫線/ブロック文字 0x2580-0x259f 専用)ため、行幅は自然グリフ幅で決まり、
    // 全角(日本語/絵文字)を含む行は cols*ch を超える。固定 cols*ch + .wterm(overflow:hidden) だと
    // 超過分が永久にクリップされ wrapper の scrollWidth にも入らない=右が見切れてスクロールしても届かない。
    // そこで上の measure() で実測した measuredWidth(px) まで広げてクリップを無くす。max-content 等の
    // intrinsic 値は wterm が再描画で grid DOM を一瞬空にする(renderer.setup の innerHTML='')間に潰れて
    // scrollLeft が左へ飛ぶ(チラつき)ため使わない。明示 px(measuredWidth)＋floor cols*ch の max() は
    // どちらも確定値=空フレームでも潰れず無チラつき。floor は初回(measuredWidth=0)と現寸法への追従を担う。
    // box-sizing:border-box なので padding 分を加算。
    // .wterm 幅: まずコンテナ(100%)を満たし(右に app 背景の隙間を作らない)、実コンテンツ(末尾空白除外)が
    // それを超える(モバイル/内容が pane より広い)なら実測幅まで広げて横スクロール可能に。cols*ch は使わない
    // (末尾の空セルまで含み grid が pane より広いと右に余白が出るため)。未計測(0)時は 100% = pane を満たす。
    width: grid ? `max(100%, ${measuredWidth}px)` : undefined,
    '--term-font-family': TERM_FONT_FAMILY,
    '--term-bg': '#1e1e1e',
    '--term-fg': '#e0e0e0',
    '--term-cursor': '#e0e0e0',
    '--term-font-size': `${fontSize}px`,
    // grid が無い(停止端末/オフライン)ときは wterm を隠し、上の <pre> だけが全文を描画する。
    // grid モードは WTerminal が rows 由来の固定高(mergedStyle)を付けるため display キーを
    // 入れない条件付きスプレッドにする。
    ...(useGrid ? {} : { display: 'none' }),
  } as CSSProperties

  // スクロールバック(プレーンテキスト)の <pre>。wterm と同じ見た目(フォント/余白/前景色)に合わせる。
  // ターミナルのビューポートは全テーマでダーク固定のため配色は wterm の --term-* と同じ実値。
  // 長行は折り返さず width:max-content で最長行まで箱を広げ、wrapper の横スクロールで見る。
  // 下に wterm(padding 8) が続くため paddingBottom は 0 にして seam の隙間を二重にしない。
  const preStyle: CSSProperties = {
    margin: 0,
    padding: `${PADDING}px ${PADDING}px 0 ${PADDING}px`,
    fontFamily: TERM_FONT_FAMILY,
    fontSize: `${fontSize}px`,
    lineHeight: 1.2,
    color: '#e0e0e0',
    whiteSpace: 'pre',
    width: 'max-content',
    minWidth: '100%',
  }

  return (
    <div
      ref={wrapperRef}
      style={wrapperStyle}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {scrollback !== '' && <pre style={preStyle}>{cleanScreen(scrollback)}</pre>}
      <WTerminal
        ref={ref}
        autoResize={!useGrid}
        cols={useGrid ? grid.columns : undefined}
        rows={useGrid ? grid.rows : undefined}
        cursorBlink={false}
        onData={() => {}}
        onReady={onReady}
        style={termStyle}
      />
    </div>
  )
}
