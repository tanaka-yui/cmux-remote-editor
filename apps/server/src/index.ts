import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { join } from 'path'
import webpush from 'web-push'

import { loadOrCreateToken, tokenEquals } from './auth'
import { health } from './health'
import { createPoller } from './push/poller'
import { createPushRoutes } from './push/routes'
import { createSender } from './push/send'
import { createPushStore } from './push/store'
import { loadOrCreateVapidKeys } from './push/vapid'
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

// Web Push: VAPID 鍵を読み込み(無ければ生成)、送信ライブラリに設定。購読ストアと、
// WS 接続の有無に依らず動くバックグラウンドポーラー(購読が 1 件以上ある時のみ稼働)を用意する。
const runDir = join(import.meta.dir, '../.run')
const vapidKeys = loadOrCreateVapidKeys(join(runDir, 'push-vapid.json'))
webpush.setVapidDetails(
  process.env.CMUX_PUSH_SUBJECT ?? 'mailto:cmux-remote@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey,
)
const pushStore = createPushStore(runDir)
const pushSender = createSender(pushStore)
const pushPoller = createPoller({
  store: pushStore,
  sender: pushSender,
  pollMs: parseInt(process.env.CMUX_PUSH_POLL_MS ?? '10000', 10),
})
const pushRoutes = createPushRoutes({
  store: pushStore,
  vapidPublicKey: vapidKeys.publicKey,
  authToken,
  onChange: () => pushPoller.refresh(),
})

// Health check
app.route('/', health)

// Web Push 購読エンドポイント（静的配信のフォールバックより前に登録する）。
app.route('/', pushRoutes)

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

// 既に購読が永続化されていれば(再起動後など)ポーラーを起動する。
pushPoller.refresh()
