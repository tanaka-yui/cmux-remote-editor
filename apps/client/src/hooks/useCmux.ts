import { useCallback, useRef, useState } from 'react'

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
import { getAuthToken } from '../lib/token'
import { type ConnectionStatus, useWebSocket } from './useWebSocket'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RPC_TIMEOUT = 10_000

export function useCmux() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [currentWorkspace, setCurrentWorkspace] = useState<string | null>(null)
  const [panes, setPanes] = useState<Pane[]>([])
  const [currentPane, setCurrentPane] = useState<string | null>(null)
  const [surfaces, setSurfaces] = useState<Surface[]>([])
  const [currentSurface, setCurrentSurface] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<CmuxNotification[]>([])
  const pendingRef = useRef(new Map<string, PendingRequest>())

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

  const { status, send } = useWebSocket({
    url: wsUrl,
    onMessage: handleMessage,
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
        send(JSON.stringify(req))
      })
    },
    [send],
  )

  const listWorkspaces = useCallback(async () => {
    const result = (await rpc('workspace.list')) as { workspaces: Workspace[] }
    const wsList = result.workspaces ?? []
    setWorkspaces(wsList)
    setCurrentWorkspace((prev) =>
      resolveSelectedRef(
        prev,
        wsList,
        (w) => w.ref,
        (w) => !!w.selected,
      ),
    )
    return wsList
  }, [rpc])

  const selectWorkspace = useCallback(
    (ref: string) => {
      if (ref === currentWorkspace) return
      // cmux は選択中ワークスペース以外のターミナルを読めない（surface.read_text が
      // internal_error を返す）ため、cmux 側のワークスペースも追従して切り替える。
      // タブ選択は PWA 側のみで、ローカルのペインフォーカスは奪わない。
      rpc('workspace.select', { workspace_id: ref }).catch((err) =>
        console.error('[cmux] workspace.select error:', err),
      )
      // 前ワークスペースの surfaces/pane 状態を即座に空へリセットする。これをしないと、
      // 新ワークスペースの surface.list が非同期で解決するまで（失敗時は恒久的に）
      // 前ワークスペースのタブ・ターミナル内容が残って見えてしまう。
      setCurrentWorkspace(ref)
      setSurfaces([])
      setCurrentSurface(null)
      setPanes([])
      setCurrentPane(null)
    },
    [currentWorkspace, rpc],
  )

  const createWorkspace = useCallback(async () => {
    // workspace.create は ws.ts が透過中継する。空パラメータで既定ディレクトリの新規WS
    // (+ターミナル surface 1つ)を作る。cmux 側は新WSを自動選択しないため、返り値の
    // workspace_ref を既存 selectWorkspace で追従選択する(非選択WSは read_text 不可)。
    const result = (await rpc('workspace.create')) as { workspace_ref?: string }
    const list = await listWorkspaces()
    if (result.workspace_ref) selectWorkspace(result.workspace_ref)
    return list
  }, [rpc, listWorkspaces, selectWorkspace])

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

  // Switching tabs in the remote viewer only changes which surface we poll via
  // read-screen --surface; it does not steal focus in the local cmux. This keeps
  // switching instant and independent of the (unreliable) surface.focus RPC.
  const focusSurface = useCallback((surfaceRef: string) => {
    setCurrentSurface(surfaceRef)
    setCurrentPane(surfaceRef)
  }, [])

  const listSurfaces = useCallback(
    async (workspaceRef?: string) => {
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      const result = (await rpc('surface.list', params)) as { surfaces?: Surface[] }
      const list = result.surfaces ?? []
      setSurfaces(list)
      // アプリ側の選択を優先し、cmux の selected には初回のみ追従する。
      // 選択中サーフェスがリモートで閉じられたら先頭へ退避する。
      setCurrentSurface((prev) =>
        resolveSelectedRef(
          prev,
          list,
          (s) => s.ref,
          (s) => s.selected,
        ),
      )
      return list
    },
    [rpc],
  )

  const createSurface = useCallback(
    async (workspaceRef?: string) => {
      const beforeRefs = new Set(surfaces.map((s) => s.ref))
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      await rpc('surface.create', params)
      const list = await listSurfaces(workspaceRef)
      // 新規作成したサーフェスへ明示的に切り替える。listSurfaces はアプリ優先で既存の
      // 選択(prev)を維持するため、これがないと新タブが作られても表示が切り替わらず、
      // タブ据え置きのまま中身だけ入れ替わったように見えてしまう。作成前後の差分で
      // 新 ref を特定する（selected フラグはマルチペインで複数 true になり得るため）。
      const created = list.find((s) => !beforeRefs.has(s.ref))
      if (created) focusSurface(created.ref)
      return list
    },
    [rpc, listSurfaces, focusSurface, surfaces],
  )

  const closeSurface = useCallback(
    async (surfaceRef: string, workspaceRef?: string) => {
      // cmux ソケットの surface.close は `surface_id` を読む（`surface_ref` は無視され
      // フォーカス中のサーフェスにフォールバックする）。値は短縮 ref で受理される。
      await rpc('surface.close', { surface_id: surfaceRef })
      return listSurfaces(workspaceRef)
    },
    [rpc, listSurfaces],
  )

  const closeWorkspace = useCallback(
    async (workspaceRef: string) => {
      // cmux ソケットの workspace.close は `workspace_id` を読む（`workspace_ref` は無視）。
      // 値は workspace.select と同じく短縮 ref を受理する（実機プローブで確認）。
      await rpc('workspace.close', { workspace_id: workspaceRef })
      // 現在のワークスペースを閉じた場合、フォールバックが確定するまで旧 WS のタブ・
      // ターミナル内容が残らないよう即座にクリアする（selectWorkspace と同じ理由）。
      if (workspaceRef === currentWorkspace) {
        setSurfaces([])
        setCurrentSurface(null)
        setPanes([])
        setCurrentPane(null)
      }
      // listWorkspaces → resolveSelectedRef が、閉じた WS が現在だった場合は cmux が
      // auto-select した別 WS（無ければ先頭）へ、非現在なら現在維持でフォールバックする。
      return listWorkspaces()
    },
    [rpc, listWorkspaces, currentWorkspace],
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
    async (surfaceRef?: string): Promise<RenderGrid> => {
      // terminal.replay は render_grid（色/属性/カーソル付きグリッド）を返す。read_text と
      // 同じく surface_id を読む（surface_ref はフォーカス中へフォールバックする）。
      const params: Record<string, unknown> = {}
      if (surfaceRef) params.surface_id = surfaceRef
      const result = (await rpc('terminal.replay', params)) as { render_grid: RenderGrid }
      return result.render_grid
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

  const navigateWorkspace = useCallback(
    async (direction: 'next' | 'prev') => {
      if (workspaces.length === 0) return
      const idx = workspaces.findIndex((w) => w.ref === currentWorkspace)
      const nextIdx =
        direction === 'next' ? (idx + 1) % workspaces.length : (idx - 1 + workspaces.length) % workspaces.length
      const target = workspaces[nextIdx]
      if (target) await selectWorkspace(target.ref)
    },
    [workspaces, currentWorkspace, selectWorkspace],
  )

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
    listWorkspaces,
    selectWorkspace,
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
    navigateWorkspace,
    navigatePane,
    navigateSurface,
  }
}
