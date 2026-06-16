import type { ServerWebSocket } from 'bun'
import { createLineFramer } from './line-framer'
import { resolveCmuxSocketPath } from './socket-path'

// 行フレーマは line-framer.ts へ抽出した。push ポーラー(push/rpc-connection.ts)と共用する。
// 既存の importer（ws.test.ts）のため、ここでも再エクスポートする。
export { createLineFramer }

interface TreeSurface {
  ref: string
  selected?: boolean
  title?: string
  type?: string
  // Populated for browser surfaces (null for terminals); the PWA renders it in an iframe.
  url?: string | null
}

interface TreePane {
  ref: string
  surfaces?: TreeSurface[]
}

interface TreeWorkspace {
  ref: string
  panes?: TreePane[]
}

interface TreeWindow {
  workspaces?: TreeWorkspace[]
}

interface CmuxTree {
  windows?: TreeWindow[]
}

export interface FlatSurface {
  index: number
  ref: string
  selected: boolean
  title: string
  type: string
  pane_ref: string
  // null for terminals; the browser surface's current URL otherwise.
  url: string | null
}

// Walk the cmux tree and flatten every surface across all panes of the target
// workspace into a single ordered list (split panes included).
export function flattenSurfaces(tree: CmuxTree, workspaceRef?: string): FlatSurface[] {
  const out: FlatSurface[] = []
  for (const win of tree.windows ?? []) {
    for (const ws of win.workspaces ?? []) {
      if (workspaceRef && ws.ref !== workspaceRef) continue
      for (const pane of ws.panes ?? []) {
        for (const surface of pane.surfaces ?? []) {
          out.push({
            index: out.length,
            ref: surface.ref,
            selected: Boolean(surface.selected),
            title: surface.title ?? surface.ref,
            type: surface.type ?? 'terminal',
            pane_ref: pane.ref,
            url: surface.url ?? null,
          })
        }
      }
    }
  }
  return out
}

interface RpcRequestLike {
  id: string
  method: string
  params?: Record<string, unknown>
}

interface RewrittenRequest {
  wire: Record<string, unknown>
  // True when the socket response must be flattened back into { surfaces }.
  expectList: boolean
  workspaceRef?: string
}

// Translate the client RPCs that the old CLI path special-cased into plain
// socket RPCs:
//   - surface.list must be served from system.tree, because the socket's own
//     surface.list ignores workspace_ref and only returns the locally-focused
//     workspace. The tree response is flattened + filtered back into { surfaces }.
//   - surface.create keeps the type/focus defaults the CLI used to inject.
// Every other method passes straight through to the socket untouched.
export function rewriteRequest(req: RpcRequestLike): RewrittenRequest {
  const params = req.params ?? {}

  if (req.method === 'surface.list') {
    const workspaceRef = typeof params.workspace_ref === 'string' ? params.workspace_ref : undefined
    return {
      wire: { id: req.id, method: 'system.tree', params: {} },
      expectList: true,
      workspaceRef,
    }
  }

  if (req.method === 'surface.create') {
    return {
      wire: { id: req.id, method: 'surface.create', params: { type: 'terminal', focus: true, ...params } },
      expectList: false,
    }
  }

  return { wire: { id: req.id, method: req.method, params }, expectList: false }
}

interface CmuxResponseLine {
  id?: string
  ok?: boolean
  error?: { code?: string; message?: string }
  result?: CmuxTree
}

export interface WSData {
  socket: WebSocket | null
  ready: boolean
  messageBuffer: string[]
}

function connectCmuxSocket(ws: ServerWebSocket<WSData>) {
  const socketPath = resolveCmuxSocketPath()
  const { Socket } = require('net')
  const sock = new Socket()

  // surface.list is served from system.tree; remember the requested workspace_ref
  // (keyed by request id) so the tree response can be flattened + filtered back
  // into the { surfaces } shape the client expects.
  const pendingList = new Map<string, string | undefined>()

  function relay(raw: string) {
    let req: RpcRequestLike
    try {
      req = JSON.parse(raw)
    } catch {
      sock.write(raw + '\n')
      return
    }
    const { wire, expectList, workspaceRef } = rewriteRequest(req)
    if (expectList) pendingList.set(req.id, workspaceRef)
    sock.write(JSON.stringify(wire) + '\n')
  }

  const framer = createLineFramer()
  sock.on('data', (data: Buffer) => {
    for (const line of framer.push(data)) {
      let parsed: CmuxResponseLine | null = null
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = null
      }

      // Reshape surface.list (served via system.tree) back into { surfaces }.
      if (parsed && parsed.id != null && pendingList.has(parsed.id)) {
        const workspaceRef = pendingList.get(parsed.id)
        pendingList.delete(parsed.id)
        if (parsed.ok === false || parsed.error) {
          try {
            ws.send(line)
          } catch {}
        } else {
          const surfaces = flattenSurfaces(parsed.result ?? {}, workspaceRef)
          try {
            ws.send(JSON.stringify({ id: parsed.id, ok: true, result: { surfaces } }))
          } catch {}
        }
        continue
      }

      try {
        ws.send(line)
      } catch {}
    }
  })

  sock.on('error', (err: Error) => {
    console.error('[cmux-socket] Error:', err.message)
  })

  sock.on('close', () => {
    console.log('[cmux-socket] Closed')
    // Propagate the loss to the browser: closing the WS triggers the client's
    // reconnect/backoff instead of leaving a "Connected" UI whose RPCs all
    // time out (and the pre-connect messageBuffer from growing unbounded).
    try {
      ws.close(1011, 'cmux socket closed')
    } catch {}
  })

  sock.connect(socketPath, () => {
    console.log('[cmux-socket] Connected')
    ws.data.ready = true
    for (const msg of ws.data.messageBuffer) {
      relay(msg)
    }
    ws.data.messageBuffer = []
  })

  return {
    send(msg: string) {
      relay(msg)
    },
    close() {
      sock.destroy()
    },
  }
}

export function createWebSocketHandler() {
  const sockets = new WeakMap<ServerWebSocket<WSData>, ReturnType<typeof connectCmuxSocket>>()

  return {
    open(ws: ServerWebSocket<WSData>) {
      console.log('[ws] Client connected')
      ws.data = { socket: null, ready: false, messageBuffer: [] }
      const cmux = connectCmuxSocket(ws)
      sockets.set(ws, cmux)
    },

    message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
      const msg = typeof message === 'string' ? message : message.toString()

      // Ignore non-JSON frames outright.
      try {
        JSON.parse(msg)
      } catch {
        return
      }

      const cmux = sockets.get(ws)
      if (!cmux) return

      if (!ws.data.ready) {
        ws.data.messageBuffer.push(msg)
        return
      }

      cmux.send(msg)
    },

    close(ws: ServerWebSocket<WSData>, code: number, reason: string) {
      console.log(`[ws] Client disconnected: ${code} ${reason}`)
      sockets.get(ws)?.close()
    },
  }
}
