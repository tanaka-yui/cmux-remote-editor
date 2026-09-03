// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectionIndicator } from '../ConnectionIndicator'

afterEach(() => {
  vi.useRealTimers()
})

describe('ConnectionIndicator', () => {
  it('切断直後 1999ms は Connected と旧 freshness を保ち、2000ms 後に同時に切り替える', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ConnectionIndicator status="connected" freshness="更新: 12:34:56" />)

    rerender(<ConnectionIndicator status="disconnected" freshness="接続なし · 最終 12:34" />)
    act(() => vi.advanceTimersByTime(1999))
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('更新: 12:34:56')).toBeTruthy()
    expect(screen.queryByText('接続なし · 最終 12:34')).toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Disconnected')).toBeTruthy()
    expect(screen.getByText('接続なし · 最終 12:34')).toBeTruthy()
    expect(screen.queryByText('更新: 12:34:56')).toBeNull()
  })

  it('猶予中の freshness 更新で切断タイマーを再開しない', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ConnectionIndicator status="connected" freshness="更新: 12:34:56" />)

    rerender(<ConnectionIndicator status="disconnected" freshness="接続なし · 最終 12:34" />)
    act(() => vi.advanceTimersByTime(1000))
    rerender(<ConnectionIndicator status="disconnected" freshness="接続なし · 最終 12:35" />)

    act(() => vi.advanceTimersByTime(999))
    expect(screen.getByText('Connected')).toBeTruthy()
    expect(screen.getByText('更新: 12:34:56')).toBeTruthy()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Disconnected')).toBeTruthy()
    expect(screen.getByText('接続なし · 最終 12:35')).toBeTruthy()
  })

  it('freshness が null なら何も表示しない', () => {
    render(<ConnectionIndicator status="connected" freshness={null} />)
    expect(screen.queryByText(/更新:|接続なし|オフライン時点/)).toBeNull()
  })
})
