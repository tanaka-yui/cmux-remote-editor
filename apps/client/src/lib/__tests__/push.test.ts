import { describe, expect, it } from 'vitest'
import { urlBase64ToUint8Array } from '../push'

describe('urlBase64ToUint8Array', () => {
  it('VAPID 公開鍵(URL-safe base64)を 65 byte の Uint8Array にデコードする', () => {
    const key = 'BGtkbcjrO12YMoDuq2sCQeHlu47uPx3SHTgFKZFYiBW8Qr0D9vgyZSZPdw6_4ZFEI9Snk1VEAj2qTYI1I1YxBXE'
    const out = urlBase64ToUint8Array(key)
    expect(out).toBeInstanceOf(Uint8Array)
    // P-256 の非圧縮公開鍵は 65 byte、先頭は 0x04。
    expect(out.length).toBe(65)
    expect(out[0]).toBe(0x04)
  })

  it('- と _ を + と / に変換する', () => {
    // '-' (0x3e=62) と '_' (0x3f=63) を含む 4 文字 = 3 byte
    const out = urlBase64ToUint8Array('-_-_')
    expect(Array.from(out)).toEqual([0xfb, 0xff, 0xbf])
  })
})
