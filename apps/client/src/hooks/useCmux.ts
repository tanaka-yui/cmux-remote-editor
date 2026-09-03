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
} from '../lib/view-state'
import { type ConnectionStatus, useWebSocket } from './useWebSocket'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RPC_TIMEOUT = 10_000

export function useCmux() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [panes, setPanes] = useState<Pane[]>([])
  const [currentPane, setCurrentPane] = useState<string | null>(null)
  const [surfaces, setSurfaces] = useState<Surface[]>([])
  const [notifications, setNotifications] = useState<CmuxNotification[]>([])
  const pendingRef = useRef(new Map<string, PendingRequest>())
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

  const createSurface = useCallback(
    async (workspaceId: string): Promise<{ list: Surface[]; misplaced: boolean }> => {
      // workspace_ref は無視される。workspace_id（UUID）だけが作成先指定に使われる。
      const created = (await rpc('surface.create', { workspace_id: workspaceId })) as {
        surface_ref?: string
        workspace_id?: string
      }
      // 無効な UUID はエラーではなく選択中 WS への作成になる。端末は残し、誤配置だけ返す。
      const misplaced = created.workspace_id !== undefined && created.workspace_id !== workspaceId
      const list = await listSurfaces()
      const surface = list.find((candidate) => candidate.ref === created.surface_ref)
      if (surface) selectSurface(surface)
      return { list, misplaced }
    },
    [rpc, listSurfaces, selectSurface],
  )

  const createWorkspace = useCallback(async () => {
    // workspace.create 自体が既定 terminal を作るため、surface.create は重ねて呼ばない。
    const created = (await rpc('workspace.create')) as { surface_ref?: string }
    const [list] = await Promise.all([listSurfaces(), listWorkspaces()])
    const surface = list.find((candidate) => candidate.ref === created.surface_ref)
    if (surface) selectSurface(surface)
    return list
  }, [rpc, listSurfaces, listWorkspaces, selectSurface])

  const closeSurface = useCallback(
    async (surfaceRef: string) => {
      // cmux ソケットの surface.close は `surface_id` を読む（`surface_ref` は無視され
      // フォーカス中のサーフェスにフォールバックする）。値は短縮 ref で受理される。
      await rpc('surface.close', { surface_id: surfaceRef })
      return listSurfaces()
    },
    [rpc, listSurfaces],
  )

  const closeWorkspace = useCallback(
    async (workspaceRef: string) => {
      // cmux ソケットの workspace.close は `workspace_id` を読む（`workspace_ref` は無視）。
      await rpc('workspace.close', { workspace_id: workspaceRef })
      const [, wsList] = await Promise.all([listSurfaces(), listWorkspaces()])
      return wsList
    },
    [rpc, listSurfaces, listWorkspaces],
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
