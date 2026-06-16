import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import webpush from 'web-push'

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

// VAPID 鍵を読み込み、無ければ生成して永続化する。公開鍵はクライアントへ配布、秘密鍵はサーバー保管。
export function loadOrCreateVapidKeys(file: string): VapidKeys {
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>
      if (parsed.publicKey && parsed.privateKey) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
      }
    } catch {
      // 破損時は下で再生成する（既存購読は無効化されるが MVP では許容）。
    }
  }
  const keys = webpush.generateVAPIDKeys()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 })
  return keys
}
