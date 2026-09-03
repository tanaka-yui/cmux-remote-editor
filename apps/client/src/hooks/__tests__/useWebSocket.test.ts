// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useWebSocket } from '../useWebSocket'

interface MockWebSocketInstance {
  readyState: number
  sent: string[]
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  onerror: ((event: Event) => void) | null
  send: (data: string) => void
  close: () => void
}

function MockWebSocket(this: MockWebSocketInstance, _url: string) {
  this.readyState = MockWebSocket.CONNECTING
  this.sent = []
  this.onopen = null
  this.onmessage = null
  this.onclose = null
  this.onerror = null
  this.send = (data: string) => {
    this.sent.push(data)
  }
  this.close = () => {}
  sockets.push(this)
}

MockWebSocket.CONNECTING = 0
MockWebSocket.OPEN = 1
MockWebSocket.CLOSING = 2
MockWebSocket.CLOSED = 3

const sockets: MockWebSocketInstance[] = []

describe('useWebSocket', () => {
  it('古い socket の close は現行 socket の pending RPC を reject する onClose を呼ばない', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    const rejectCurrentPending = vi.fn()
    const { result, unmount } = renderHook(() =>
      useWebSocket({ url: 'ws://example.test/ws', onMessage: () => {}, onClose: rejectCurrentPending }),
    )
    const first = sockets[0]

    try {
      expect(first).toBeDefined()
      if (!first) return

      first.readyState = MockWebSocket.CLOSING
      act(() => {
        window.dispatchEvent(new Event('focus'))
      })

      const second = sockets[1]
      expect(second).toBeDefined()
      if (!second) return

      second.readyState = MockWebSocket.OPEN
      act(() => {
        second.onopen?.()
      })

      act(() => {
        first.onclose?.()
      })

      expect(rejectCurrentPending).not.toHaveBeenCalled()
      expect(result.current.send('current request')).toBe(true)
      expect(second.sent).toEqual(['current request'])
    } finally {
      unmount()
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
      vi.unstubAllGlobals()
      sockets.length = 0
    }
  })
})
