import { useCallback, useRef, useState } from 'react'

import {
  type CmuxNotification,
  createRpcRequest,
  type Pane,
  parseRpcResponse,
  type Surface,
  type Workspace,
} from '../lib/cmux-rpc'
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
          pending.reject(new Error(resp.error?.message ?? 'RPC failed (ok=false)'))
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

  const selectWorkspace = useCallback(async (ref: string) => {
    // PWA側の表示切替のみ。ローカルcmuxのフォーカスは変更しない。
    setCurrentWorkspace(ref)
  }, [])

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
      const params: Record<string, unknown> = {}
      if (workspaceRef) params.workspace_ref = workspaceRef
      await rpc('surface.create', params)
      return listSurfaces(workspaceRef)
    },
    [rpc, listSurfaces],
  )

  const closeSurface = useCallback(
    async (surfaceRef: string, workspaceRef?: string) => {
      await rpc('surface.close', { surface_ref: surfaceRef })
      return listSurfaces(workspaceRef)
    },
    [rpc, listSurfaces],
  )

  const readText = useCallback(
    async (surfaceRef?: string): Promise<string> => {
      const params: Record<string, unknown> = {}
      if (surfaceRef) params.surface_ref = surfaceRef
      const result = (await rpc('surface.read_text', params)) as { text: string }
      return result.text ?? ''
    },
    [rpc],
  )

  const sendText = useCallback(
    async (surfaceRef: string, text: string) => {
      await rpc('surface.send_text', { surface_ref: surfaceRef, text })
    },
    [rpc],
  )

  const sendKey = useCallback(
    async (surfaceRef: string, key: string) => {
      await rpc('surface.send_key', { surface_ref: surfaceRef, key })
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
    listPanes,
    listSurfaces,
    createSurface,
    closeSurface,
    focusSurface,
    readText,
    sendText,
    sendKey,
    getTree,
    listNotifications,
    navigateWorkspace,
    navigatePane,
    navigateSurface,
  }
}
