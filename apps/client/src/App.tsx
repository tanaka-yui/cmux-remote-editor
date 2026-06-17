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
import { loadHistoryLines, loadPushEnabled, saveHistoryLines, savePushEnabled } from './lib/settings'
import { loadSurfaceScreen, saveSurfaceScreen } from './lib/surface-cache'
import { encodeKey, isAppCursorMode } from './lib/terminal-keys'
import { getAuthToken, saveAuthToken } from './lib/token'

const POLL_INTERVAL = 1000
const NOTIF_POLL_INTERVAL = 10000
const INIT_RETRY_INTERVAL = 3000
const MIN_FONT_SIZE = 9
const MAX_FONT_SIZE = 28
const DEFAULT_FONT_SIZE = 13

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
    workspaces,
    currentWorkspace,
    surfaces,
    currentSurface,
    notifications,
    listWorkspaces,
    selectWorkspace,
    listPanes,
    listSurfaces,
    createSurface,
    closeSurface,
    closeWorkspace,
    createWorkspace,
    focusSurface,
    readText,
    readGrid,
    sendText,
    listNotifications,
  } = useCmux()

  // デスクトップ/タブレットでは既定でドロワーを開く（ピン留め）。iPhone 等は閉じた状態で開始。
  const [drawerOpen, setDrawerOpen] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT,
  )
  const [termContent, setTermContent] = useState('')
  const [termGrid, setTermGrid] = useState<RenderGrid | null>(null)
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  // 履歴(スクロールバック)モードと、表示中内容の取得時刻(オフライン保持の鮮度表示用)。
  const [historyMode, setHistoryMode] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  // 履歴で取得する行数(設定モーダルで調整、localStorage 永続)と、設定モーダルの開閉。
  const [historyLines, setHistoryLines] = useState(loadHistoryLines)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Web Push 通知の有効状態。初期は localStorage の楽観値、マウント後に実購読で補正する。
  const pushSupported = isPushSupported()
  const [pushEnabled, setPushEnabled] = useState(loadPushEnabled)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  // stale-surface エラーで再取得を試みた surface。同一 surface での再取得ループを防ぐ
  // （surface ごとに 1 回だけ resync する）。ポーリング成功でリセット。
  const staleResyncRef = useRef<string | null>(null)

  const currentSurfaceInfo = surfaces.find((s) => s.ref === currentSurface)
  const isBrowserSurface = currentSurfaceInfo?.type === 'browser'

  // Initial data fetch. Retried on failure: a transient cmux outage right
  // after connecting would otherwise leave the app blank until a manual reload.
  useEffect(() => {
    if (status !== 'connected') return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const init = () => {
      // panes/surfaces はここで取得しない。引数なしの listSurfaces() はサーバーが全
      // ワークスペースの surface を返すため、他ワークスペースのタブが混入する。これらは
      // currentWorkspace が決まってから下の effect が workspace_ref 付きで取得する。
      listWorkspaces()
        .then(() => listNotifications())
        .catch((err) => {
          console.error('[app] Init error:', err)
          if (!cancelled) retryTimer = setTimeout(init, INIT_RETRY_INTERVAL)
        })
    }
    init()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [status, listWorkspaces, listNotifications])

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

  // Re-fetch panes and surfaces when the (app-selected) workspace changes — always
  // scoped to currentWorkspace so other workspaces' surfaces never leak in. Retried
  // on transient failure so a brief cmux outage doesn't leave the tab bar empty.
  useEffect(() => {
    if (status !== 'connected' || !currentWorkspace) return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const fetchWorkspace = () => {
      Promise.all([listPanes(currentWorkspace), listSurfaces(currentWorkspace)]).catch(() => {
        if (!cancelled) retryTimer = setTimeout(fetchWorkspace, INIT_RETRY_INTERVAL)
      })
    }
    fetchWorkspace()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [status, currentWorkspace, listPanes, listSurfaces])

  // Surface 切替時はまずキャッシュから即座にハイドレートし、切断/リロード直後でも
  // 「直前までの履歴」を空白にせず表示する。ライブポーリングが繋がれば上書きされる。
  // タブを切り替えたら履歴モードはライブへ戻す。
  useEffect(() => {
    setHistoryMode(false)
    if (!currentSurface) {
      setTermGrid(null)
      setTermContent('')
      setLastUpdated(null)
      return
    }
    const cached = loadSurfaceScreen(currentSurface)
    setTermGrid(cached?.grid ?? null)
    setTermContent(cached?.text ?? '')
    setLastUpdated(cached?.updatedAt ?? null)
  }, [currentSurface])

  // Poll terminal content for the selected surface (tab). Browser surfaces are
  // rendered in an iframe instead, so their (base64) read_text is never polled.
  // History モード中はライブ更新を止め、スクロールバックを固定表示する。
  useEffect(() => {
    if (status !== 'connected' || !currentSurface || isBrowserSurface || historyMode) {
      if (pollRef.current) clearInterval(pollRef.current)
      return
    }

    const poll = async () => {
      try {
        const grid = await readGrid(currentSurface)
        setTermGrid(grid)
        const now = Date.now()
        setLastUpdated(now)
        // オフライン保持用に最後のグリッドを永続化（text/scrollback は引き継がれる）。
        // 停止端末で grid が null のときは undefined を渡し、直近の正常グリッドを潰さず引き継ぐ。
        saveSurfaceScreen(currentSurface, { grid: grid ?? undefined, updatedAt: now })
        staleResyncRef.current = null
      } catch (err) {
        // currentSurface が「閉じられた surface」を指すと cmux は terminal.replay に
        // 「Missing or invalid terminal_id」を返し続ける（別ウィンドウ/別 PWA でタブを閉じた、
        // 通信不良中にタブ構成が変わった等）。surface 一覧を再取得すれば resolveSelectedRef が
        // 無効 ref を捨てて生きた surface へ退避し、Mac 側でフォーカスし直さなくても自動復帰する。
        // surface ごとに 1 回だけ試みてループを防ぐ（無効なら次の list で別 surface へ移る）。
        if (isStaleSurfaceError(err) && staleResyncRef.current !== currentSurface) {
          staleResyncRef.current = currentSurface
          // 再取得自体が通信不良で失敗したら、フラグを解除して次ポーリングで再挑戦できるようにする
          // （成功時は据え置き＝同一 surface でのループ防止。ポーリング成功で null にリセットされる）。
          listSurfaces(currentWorkspace ?? undefined).catch(() => {
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
      if (pollRef.current) clearInterval(pollRef.current)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('focus', resume)
    }
  }, [status, currentSurface, currentWorkspace, isBrowserSurface, historyMode, readGrid, listSurfaces])

  // 履歴モード: スクロールバックを 1 回取得して固定表示。取得分はオフライン閲覧用に
  // キャッシュする。切断中は取得済みキャッシュ(scrollback→text)へフォールバックする。
  useEffect(() => {
    if (!historyMode || !currentSurface) return

    if (status !== 'connected') {
      const cached = loadSurfaceScreen(currentSurface)
      if (cached) {
        setTermContent(cached.scrollback ?? cached.text ?? '')
        setLastUpdated(cached.updatedAt)
      }
      return
    }

    let cancelled = false
    readText(currentSurface, { scrollback: true, lines: historyLines })
      .then((text) => {
        if (cancelled) return
        setTermContent(text)
        const now = Date.now()
        setLastUpdated(now)
        saveSurfaceScreen(currentSurface, { text, scrollback: text, updatedAt: now })
      })
      .catch((err) => console.error('[app] History fetch error:', err))

    return () => {
      cancelled = true
    }
  }, [historyMode, currentSurface, status, readText, historyLines])

  // Mouse mode (from the live grid's DECSET modes) gates tap/click forwarding.
  // History mode shows static text, so treat it as no live grid (mouse off).
  const mouseMode = deriveMouseMode(historyMode ? null : termGrid)
  // 方向キーの \x1b[ / \x1bO 出し分け用（DECCKM）。履歴モードはライブグリッド無し扱い。
  const appCursor = isAppCursorMode(historyMode ? null : termGrid)

  // Terminal の二本指ピンチからフォントサイズを増減する（+1 拡大 / -1 縮小）。
  // タブ切替スワイプは廃止し、二本指パンは Terminal 内のスクロールで完結する。
  const adjustFontSize = useCallback((delta: number) => {
    setFontSize((s) => Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, s + delta)))
  }, [])

  // ライブ上端での上スクロールで遡り（履歴）へ、遡り後の最下部復帰でライブへ。Terminal から呼ばれる。
  const enterHistory = useCallback(() => setHistoryMode(true), [])
  const exitHistory = useCallback(() => setHistoryMode(false), [])

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

  // プッシュ通知タップ後の遷移。?workspace=<id>(新規ウィンドウ)と SW からの postMessage(既存
  // ウィンドウ)の両方で、通知の workspace_id に対応するワークスペースを選択する。
  useEffect(() => {
    if (workspaces.length === 0) return
    const navigateTo = (workspaceId: string) => {
      const target = workspaces.find((w) => w.id === workspaceId)
      if (target) selectWorkspace(target.ref)
    }
    const params = new URLSearchParams(window.location.search)
    const wid = params.get('workspace')
    if (wid) {
      navigateTo(wid)
      params.delete('workspace')
      const qs = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
    const onMessage = (e: MessageEvent) => {
      const data = (e.data ?? {}) as { type?: string; workspaceId?: string }
      if (data.type === 'navigate' && typeof data.workspaceId === 'string') navigateTo(data.workspaceId)
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [workspaces, selectWorkspace])

  const currentWs = workspaces.find((w) => w.ref === currentWorkspace)

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
        onSelect={(ref) => {
          selectWorkspace(ref)
        }}
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
          workspaceName={currentWs?.title ?? null}
          onMenuToggle={() => setDrawerOpen((o) => !o)}
          status={status}
          lastUpdated={lastUpdated}
          historyMode={historyMode}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <TabBar
          surfaces={surfaces}
          currentSurface={currentSurface}
          onSelect={(ref) => {
            focusSurface(ref)
          }}
          onClose={(ref) => {
            closeSurface(ref, currentWorkspace ?? undefined).catch((err) => console.error('[app] close error:', err))
          }}
          onCreate={() => {
            createSurface(currentWorkspace ?? undefined).catch((err) => console.error('[app] create error:', err))
          }}
        />

        {/* コンテンツ領域だけをエラー境界で囲む。停止端末等で描画が落ちても枠の TabBar/Header/InputBar
            は生き残り、別タブへ切替/このタブを閉じるで復帰できる（最上位境界だと全体が畳まれ、再読み込み
            でも壊れた surface が復元され逃げ場が消える）。resetKey=currentSurface でタブ切替時に自動回復。 */}
        <ErrorBoundary inline resetKey={currentSurface}>
          {isBrowserSurface ? (
            <BrowserView url={currentSurfaceInfo?.url ?? ''} title={currentSurfaceInfo?.title ?? ''} />
          ) : (
            <Terminal
              grid={historyMode ? null : termGrid}
              content={termContent}
              fontSize={fontSize}
              mouseEnabled={mouseMode.mouseEnabled}
              useSgr={mouseMode.useSgr}
              onSendMouse={(text) => {
                if (currentSurface)
                  sendText(currentSurface, text).catch((err) => console.error('[app] mouse error:', err))
              }}
              onAdjustFontSize={adjustFontSize}
              onEnterHistory={enterHistory}
              onExitHistory={exitHistory}
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
