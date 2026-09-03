import { useCallback, useEffect, useRef, useState } from 'react'

import { BrowserView } from './components/BrowserView'
import { DESKTOP_BREAKPOINT, Drawer, SIDEBAR_WIDTH } from './components/Drawer'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Header } from './components/Header'
import { InputBar } from './components/InputBar'
import { SettingsModal } from './components/SettingsModal'
import { TabBar } from './components/TabBar'
import { Terminal } from './components/Terminal'
import { TokenGate } from './components/TokenGate'
import { useCmux } from './hooks/useCmux'
import { useTheme } from './hooks/useTheme'
import { deriveMouseMode } from './lib/mouse-mode'
import { isPushSubscribed, isPushSupported, subscribeToPush, unsubscribeFromPush } from './lib/push'
import type { RenderGrid } from './lib/render-grid'
import { isStaleSurfaceError } from './lib/rpc-error'
import { stripVisibleScreen, visibleLineCount } from './lib/scrollback'
import { loadHistoryLines, loadPushEnabled, saveHistoryLines, savePushEnabled } from './lib/settings'
import { loadSurfaceScreen, saveSurfaceScreen } from './lib/surface-cache'
import { encodeKey, isAppCursorMode } from './lib/terminal-keys'
import { getAuthToken, saveAuthToken } from './lib/token'
import { describeFeed } from './lib/view-state'

const POLL_INTERVAL = 1000
const NOTIF_POLL_INTERVAL = 10000
const MIN_FONT_SIZE = 9
const MAX_FONT_SIZE = 28
const DEFAULT_FONT_SIZE = 13
const FOREGROUND_STORAGE_KEY = 'cmux:foreground'

export function App() {
  // テーマはトークンゲート画面でも効かせるため、token 判定より前で適用する。
  const theme = useTheme()
  // iOS home-screen PWAs launch at the manifest start_url and use a storage
  // container separate from Safari, so the ?token= bootstrap never reaches
  // them — collect the token in-app when none is available.
  const [token, setToken] = useState(getAuthToken)

  if (!token) {
    return (
      <TokenGate
        onSubmit={(t) => {
          saveAuthToken(t)
          setToken(t)
        }}
      />
    )
  }

  return <Main theme={theme} />
}

function Main({ theme }: { theme: ReturnType<typeof useTheme> }) {
  const {
    status,
    topologyReady,
    workspaces,
    currentWorkspace,
    surfaces,
    currentSurface,
    notifications,
    view,
    feeds,
    createSurface,
    closeSurface,
    closeWorkspace,
    createWorkspace,
    selectSurface,
    initializeFrom,
    requestTopologyRefresh,
    readText,
    readGrid,
    sendText,
    listNotifications,
  } = useCmux()

  // デスクトップ/タブレットでは既定でドロワーを開く（ピン留め）。iPhone 等は閉じた状態で開始。
  const [drawerOpen, setDrawerOpen] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT,
  )
  // グリッドの上へ常時併記するスクロールバック(履歴・seam 除去済み)と、
  // 表示中内容の取得時刻(オフライン保持の鮮度表示用)。
  const [termHistory, setTermHistory] = useState('')
  const [termGrid, setTermGrid] = useState<RenderGrid | null>(null)
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  const [, setLastUpdated] = useState<number | null>(null)
  // 履歴で取得する行数(設定モーダルで調整、localStorage 永続)と、設定モーダルの開閉。
  const [historyLines, setHistoryLines] = useState(loadHistoryLines)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Web Push 通知の有効状態。初期は localStorage の楽観値、マウント後に実購読で補正する。
  const pushSupported = isPushSupported()
  const [pushEnabled, setPushEnabled] = useState(loadPushEnabled)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const topologyInitializedRef = useRef(false)
  // stale-surface エラーで再取得を試みた surface。同一 surface での再取得ループを防ぐ
  // （surface ごとに 1 回だけ resync する）。ポーリング成功でリセット。
  const staleResyncRef = useRef<string | null>(null)
  // 最下部ピン留め(Terminal から通知)。ピン留め中のみ scrollback を取得する＝上へ遡って
  // 読んでいる間はフェッチ自体を止めて表示据え置き(読んでいる行が流れない)＋帯域節約。
  const pinnedRef = useRef(true)
  const onPinnedChange = useCallback((pinned: boolean) => {
    pinnedRef.current = pinned
  }, [])
  // localStorage への scrollback 書込を「内容が変わった時のみ」にするための前回値
  // (毎秒 200KB 級の JSON 書込によるジャンク防止)。
  const lastScrollbackRef = useRef<string | null>(null)

  const currentSurfaceInfo = surfaces.find((s) => s.ref === currentSurface)
  const isBrowserSurface = currentSurfaceInfo?.type === 'browser'

  // 通知は topology と別系統。surface/workspace の初期取得は useCmux の T1 だけが行う。
  useEffect(() => {
    if (status !== 'connected') return
    listNotifications().catch((err) => console.error('[app] Init notification error:', err))
  }, [status, listNotifications])

  // 最初の topology snapshot が適用された後に 1 回だけ前面を決める。空配列も正常な初期状態。
  useEffect(() => {
    if (!topologyReady || topologyInitializedRef.current) return
    topologyInitializedRef.current = true

    const params = new URLSearchParams(window.location.search)
    const workspaceId = params.get('workspace')
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
    const linkedRef = surfaces.find((surface) => surface.workspace_ref === workspace?.ref)?.ref
    const storedRef = sessionStorage.getItem(FOREGROUND_STORAGE_KEY)
    const preferredRef = linkedRef ?? surfaces.find((surface) => surface.ref === storedRef)?.ref ?? null
    initializeFrom(surfaces, preferredRef)

    if (workspaceId !== null) {
      params.delete('workspace')
      const query = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
    }
  }, [topologyReady, workspaces, surfaces, initializeFrom])

  // 通知バッジ(Needs input / Permission)の鮮度を保つための定期ポーリング。init で 1 回だけ
  // 取得すると、cmux 側で応答して is_read が立ってもスナップショットが凍結し、応答済みの
  // バッジが残り続ける。接続中は notification.list を再取得して is_read 遷移を反映させる。
  useEffect(() => {
    if (status !== 'connected') return
    const timer = setInterval(() => {
      listNotifications().catch(() => {})
    }, NOTIF_POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [status, listNotifications])

  // Surface 切替時はまずキャッシュから即座にハイドレートし、切断/リロード直後でも
  // 「直前までの履歴」を空白にせず表示する。ライブポーリングが繋がれば上書きされる。
  // 切替時はピン留め(最下部＝最新)へ戻す。grid があるキャッシュは scrollback から画面ぶんを
  // 削って併記用の履歴に、grid が無ければ(停止端末/旧キャッシュ) scrollback→text を全文表示する。
  useEffect(() => {
    pinnedRef.current = true
    lastScrollbackRef.current = null
    if (!currentSurface) {
      setTermGrid(null)
      setTermHistory('')
      setLastUpdated(null)
      return
    }
    const cached = loadSurfaceScreen(currentSurface)
    const grid = cached?.grid ?? null
    setTermGrid(grid)
    setTermHistory(
      grid
        ? stripVisibleScreen(cached?.scrollback ?? '', visibleLineCount(grid))
        : (cached?.scrollback ?? cached?.text ?? ''),
    )
    setLastUpdated(cached?.updatedAt ?? null)
  }, [currentSurface])

  // Poll terminal content for the selected surface (tab). Browser surfaces are
  // rendered in an iframe instead, so their (base64) read_text is never polled.
  useEffect(() => {
    if (status !== 'connected' || !currentSurface || isBrowserSurface) {
      if (pollRef.current) clearInterval(pollRef.current)
      return
    }

    // 在flight の readGrid(prevSurface) が currentSurface 変化後に resolve すると、
    // 新タブの termGrid を旧タブの内容で上書きしてしまう（PWA 1秒ポール + RPC 遅延で頻発）。
    // cleanup で cancelled を立てて resolve 後の state 反映を破棄する。
    let cancelled = false
    const poll = async () => {
      try {
        const grid = await readGrid(currentSurface)
        if (cancelled) return
        setTermGrid(grid)
        const now = Date.now()
        setLastUpdated(now)
        // オフライン保持用に最後のグリッドを永続化（text/scrollback は引き継がれる）。
        // 停止端末で grid が null のときは undefined を渡し、直近の正常グリッドを潰さず引き継ぐ。
        saveSurfaceScreen(currentSurface, { grid: grid ?? undefined, updatedAt: now })
        staleResyncRef.current = null

        // スクロールバック(履歴)は最下部ピン留め中のみ取得する。上へ遡って読んでいる間は
        // フェッチ自体をスキップ＝<pre> の内容が凍結され、読んでいる行が流れない(最下部復帰で
        // 次ポーリングが追いつく)。alternate screen(TUI)にスクロールバックの概念はなく、停止端末
        // (grid なし)は read_text 自体が失敗するため、いずれも取得しない。seam の削りは
        // 「同ポーリングの grid」で行う(レンダー時に削り直すと凍結中の表示が動いてしまう)。
        if (pinnedRef.current && grid && grid.active_screen !== 'alternate') {
          const text = await readText(currentSurface, { scrollback: true, lines: historyLines })
          // await 中に unpin（上へ遡り開始）した場合は反映しない。反映すると凍結すべき <pre> が
          // 書き換わり、遡り始めた瞬間に読んでいる行が一度流れる（キャッシュ保存も次回ピン時に任せる）。
          if (cancelled || !pinnedRef.current) return
          setTermHistory(stripVisibleScreen(text, visibleLineCount(grid)))
          if (text !== lastScrollbackRef.current) {
            lastScrollbackRef.current = text
            saveSurfaceScreen(currentSurface, { scrollback: text, updatedAt: now })
          }
        }
      } catch (err) {
        if (cancelled) return
        // currentSurface が「閉じられた surface」を指すと cmux は terminal.replay に
        // 「Missing or invalid terminal_id」を返し続ける（別ウィンドウ/別 PWA でタブを閉じた、
        // 通信不良中にタブ構成が変わった等）。surface 一覧を再取得すれば resolveSelectedRef が
        // 無効 ref を捨てて生きた surface へ退避し、Mac 側でフォーカスし直さなくても自動復帰する。
        // surface ごとに 1 回だけ試みてループを防ぐ（無効なら次の list で別 surface へ移る）。
        if (isStaleSurfaceError(err) && staleResyncRef.current !== currentSurface) {
          staleResyncRef.current = currentSurface
          // 再取得自体が通信不良で失敗したら、フラグを解除して次ポーリングで再挑戦できるようにする
          // （成功時は据え置き＝同一 surface でのループ防止。ポーリング成功で null にリセットされる）。
          requestTopologyRefresh().catch(() => {
            if (staleResyncRef.current === currentSurface) staleResyncRef.current = null
          })
          return
        }
        // 通信不良の一時的失敗（タイムアウト等）はそのまま握りつぶす。stale でない想定外の
        // エラーのみログする。stale でループ中（2 回目以降）は無言で次の成功を待つ。
        if (!isStaleSurfaceError(err)) console.error('[app] Poll error:', err)
      }
    }

    poll()
    pollRef.current = setInterval(poll, POLL_INTERVAL)

    // バックグラウンド復帰時の即時再ポーリング。iPhone 等で PWA がバックグラウンド/
    // 画面ロックされると setInterval がスロットルされ更新が止まるため、復帰イベントで
    // 即座に最新を取りに行く。
    const resume = () => {
      if (document.visibilityState !== 'hidden') poll()
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('pageshow', resume)
    window.addEventListener('focus', resume)

    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('focus', resume)
    }
  }, [status, currentSurface, isBrowserSurface, historyLines, readGrid, readText, requestTopologyRefresh])

  // Mouse mode (from the live grid's DECSET modes) gates tap/click forwarding.
  const mouseMode = deriveMouseMode(termGrid)
  // 方向キーの \x1b[ / \x1bO 出し分け用（DECCKM）。
  const appCursor = isAppCursorMode(termGrid)

  // Terminal の二本指ピンチからフォントサイズを増減する（+1 拡大 / -1 縮小）。
  // タブ切替スワイプは廃止し、二本指パンは Terminal 内のスクロールで完結する。
  const adjustFontSize = useCallback((delta: number) => {
    setFontSize((s) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, s + delta)))
  }, [])

  // Web Push: マウント後に実際の購読状態でトグルを補正する（localStorage の楽観値を上書き）。
  useEffect(() => {
    if (!pushSupported) return
    isPushSubscribed()
      .then((subscribed) => {
        setPushEnabled(subscribed)
        savePushEnabled(subscribed)
      })
      .catch(() => {})
  }, [pushSupported])

  // トグル操作(ユーザージェスチャ)で購読/解除する。許可が下りなければ false に戻す。
  const togglePush = useCallback((enabled: boolean) => {
    if (enabled) {
      subscribeToPush()
        .then((ok) => {
          setPushEnabled(ok)
          savePushEnabled(ok)
          // 許可が granted 以外で false が返るケース(iOS で拒否/未許可)を明示する。
          if (!ok) alert('通知を有効化できませんでした（許可が下りていない可能性があります）。')
        })
        .catch((err) => {
          // 失敗の握りつぶしは iPhone で原因が見えず切り分け不能になるため、実エラーを表示する。
          console.error('[app] push subscribe error:', err)
          setPushEnabled(false)
          savePushEnabled(false)
          alert(`通知の有効化に失敗しました: ${err instanceof Error ? err.message : String(err)}`)
        })
    } else {
      unsubscribeFromPush()
        .then(() => {
          setPushEnabled(false)
          savePushEnabled(false)
        })
        .catch((err) => console.error('[app] push unsubscribe error:', err))
    }
  }, [])

  const [isDesktop, setIsDesktop] = useState(typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT)

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`)
    // ブレークポイントを跨いだら、デスクトップ化で開く（ピン留め）/ モバイル化で閉じる。
    const handler = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches)
      setDrawerOpen(e.matches)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // マウント後の Push 通知タップは購読集合を保ったまま対象サーフェスを前面化する。
  useEffect(() => {
    const navigateTo = (workspaceId: string) => {
      // Push が渡すのは UUID。Workspace.id で引く（ref では引けない）。
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
      if (!workspace) return
      const inWorkspace = surfaces.filter((surface) => surface.workspace_ref === workspace.ref)
      const subscribed = new Set(view.subscriptions.map((subscription) => subscription.ref))
      const target = inWorkspace.find((surface) => subscribed.has(surface.ref)) ?? inWorkspace[0]
      if (target) selectSurface(target)
    }
    const onMessage = (e: MessageEvent) => {
      const data = (e.data ?? {}) as { type?: string; workspaceId?: string }
      if (data.type === 'navigate' && typeof data.workspaceId === 'string') navigateTo(data.workspaceId)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [workspaces, surfaces, view.subscriptions, selectSurface])

  const currentWs = workspaces.find((w) => w.ref === currentWorkspace)
  const freshness = currentSurface ? (describeFeed(feeds.get(currentSurface))?.freshness ?? null) : null

  return (
    <div
      style={{
        display: 'flex',
        height: 'var(--app-height)',
        backgroundColor: 'var(--color-bg)',
        color: 'var(--color-text)',
        overflow: 'hidden',
      }}
    >
      <Drawer
        open={drawerOpen}
        workspaces={workspaces}
        currentWorkspace={currentWorkspace}
        notifications={notifications}
        surfaces={surfaces}
        foreground={currentSurface}
        subscribedRefs={new Set(view.subscriptions.map((subscription) => subscription.ref))}
        onSelectSurface={selectSurface}
        onCloseWorkspace={(ref) => {
          closeWorkspace(ref).catch((err) => console.error('[app] close workspace error:', err))
        }}
        onNewWorkspace={() =>
          createWorkspace()
            .then(() => setDrawerOpen(false))
            .catch((err) => console.error('[app] create workspace error:', err))
        }
        onClose={() => setDrawerOpen(false)}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          marginLeft: isDesktop && drawerOpen ? SIDEBAR_WIDTH : 0,
          transition: 'margin-left 0.2s ease-out',
          overflow: 'hidden',
        }}
      >
        <Header
          workspaceTitle={currentWs?.title ?? null}
          surfaceTitle={currentSurfaceInfo?.title ?? null}
          onMenuToggle={() => setDrawerOpen((o) => !o)}
          status={status}
          freshness={freshness}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <TabBar
          surfaces={surfaces}
          foreground={currentSurface}
          subscribedRefs={new Set(view.subscriptions.map((subscription) => subscription.ref))}
          feeds={feeds}
          workspaceColor={(workspaceRef) =>
            workspaces.find((workspace) => workspace.ref === workspaceRef)?.custom_color ?? 'var(--color-text-muted)'
          }
          onSelect={selectSurface}
          onClose={(ref) => {
            closeSurface(ref).catch((err) => console.error('[app] close error:', err))
          }}
          onCreate={() => {
            if (currentSurfaceInfo) {
              createSurface(currentSurfaceInfo.workspace_id).catch((err) => console.error('[app] create error:', err))
            }
          }}
        />

        {/* コンテンツ領域だけをエラー境界で囲む。停止端末等で描画が落ちても枠の TabBar/Header/InputBar
            は生き残り、別タブへ切替/このタブを閉じるで復帰できる（最上位境界だと全体が畳まれ、再読み込み
            でも壊れた surface が復元され逃げ場が消える）。resetKey=currentSurface でタブ切替時に自動回復。 */}
        <ErrorBoundary inline resetKey={currentSurface}>
          {topologyReady && surfaces.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-muted)',
              }}
            >
              端末がありません
            </div>
          ) : isBrowserSurface ? (
            <BrowserView url={currentSurfaceInfo?.url ?? ''} title={currentSurfaceInfo?.title ?? ''} />
          ) : (
            <Terminal
              grid={termGrid}
              // alternate screen(TUI) 中は履歴を出さない(スクロールバックの概念がなく、上に
              // primary の履歴が見えると混乱する)。state は保持し primary 復帰で即再表示する。
              scrollback={termGrid?.active_screen === 'alternate' ? '' : termHistory}
              fontSize={fontSize}
              mouseEnabled={mouseMode.mouseEnabled}
              useSgr={mouseMode.useSgr}
              onSendMouse={(text) => {
                if (currentSurface)
                  sendText(currentSurface, text).catch((err) => console.error('[app] mouse error:', err))
              }}
              onAdjustFontSize={adjustFontSize}
              onPinnedChange={onPinnedChange}
              resetKey={currentSurface}
            />
          )}
        </ErrorBoundary>

        {/* InputBar の下にあった StatusBar(footer) は廃止。接続状態と鮮度表示は Header へ移設した。 */}
        <InputBar
          disabled={!currentSurface || isBrowserSurface}
          onSendText={(text) => {
            if (currentSurface) sendText(currentSurface, text).catch((err) => console.error('[app] send error:', err))
          }}
          onSendKey={(key) => {
            // cmux の send_key は key 名の解釈に癖があり方向キーが効かないため、実証済みの
            // send_text 経路で生のエスケープシーケンスを送る（DECCKM で \x1b[/\x1bO を出し分け）。
            if (currentSurface)
              sendText(currentSurface, encodeKey(key, appCursor)).catch((err) => console.error('[app] key error:', err))
          }}
          onAdjustFontSize={adjustFontSize}
        />
      </div>

      <SettingsModal
        open={settingsOpen}
        themeSetting={theme.setting}
        onThemeChange={theme.setTheme}
        historyLines={historyLines}
        pushSupported={pushSupported}
        pushEnabled={pushEnabled}
        onTogglePush={togglePush}
        onSave={(lines) => {
          setHistoryLines(lines)
          saveHistoryLines(lines)
        }}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
