import { getAuthToken } from './token'

// Web Push の前提が揃っているか。iOS はホーム画面追加 PWA + 16.4+ + secure context が必須。
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// URL-safe base64 の VAPID 公開鍵を applicationServerKey 用の Uint8Array に変換する。
// 戻り値は ArrayBuffer 裏付けに固定する（BufferSource は ArrayBufferView<ArrayBuffer> を要求するため）。
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${getAuthToken()}` },
  })
}

// 通知許可を要求し PushManager で購読してサーバーへ登録する。許可が下りなければ false。
export async function subscribeToPush(): Promise<boolean> {
  if (!isPushSupported()) return false
  // iOS の DOMException は message が空で name にだけ種別が入ることが多い。どのステップで
  // どの種別の例外が出たかを message に畳み込んで投げ直し、画面のアラートで原因を特定できるようにする。
  let step = 'requestPermission'
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return false
    step = 'serviceWorker.ready'
    const reg = await navigator.serviceWorker.ready
    // VAPID 鍵がローテートされている(サーバー再生成等)と、古い applicationServerKey の購読が
    // 残ったままでは subscribe() が "different applicationServerKey already exists" で throw する。
    // 既存購読を掃除してから現行鍵で購読し直す(サーバーは現行の秘密鍵でしか送れないため再購読が正)。
    step = 'getSubscription/unsubscribe'
    const existing = await reg.pushManager.getSubscription()
    if (existing) await existing.unsubscribe()
    step = 'fetch vapid-public-key'
    const res = await authedFetch('/push/vapid-public-key')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { publicKey } = (await res.json()) as { publicKey?: string }
    if (!publicKey) throw new Error('publicKey が空')
    step = 'pushManager.subscribe'
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
    step = 'POST /push/subscribe'
    const subRes = await authedFetch('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    })
    if (!subRes.ok) throw new Error(`HTTP ${subRes.status}`)
    return true
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error'
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`[${step}] ${name}: ${msg}`)
  }
}

// サーバーから購読を削除し、ブラウザ側の購読も解除する。
export async function unsubscribeFromPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  await authedFetch('/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  })
  await sub.unsubscribe()
}

// 実際にブラウザ購読が存在するか（トグルの初期表示用）。
export async function isPushSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false
  const reg = await navigator.serviceWorker.ready
  return (await reg.pushManager.getSubscription()) !== null
}
