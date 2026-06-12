// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCmux } from '../useCmux'

// useWebSocket をモックし、send された payload を捕捉する。
// rpc が解決するよう、送信された各リクエストには成功レスポンスを即座にエコーバックする。
const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  onMessage: { fn: (_data: string) => {} },
}))

vi.mock('../useWebSocket', () => ({
  useWebSocket: ({ onMessage }: { onMessage: (data: string) => void }) => {
    hoisted.onMessage.fn = onMessage
    return {
      status: 'connected' as const,
      send: (data: string) => {
        hoisted.sent.push(data)
        const req = JSON.parse(data) as { id: string }
        hoisted.onMessage.fn(JSON.stringify({ id: req.id, ok: true, result: {} }))
      },
    }
  },
}))

describe('useCmux closeSurface', () => {
  beforeEach(() => {
    hoisted.sent.length = 0
  })

  it('surface.close を surface_id パラメータで送る（cmux ソケットは surface_ref ではなく surface_id を読む）', async () => {
    const { result } = renderHook(() => useCmux())

    await act(async () => {
      await result.current.closeSurface('surface:42')
    })

    const closeReq = hoisted.sent
      .map((raw) => JSON.parse(raw) as { method: string; params: Record<string, unknown> })
      .find((req) => req.method === 'surface.close')

    expect(closeReq).toBeDefined()
    expect(closeReq?.params).toEqual({ surface_id: 'surface:42' })
    expect(closeReq?.params).not.toHaveProperty('surface_ref')
  })
})
