import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { join } from 'path'

import { loadOrCreateToken, tokenEquals } from './auth'
import { health } from './health'
import { loadTlsOptions } from './tls'
import { createWebSocketHandler, type WSData } from './ws'

const app = new Hono()
const port = parseInt(process.env.PORT ?? '48701', 10)
// Bind to loopback by default so the bridge is not reachable from the LAN — only
// the local host (and the Docker VM's host.docker.internal forwarder) should hit
// it. Override with CMUX_BIND_HOST=0.0.0.0 if the container cannot reach loopback.
const hostname = process.env.CMUX_BIND_HOST ?? '127.0.0.1'
// TLS is enabled in production (CMUX_REMOTE_TLS) so the nginx→Bun hop is encrypted.
const tls = loadTlsOptions()
const authToken = loadOrCreateToken()
const clientDistPath = join(import.meta.dir, '../../client/dist')

// Health check
app.route('/', health)

// Static files (PWA)
app.use('/*', serveStatic({ root: clientDistPath }))

const wsHandler = createWebSocketHandler()

const server = Bun.serve({
  port,
  hostname,
  tls,
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade. Token required: the server listens on the LAN and
    // cmux runs in allowAll, so /ws without auth would let any network peer
    // run arbitrary commands via surface.send_text.
    if (url.pathname === '/ws') {
      if (!tokenEquals(authToken, url.searchParams.get('token'))) {
        return new Response('Unauthorized', { status: 401 })
      }
      const initialData: WSData = { socket: null, ready: false, messageBuffer: [] }
      const upgraded = server.upgrade(req, { data: initialData })
      if (upgraded) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    // Hono handles the rest
    return app.fetch(req, server)
  },
  websocket: wsHandler,
})

console.log(`[server] cmux-remote bridge running on ${tls ? 'https' : 'http'}://${hostname}:${server.port}`)
console.log(`[server] auth token: ${authToken}`)
console.log(
  '[server] first connect: open the PWA with ?token=<auth token> appended to its URL (the app stores it afterwards)',
)
