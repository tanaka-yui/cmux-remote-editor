import { Hono } from 'hono'
import { tokenEquals } from '../auth'
import type { PushStore } from './store'

interface SubscribeBody {
  endpoint?: string
  expirationTime?: number | null
  keys?: { p256dh?: string; auth?: string }
}

interface UnsubscribeBody {
  endpoint?: string
}

// push 購読エンドポイント。全て共有トークン(Authorization: Bearer)で保護する。
export function createPushRoutes(opts: {
  store: PushStore
  vapidPublicKey: string
  authToken: string
  onChange: () => void
}): Hono {
  const app = new Hono()

  app.use('/push/*', async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!tokenEquals(opts.authToken, token)) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  })

  app.get('/push/vapid-public-key', (c) => c.json({ publicKey: opts.vapidPublicKey }))

  app.post('/push/subscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SubscribeBody
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return c.json({ error: 'Invalid subscription' }, 400)
    }
    opts.store.addSubscription({
      endpoint: body.endpoint,
      expirationTime: body.expirationTime ?? null,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    })
    opts.onChange()
    return c.json({ ok: true })
  })

  app.post('/push/unsubscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as UnsubscribeBody
    if (!body.endpoint) return c.json({ error: 'Invalid request' }, 400)
    opts.store.removeSubscription(body.endpoint)
    opts.onChange()
    return c.json({ ok: true })
  })

  return app
}
