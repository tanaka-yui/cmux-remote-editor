/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { createHandlerBoundToURL, type PrecacheEntry, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | PrecacheEntry)[] }

precacheAndRoute(self.__WB_MANIFEST)

// SPA フォールバック。ただし WebSocket ブリッジ(/ws)とヘルスチェック(/health)は横取りしない。
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/ws/, /^\/health/] }))

interface PushData {
  workspace_id?: string
  url?: string
}

interface PushPayload {
  title: string
  body: string
  data?: PushData
}

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return
  let payload: PushPayload
  try {
    payload = event.data.json() as PushPayload
  } catch {
    return
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.data?.workspace_id,
      data: payload.data ?? {},
    }),
  )
})

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  const data = (event.notification.data ?? {}) as PushData
  const workspaceId = data.workspace_id
  const targetUrl = data.url ?? '/'
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of allClients) {
        await client.focus()
        if (workspaceId) client.postMessage({ type: 'navigate', workspaceId })
        return
      }
      await self.clients.openWindow(targetUrl)
    })(),
  )
})

// registerType: 'autoUpdate' 相当の即時反映（injectManifest では自前で行う）。
self.skipWaiting()
clientsClaim()
