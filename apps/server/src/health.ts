import { Hono } from 'hono'

import { CmuxClient } from './cmux-client'

const health = new Hono()

// Reuse one cmux connection across health checks instead of opening and
// closing a socket per request (connection churn on the cmux side when /health
// is polled). Concurrent checks share the in-flight connect; if cmux restarts,
// the socket's close handler resets the client and the next check reconnects.
const client = new CmuxClient()
let connecting: Promise<boolean> | null = null

function checkCmux(): Promise<boolean> {
  if (client.isConnected) return Promise.resolve(true)
  connecting ??= client
    .connect()
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      connecting = null
    })
  return connecting
}

health.get('/health', async (c) => {
  const cmuxAvailable = await checkCmux()

  return c.json({
    status: 'ok',
    cmux: cmuxAvailable ? 'connected' : 'disconnected',
    uptime: process.uptime(),
  })
})

export { health }
