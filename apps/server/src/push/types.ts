// cmux の通知（notification.list の要素）。client 側 cmux-rpc.ts の CmuxNotification と同形。
export interface CmuxNotification {
  id: string
  title: string
  subtitle: string
  body: string
  workspace_id: string
  surface_id: string
  is_read: boolean
}

// ブラウザの PushSubscription.toJSON() と同形。store/送信で扱う。
export interface PushSubscriptionJSON {
  endpoint: string
  expirationTime: number | null
  keys: { p256dh: string; auth: string }
}
