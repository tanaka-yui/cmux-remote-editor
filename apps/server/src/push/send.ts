import webpush from 'web-push'
import type { PushStore } from './store'
import type { PushSubscriptionJSON } from './types'

interface SendResult {
  statusCode: number
  body: string
  headers: Record<string, string>
}

type SendFn = (sub: PushSubscriptionJSON, payload: string) => Promise<SendResult>

export interface Sender {
  sendToAll(payload: string): Promise<void>
}

// 全購読へ payload を送信する。送信関数は注入可能（テスト用）。VAPID は index.ts で
// setVapidDetails 済み。endpoint が失効(410/404)した購読は store から取り除く。
export function createSender(store: PushStore, send: SendFn = defaultSend): Sender {
  return {
    async sendToAll(payload) {
      await Promise.all(
        store.listSubscriptions().map(async (sub) => {
          try {
            await send(sub, payload)
          } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode
            if (statusCode === 410 || statusCode === 404) {
              store.removeSubscription(sub.endpoint)
            } else {
              console.error('[push] send error:', statusCode ?? (err as Error).message ?? err)
            }
          }
        }),
      )
    },
  }
}

function defaultSend(sub: PushSubscriptionJSON, payload: string): Promise<SendResult> {
  return webpush.sendNotification(sub, payload) as Promise<SendResult>
}
