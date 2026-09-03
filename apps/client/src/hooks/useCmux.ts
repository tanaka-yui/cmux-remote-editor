import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import {
  type CmuxNotification,
  createRpcRequest,
  type Pane,
  parseRpcResponse,
  type Surface,
  type Workspace,
} from '../lib/cmux-rpc'
import type { RenderGrid } from '../lib/render-grid'
import type { RpcError } from '../lib/rpc-error'
import { resolveSelectedRef } from '../lib/selection'
import { loadSurfaceScreen } from '../lib/surface-cache'
import { getAuthToken } from '../lib/token'
import {
  createSwitcherReducer,
  MAX_LIVE_SUBSCRIPTIONS,
  type SurfaceLike,
  type SwitcherState,
  type TerminalFeed,
  TOPOLOGY_POLL_INTERVAL,
} from '../lib/view-state'
import { type ConnectionStatus, useWebSocket } from './useWebSocket'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RPC_TIMEOUT = 10_000

const isDocumentHidden = (): boolean => document.visibilityState === 'hidden'

export interface TopologySnapshot {
  generation: number
  surfaces: Surface[]
  workspaces: Workspace[]
}

export function useCmux() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [panes, setPanes] = useState<Pane[]>([])
  const [currentPane, setCurrentPane] = useState<string | null>(null)
  const [surfaces, setSurfaces] = useState<Surface[]>([])
  const [notifications, setNotifications] = useState<CmuxNotification[]>([])
  const [topologyReady, setTopologyReady] = useState(false)
  const pendingRef = useRef(new Map<string, PendingRequest>())
  const mountedRef = useRef(true)
  const bootstrappedRef = useRef(false)
  const inFlightRef = useRef(false)
  const dirtyRef = useRef(false)
  const generationRef = useRef(0)
  const requestSeqRef = useRef(0)
  const waitersRef = useRef<
    { seq: number; resolve: (snapshot: TopologySnapshot) => void; reject: (error: Error) => void }[]
  >([])
  const reducer = useMemo(() => createSwitcherReducer(loadSurfaceScreen), [])
  const [switcher, dispatch] = useReducer(
    reducer,
    undefined,
    (): SwitcherState => ({
      view: { subscriptions: [], foreground: null, foregroundWorkspaceRef: null },
      feeds: new Map<string, TerminalFeed>(),
    }),
  )

  // 前面を変える公開経路はこの 3 つだけ。focus / promote / initialize / reconcile は公開しない。
  const selectSurface = useCallback((surface: SurfaceLike) => {
    dispatch({ type: 'select', surface, now: Date.now(), cap: MAX_LIVE_SUBSCRIPTIONS })
  }, [])
  const initializeFrom = useCallback((surfaceList: readonly SurfaceLike[], preferredRef: string | null) => {
    bootstrappedRef.current = true
    dispatch({ type: 'initialize', surfaces: surfaceList, preferredRef, now: Date.now() })
  }, [])
  const reconcileWith = useCallback((surfaceList: readonly SurfaceLike[]) => {
    dispatch({ type: 'reconcile', surfaces: surfaceList, now: Date.now() })
  }, [])

  // 保持する state ではなく前面サーフェスからの導出値。
  const currentWorkspace = switcher.view.foregroundWorkspaceRef

  const rejectAllPending = useCallback((reason: string) => {
    for (const [, pending] of pendingRef.current) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    pendingRef.current.clear()
  }, [])

  const handleMessage = useCallback((data: string) => {
    try {
      const resp = parseRpcResponse(data)
      const pending = pendingRef.current.get(resp.id)
      if (pending) {
        clearTimeout(pending.timer)
        pendingRef.current.delete(resp.id)
        if (resp.error || resp.ok === false) {
          // cmux のエラー code を Error に載せる。App のポーリングが「閉じられた surface」
          // （invalid_params / not_found）を判別して surface 一覧を再取得するのに使う。
          const err = new Error(resp.error?.message ?? 'RPC failed (ok=false)') as RpcError
          if (resp.error?.code) err.code = resp.error.code
          pending.reject(err)
        } else {
          pending.resolve(resp.result)
        }
      }
    } catch (err) {
      console.error('[cmux] Failed to parse message:', err)
    }
  }, [])

  const wsUrl =
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws?token=${encodeURIComponent(getAuthToken())}`
      : 'ws://localhost:48701/ws'

  const handleClose = useCallback(() => {
    rejectAllPending('WebSocket disconnected')
  }, [rejectAllPending])

  const { status, send } = useWebSocket({
    url: wsUrl,
    onMessage: handleMessage,
    onClose: handleClose,
  })

  const rpc = useCallback(
    (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      return new Promise((resolve, reject) => {
        const req = createRpcRequest(method, params)
        const timer = setTimeout(() => {
          pendingRef.current.delete(req.id)
          reject(new Error(`RPC timeout: ${method}`))
        }, RPC_TIMEOUT)

        pendingRef.current.set(req.id, { resolve, reject, timer })
        if (!send(JSON.stringify(req))) {
          const pending = pendingRef.current.get(req.id)
          if (pending) {
            clearTimeout(pending.timer)
            pendingRef.current.delete(req.id)
            reject(new Error(`RPC failed: not connected (${method})`))
          }
        }
      })
    },
    [send],
  )

  useEffect(() => () => rejectAllPending('WebSocket unmounted'), [rejectAllPending])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const waiters = waitersRef.current
      waitersRef.current = []
      for (const waiter of waiters) waiter.reject(new Error('unmounted'))
    }
  }, [])

  const listWorkspaces = useCallback(async () => {
    const result = (await rpc('workspace.list')) as { workspaces: Workspace[] }
    const wsList = result.workspaces ?? []
    setWorkspaces(wsList)
    return wsList
  }, [rpc])

  const listPanes = useCallback(
    async (workspaceRef?: string) => {
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      const result = (await rpc('pane.list', params)) as { panes: Pane[] }
      const paneList = result.panes ?? []
      setPanes(paneList)
      setCurrentPane((prev) =>
        resolveSelectedRef(
          prev,
          paneList,
          (p) => p.selected_surface_ref,
          (p) => !!p.focused,
        ),
      )
      return paneList
    },
    [rpc],
  )

  // ---- 移行用 shim。Task 11 で削除する。新しいコードから使わないこと。----
  /** @deprecated Task 11 で削除。view.foreground を使う */
  const currentSurface = switcher.view.foreground
  /** @deprecated Task 11 で削除。selectSurface(surface) を使う */
  const focusSurface = useCallback(
    (ref: string) => {
      const surface = surfaces.find((s) => s.ref === ref)
      if (surface) selectSurface(surface)
    },
    [surfaces, selectSurface],
  )

  const listSurfaces = useCallback(async () => {
    const result = (await rpc('surface.list')) as { surfaces?: Surface[] }
    const list = result.surfaces ?? []
    setSurfaces(list)
    reconcileWith(list)
    return list
  }, [rpc, reconcileWith])

  const fetchTopology = useCallback(async (): Promise<{ surfaces: Surface[]; workspaces: Workspace[] }> => {
    const [surfaceResult, workspaceResult] = await Promise.allSettled([
      rpc('surface.list') as Promise<{ surfaces?: Surface[] }>,
      rpc('workspace.list') as Promise<{ workspaces?: Workspace[] }>,
    ])
    if (surfaceResult.status === 'rejected') throw surfaceResult.reason
    if (workspaceResult.status === 'rejected') throw workspaceResult.reason
    return {
      surfaces: surfaceResult.value.surfaces ?? [],
      workspaces: workspaceResult.value.workspaces ?? [],
    }
  }, [rpc])

  const runRefresh = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      for (;;) {
        if (document.visibilityState === 'hidden') {
          dirtyRef.current = true
          break
        }

        dirtyRef.current = false
        const servedUpTo = requestSeqRef.current
        let snapshot: { surfaces: Surface[]; workspaces: Workspace[] } | null = null
        let failure: Error | null = null
        try {
          snapshot = await fetchTopology()
        } catch (error) {
          failure = error instanceof Error ? error : new Error('topology refresh failed')
        }

        const waiting = waitersRef.current.filter((waiter) => waiter.seq <= servedUpTo)
        waitersRef.current = waitersRef.current.filter((waiter) => waiter.seq > servedUpTo)

        if (!mountedRef.current) {
          for (const waiter of waiting) waiter.reject(new Error('unmounted'))
          break
        }
        if (snapshot === null) {
          for (const waiter of waiting) waiter.reject(failure ?? new Error('topology refresh failed'))
        } else if (isDocumentHidden()) {
          for (const waiter of waiting) waiter.reject(new Error('topology refresh discarded (hidden)'))
        } else {
          generationRef.current += 1
          setSurfaces(snapshot.surfaces)
          setWorkspaces(snapshot.workspaces)
          if (bootstrappedRef.current) reconcileWith(snapshot.surfaces)
          setTopologyReady(true)
          const applied: TopologySnapshot = { generation: generationRef.current, ...snapshot }
          for (const waiter of waiting) waiter.resolve(applied)
        }

        if (!dirtyRef.current) break
      }
    } finally {
      inFlightRef.current = false
    }
  }, [fetchTopology, reconcileWith])

  const requestTopologyRefresh = useCallback((): Promise<TopologySnapshot> => {
    const seq = ++requestSeqRef.current
    const promise = new Promise<TopologySnapshot>((resolve, reject) => {
      waitersRef.current.push({ seq, resolve, reject })
    })
    dirtyRef.current = true
    if (document.visibilityState !== 'hidden') void runRefresh()
    return promise
  }, [runRefresh])

  useEffect(() => {
    if (status !== 'connected') return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const arm = (delay: number) => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void tick(), delay)
    }
    const tick = async () => {
      if (stopped || document.visibilityState === 'hidden') return
      await requestTopologyRefresh().catch(() => undefined)
      if (!isDocumentHidden()) arm(TOPOLOGY_POLL_INTERVAL)
    }
    const onVisibility = () => {
      if (stopped) return
      if (document.visibilityState === 'hidden') {
        if (timer) clearTimeout(timer)
        timer = undefined
        return
      }
      arm(0)
    }

    void tick()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
  }, [status, requestTopologyRefresh])

  const createSurface = useCallback(
    async (workspaceId: string): Promise<{ list: Surface[]; misplaced: boolean }> => {
      // workspace_ref は無視される。workspace_id（UUID）だけが作成先指定に使われる。
      const created = (await rpc('surface.create', { workspace_id: workspaceId })) as {
        surface_ref?: string
        workspace_id?: string
      }
      // 無効な UUID はエラーではなく選択中 WS への作成になる。端末は残し、誤配置だけ返す。
      const misplaced = created.workspace_id !== undefined && created.workspace_id !== workspaceId
      const snapshot = await requestTopologyRefresh().catch(() => null)
      const list = snapshot?.surfaces ?? surfaces
      const surface = snapshot?.surfaces.find((candidate) => candidate.ref === created.surface_ref)
      if (surface) selectSurface(surface)
      return { list, misplaced }
    },
    [rpc, requestTopologyRefresh, selectSurface, surfaces],
  )

  const createWorkspace = useCallback(async () => {
    // workspace.create 自体が既定 terminal を作るため、surface.create は重ねて呼ばない。
    const created = (await rpc('workspace.create')) as { surface_ref?: string }
    const snapshot = await requestTopologyRefresh().catch(() => null)
    const list = snapshot?.surfaces ?? surfaces
    const surface = snapshot?.surfaces.find((candidate) => candidate.ref === created.surface_ref)
    if (surface) selectSurface(surface)
    return list
  }, [rpc, requestTopologyRefresh, selectSurface, surfaces])

  const closeSurface = useCallback(
    async (surfaceRef: string) => {
      // cmux ソケットの surface.close は `surface_id` を読む（`surface_ref` は無視され
      // フォーカス中のサーフェスにフォールバックする）。値は短縮 ref で受理される。
      await rpc('surface.close', { surface_id: surfaceRef })
      const snapshot = await requestTopologyRefresh().catch(() => null)
      return snapshot?.surfaces ?? surfaces
    },
    [rpc, requestTopologyRefresh, surfaces],
  )

  const closeWorkspace = useCallback(
    async (workspaceRef: string) => {
      // cmux ソケットの workspace.close は `workspace_id` を読む（`workspace_ref` は無視）。
      await rpc('workspace.close', { workspace_id: workspaceRef })
      const snapshot = await requestTopologyRefresh().catch(() => null)
      return snapshot?.workspaces ?? workspaces
    },
    [rpc, requestTopologyRefresh, workspaces],
  )

  const readText = useCallback(
    async (surfaceRef?: string, opts?: { scrollback?: boolean; lines?: number }): Promise<string> => {
      const params: Record<string, unknown> = {}
      // cmux ソケットは surface_id を読む。surface_ref は無視され、フォーカス中の
      // サーフェスへフォールバックするため、タブを切り替えても表示が変わらなくなる。
      if (surfaceRef) params.surface_id = surfaceRef
      // scrollback/lines は ws.ts が surface.read_text を素通しするためサーバー変更なしで cmux に届く。
      if (opts?.scrollback) params.scrollback = true
      if (opts?.lines !== undefined) params.lines = opts.lines
      const result = (await rpc('surface.read_text', params)) as { text: string }
      return result.text ?? ''
    },
    [rpc],
  )

  const readGrid = useCallback(
    async (surfaceRef?: string): Promise<RenderGrid | null> => {
      // terminal.replay は render_grid（色/属性/カーソル付きグリッド）を返す。read_text と
      // 同じく surface_id を読む（surface_ref はフォーカス中へフォールバックする）。
      const params: Record<string, unknown> = {}
      if (surfaceRef) params.surface_id = surfaceRef
      const result = (await rpc('terminal.replay', params)) as { render_grid?: RenderGrid | null }
      // タブだけ開いて zsh が起動していない停止端末では render_grid が欠落し得る。null へ正規化して
      // 呼び出し側（Terminal の useGrid 判定）が「グリッド無し」として扱えるようにする（undefined だと
      // useGrid の `!= null` 判定をすり抜けないが、型・実値の両面で null に揃えて安全側に倒す）。
      return result.render_grid ?? null
    },
    [rpc],
  )

  const sendText = useCallback(
    async (surfaceRef: string, text: string) => {
      // surface_id 指定（surface_ref は無視されフォーカス中サーフェスに入力されてしまう）。
      await rpc('surface.send_text', { surface_id: surfaceRef, text })
    },
    [rpc],
  )

  const sendKey = useCallback(
    async (surfaceRef: string, key: string) => {
      await rpc('surface.send_key', { surface_id: surfaceRef, key })
    },
    [rpc],
  )

  const getTree = useCallback(async () => {
    return await rpc('system.tree')
  }, [rpc])

  const listNotifications = useCallback(async () => {
    const result = (await rpc('notification.list')) as { notifications: CmuxNotification[] }
    const list = result.notifications ?? []
    setNotifications(list)
    return list
  }, [rpc])

  const navigatePane = useCallback(
    async (direction: 'next' | 'prev') => {
      if (panes.length === 0) return
      const idx = panes.findIndex((p) => p.selected_surface_ref === currentPane)
      const nextIdx = direction === 'next' ? (idx + 1) % panes.length : (idx - 1 + panes.length) % panes.length
      const target = panes[nextIdx]
      if (target) await focusSurface(target.selected_surface_ref)
    },
    [panes, currentPane, focusSurface],
  )

  const navigateSurface = useCallback(
    async (direction: 'next' | 'prev') => {
      if (surfaces.length === 0) return
      const idx = surfaces.findIndex((s) => s.ref === currentSurface)
      const nextIdx = direction === 'next' ? (idx + 1) % surfaces.length : (idx - 1 + surfaces.length) % surfaces.length
      const target = surfaces[nextIdx]
      if (target) await focusSurface(target.ref)
    },
    [surfaces, currentSurface, focusSurface],
  )

  return {
    status: status as ConnectionStatus,
    topologyReady,
    workspaces,
    currentWorkspace,
    panes,
    currentPane,
    surfaces,
    currentSurface,
    notifications,
    view: switcher.view,
    feeds: switcher.feeds,
    selectSurface,
    initializeFrom,
    reconcileWith,
    requestTopologyRefresh,
    listWorkspaces,
    createWorkspace,
    listPanes,
    listSurfaces,
    createSurface,
    closeSurface,
    closeWorkspace,
    focusSurface,
    readText,
    readGrid,
    sendText,
    sendKey,
    getTree,
    listNotifications,
    navigatePane,
    navigateSurface,
  }
}
