import { useCallback, useEffect, useRef, useState } from 'react'

import { BrowserView } from './components/BrowserView'
import { DESKTOP_BREAKPOINT, Drawer, SIDEBAR_WIDTH } from './components/Drawer'
import { Header } from './components/Header'
import { InputBar } from './components/InputBar'
import { StatusBar } from './components/StatusBar'
import { TabBar } from './components/TabBar'
import { Terminal } from './components/Terminal'
import { TokenGate } from './components/TokenGate'
import { useCmux } from './hooks/useCmux'
import { useGesture } from './hooks/useGesture'
import { loadSurfaceScreen, saveSurfaceScreen } from './lib/surface-cache'
import { getAuthToken, saveAuthToken } from './lib/token'

const POLL_INTERVAL = 1000
const INIT_RETRY_INTERVAL = 3000
const MIN_FONT_SIZE = 9
const MAX_FONT_SIZE = 28
const DEFAULT_FONT_SIZE = 13
// 履歴モードで取得するスクロールバック行数。
const HISTORY_LINES = 2000

export function App() {
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

  return <Main />
}

function Main() {
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
    focusSurface,
    readText,
    sendText,
    sendKey,
    listNotifications,
    navigateWorkspace,
    navigateSurface,
  } = useCmux()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [termContent, setTermContent] = useState('')
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  // 履歴(スクロールバック)モードと、表示中内容の取得時刻(オフライン保持の鮮度表示用)。
  const [historyMode, setHistoryMode] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const currentSurfaceInfo = surfaces.find((s) => s.ref === currentSurface)
  const isBrowserSurface = currentSurfaceInfo?.type === 'browser'

  // Initial data fetch. Retried on failure: a transient cmux outage right
  // after connecting would otherwise leave the app blank until a manual reload.
  useEffect(() => {
    if (status !== 'connected') return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const init = () => {
      listWorkspaces()
        .then(() => Promise.all([listPanes(), listSurfaces(), listNotifications()]))
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
  }, [status, listWorkspaces, listPanes, listSurfaces, listNotifications])

  // Re-fetch panes and surfaces when workspace changes
  useEffect(() => {
    if (status !== 'connected' || !currentWorkspace) return
    Promise.all([listPanes(currentWorkspace), listSurfaces(currentWorkspace)]).catch(() => {})
  }, [status, currentWorkspace, listPanes, listSurfaces])

  // Surface 切替時はまずキャッシュから即座にハイドレートし、切断/リロード直後でも
  // 「直前までの履歴」を空白にせず表示する。ライブポーリングが繋がれば上書きされる。
  // タブを切り替えたら履歴モードはライブへ戻す。
  useEffect(() => {
    setHistoryMode(false)
    if (!currentSurface) {
      setTermContent('')
      setLastUpdated(null)
      return
    }
    const cached = loadSurfaceScreen(currentSurface)
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
        const text = await readText(currentSurface)
        setTermContent(text)
        const now = Date.now()
        setLastUpdated(now)
        // オフライン保持用に最後の画面を永続化（既存の scrollback は維持される）。
        saveSurfaceScreen(currentSurface, { text, updatedAt: now })
      } catch (err) {
        console.error('[app] Poll error:', err)
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
  }, [status, currentSurface, isBrowserSurface, historyMode, readText])

  // 履歴モード: スクロールバックを 1 回取得して固定表示。取得分はオフライン閲覧用に
  // キャッシュする。切断中は取得済みキャッシュ(scrollback→text)へフォールバックする。
  useEffect(() => {
    if (!historyMode || !currentSurface) return

    if (status !== 'connected') {
      const cached = loadSurfaceScreen(currentSurface)
      if (cached) {
        setTermContent(cached.scrollback ?? cached.text)
        setLastUpdated(cached.updatedAt)
      }
      return
    }

    let cancelled = false
    readText(currentSurface, { scrollback: true, lines: HISTORY_LINES })
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
  }, [historyMode, currentSurface, status, readText])

  // Gesture handlers: vertical = workspaces, horizontal = tabs, pinch = font size
  const onSwipeUp = useCallback(() => {
    navigateWorkspace('next')
  }, [navigateWorkspace])

  const onSwipeDown = useCallback(() => {
    navigateWorkspace('prev')
  }, [navigateWorkspace])

  const onSwipeLeft = useCallback(() => {
    navigateSurface('next')
  }, [navigateSurface])

  const onSwipeRight = useCallback(() => {
    navigateSurface('prev')
  }, [navigateSurface])

  const onPinchIn = useCallback(() => {
    setFontSize((s) => Math.max(MIN_FONT_SIZE, s - 1))
  }, [])

  const onPinchOut = useCallback(() => {
    setFontSize((s) => Math.min(MAX_FONT_SIZE, s + 1))
  }, [])

  const gestureRef = useGesture({
    onSwipeUp,
    onSwipeDown,
    onSwipeLeft,
    onSwipeRight,
    onPinchIn,
    onPinchOut,
  })

  const [isDesktop, setIsDesktop] = useState(typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT)

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const currentWs = workspaces.find((w) => w.ref === currentWorkspace)

  return (
    <div
      style={{
        display: 'flex',
        height: '100dvh',
        backgroundColor: '#1a1a2e',
        color: '#e0e0e0',
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
        onClose={() => setDrawerOpen(false)}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          marginLeft: isDesktop ? SIDEBAR_WIDTH : 0,
          transition: 'margin-left 0.2s ease-out',
          overflow: 'hidden',
        }}
      >
        <Header
          workspaceName={currentWs?.title ?? null}
          onMenuToggle={() => setDrawerOpen((o) => !o)}
          showMenuButton={!isDesktop}
          historyMode={historyMode}
          onToggleHistory={currentSurface && !isBrowserSurface ? () => setHistoryMode((h) => !h) : undefined}
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

        {isBrowserSurface ? (
          <BrowserView
            url={currentSurfaceInfo?.url ?? ''}
            title={currentSurfaceInfo?.title ?? ''}
            gestureRef={gestureRef}
          />
        ) : (
          <Terminal content={termContent} fontSize={fontSize} gestureRef={gestureRef} />
        )}

        <InputBar
          disabled={!currentSurface || isBrowserSurface}
          onSendText={(text) => {
            if (currentSurface) sendText(currentSurface, text).catch((err) => console.error('[app] send error:', err))
          }}
          onSendKey={(key) => {
            if (currentSurface) sendKey(currentSurface, key).catch((err) => console.error('[app] key error:', err))
          }}
        />

        <StatusBar
          status={status}
          paneName={currentSurfaceInfo?.title ?? currentSurface}
          paneIndex={surfaces.findIndex((s) => s.ref === currentSurface)}
          paneCount={surfaces.length}
          lastUpdated={lastUpdated}
          historyMode={historyMode}
        />
      </div>
    </div>
  )
}
