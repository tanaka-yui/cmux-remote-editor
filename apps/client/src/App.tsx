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
import { useTerminalFeeds } from './hooks/useTerminalFeeds'
import { useTheme } from './hooks/useTheme'
import { deriveMouseMode } from './lib/mouse-mode'
import { isPushSubscribed, isPushSupported, subscribeToPush, unsubscribeFromPush } from './lib/push'
import { loadHistoryLines, loadPushEnabled, saveHistoryLines, savePushEnabled } from './lib/settings'
import { encodeKey, isAppCursorMode } from './lib/terminal-keys'
import { getAuthToken, saveAuthToken } from './lib/token'
import { describeFeed } from './lib/view-state'

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
    applyFeedResult,
    applyFeedHistory,
    applyFeedError,
    markDisconnected,
    repromote,
    sendText,
    listNotifications,
  } = useCmux()

  // デスクトップ/タブレットでは既定でドロワーを開く（ピン留め）。iPhone 等は閉じた状態で開始。
  const [drawerOpen, setDrawerOpen] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT,
  )
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  // 履歴で取得する行数(設定モーダルで調整、localStorage 永続)と、設定モーダルの開閉。
  const [historyLines, setHistoryLines] = useState(loadHistoryLines)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Web Push 通知の有効状態。初期は localStorage の楽観値、マウント後に実購読で補正する。
  const pushSupported = isPushSupported()
  const [pushEnabled, setPushEnabled] = useState(loadPushEnabled)
  const topologyInitializedRef = useRef(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('workspace'),
  )
  const didStripQuery = useRef(false)
  const [pinned, setPinned] = useState(true)
  const [createWarning, setCreateWarning] = useState<string | null>(null)
  const onPinnedChange = useCallback((next: boolean) => setPinned(next), [])

  const foregroundRef = view.foreground
  const foregroundSurface = surfaces.find((surface) => surface.ref === foregroundRef)
  const isBrowserSurface = foregroundSurface?.type === 'browser'
  const feed = feeds.get(foregroundRef ?? '')
  const description = describeFeed(feed)

  useTerminalFeeds({
    status,
    view,
    surfaces,
    feeds,
    visibleRefs: foregroundRef === null ? [] : [foregroundRef],
    pinned,
    historyLines,
    readGrid,
    readText,
    applyFeedResult,
    applyFeedHistory,
    applyFeedError,
    requestTopologyRefresh,
    markDisconnected,
    repromote,
  })

  // 通知は topology と別系統。surface/workspace の初期取得は useCmux の T1 だけが行う。
  useEffect(() => {
    if (status !== 'connected') return
    listNotifications().catch((err) => console.error('[app] Init notification error:', err))
  }, [status, listNotifications])

  // URL の値は state が保持する。render 中に履歴を書き換えず、commit 後に見た目だけ整える。
  useEffect(() => {
    if (didStripQuery.current) return
    didStripQuery.current = true
    const params = new URLSearchParams(window.location.search)
    if (!params.has('workspace')) return
    params.delete('workspace')
    const query = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''))
  }, [])

  // 最初の topology snapshot が適用された後に 1 回だけ前面を決める。空配列も正常な初期状態。
  useEffect(() => {
    if (!topologyReady || topologyInitializedRef.current) return
    topologyInitializedRef.current = true

    const workspace = workspaces.find((candidate) => candidate.id === pendingWorkspaceId)
    const inWorkspace = surfaces.filter((surface) => surface.workspace_ref === workspace?.ref)
    const subscribed = new Set(view.subscriptions.map((subscription) => subscription.ref))
    const linkedRef = inWorkspace.find((surface) => subscribed.has(surface.ref))?.ref ?? inWorkspace[0]?.ref
    const storedRef = sessionStorage.getItem(FOREGROUND_STORAGE_KEY)
    const preferredRef = linkedRef ?? surfaces.find((surface) => surface.ref === storedRef)?.ref ?? null
    setPendingWorkspaceId(null)
    initializeFrom(surfaces, preferredRef)
  }, [topologyReady, workspaces, surfaces, pendingWorkspaceId, view.subscriptions, initializeFrom])

  // 前面の保存は bootstrap が選択を確定した後の非 null 値だけに限定する。
  // 初回 snapshot 待ちの null で sessionStorage の前回値を消してはならない。
  useEffect(() => {
    if (foregroundRef !== null) sessionStorage.setItem(FOREGROUND_STORAGE_KEY, foregroundRef)
  }, [foregroundRef])

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

  // Terminal は resetKey で内部 ref だけを戻すため、フィード取得側へ渡す state も明示的に戻す。
  // biome-ignore lint/correctness/useExhaustiveDependencies: foregroundRef の変化そのものが pin reset の契機。
  useEffect(() => {
    setPinned(true)
  }, [foregroundRef])

  // Mouse mode (from the live grid's DECSET modes) gates tap/click forwarding.
  const mouseMode = deriveMouseMode(feed?.grid ?? null)
  // 方向キーの \x1b[ / \x1bO 出し分け用（DECCKM）。
  const appCursor = isAppCursorMode(feed?.grid ?? null)

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
  const freshness = description?.freshness ?? null

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
        foreground={foregroundRef}
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
          surfaceTitle={foregroundSurface?.title ?? null}
          onMenuToggle={() => setDrawerOpen((o) => !o)}
          status={status}
          freshness={freshness}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <TabBar
          surfaces={surfaces}
          foreground={foregroundRef}
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
            if (foregroundSurface) {
              setCreateWarning(null)
              createSurface(foregroundSurface.workspace_id)
                .then((result) => {
                  if (result.misplaced) setCreateWarning('別のワークスペースに作成されました')
                })
                .catch((err) => console.error('[app] create error:', err))
            }
          }}
        />

        {createWarning ? (
          <div
            role="alert"
            style={{
              padding: '6px 12px',
              color: 'var(--color-warning)',
              backgroundColor: 'var(--color-surface)',
              fontSize: 12,
            }}
          >
            {createWarning}
          </div>
        ) : null}

        {/* コンテンツ領域だけをエラー境界で囲む。停止端末等で描画が落ちても枠の TabBar/Header/InputBar
            は生き残り、別タブへ切替/このタブを閉じるで復帰できる（最上位境界だと全体が畳まれ、再読み込み
            でも壊れた surface が復元され逃げ場が消える）。resetKey=foregroundRef でタブ切替時に自動回復。 */}
        <ErrorBoundary inline resetKey={foregroundRef}>
          {foregroundRef === null ? (
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
            <BrowserView url={foregroundSurface?.url ?? ''} title={foregroundSurface?.title ?? ''} />
          ) : description?.kind === 'grid' && feed ? (
            <Terminal
              grid={feed.grid}
              // alternate screen(TUI) 中は履歴を出さない(スクロールバックの概念がなく、上に
              // primary の履歴が見えると混乱する)。state は保持し primary 復帰で即再表示する。
              scrollback={feed.grid?.active_screen === 'alternate' ? '' : feed.history}
              fontSize={fontSize}
              mouseEnabled={mouseMode.mouseEnabled}
              useSgr={mouseMode.useSgr}
              onSendMouse={(text) => {
                if (foregroundRef)
                  sendText(foregroundRef, text).catch((err) => console.error('[app] mouse error:', err))
              }}
              onAdjustFontSize={adjustFontSize}
              onPinnedChange={onPinnedChange}
              resetKey={foregroundRef}
            />
          ) : (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-text-muted)',
              }}
            >
              {description?.kind === 'message' ? description.message : '読み込み中'}
            </div>
          )}
        </ErrorBoundary>

        {/* InputBar の下にあった StatusBar(footer) は廃止。接続状態と鮮度表示は Header へ移設した。 */}
        <InputBar
          disabled={!foregroundRef || isBrowserSurface}
          onSendText={(text) => {
            if (foregroundRef) sendText(foregroundRef, text).catch((err) => console.error('[app] send error:', err))
          }}
          onSendKey={(key) => {
            // cmux の send_key は key 名の解釈に癖があり方向キーが効かないため、実証済みの
            // send_text 経路で生のエスケープシーケンスを送る（DECCKM で \x1b[/\x1bO を出し分け）。
            if (foregroundRef)
              sendText(foregroundRef, encodeKey(key, appCursor)).catch((err) => console.error('[app] key error:', err))
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
