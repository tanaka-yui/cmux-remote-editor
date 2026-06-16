import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampHistoryLines,
  HISTORY_LINES_DEFAULT,
  HISTORY_LINES_MAX,
  HISTORY_LINES_MIN,
  loadPushEnabled,
  savePushEnabled,
} from '../settings'

describe('clampHistoryLines', () => {
  it('範囲内はそのまま(整数丸め)', () => {
    expect(clampHistoryLines(5000)).toBe(5000)
    expect(clampHistoryLines(5000.6)).toBe(5001)
  })

  it('下限・上限でクランプする', () => {
    expect(clampHistoryLines(0)).toBe(HISTORY_LINES_MIN)
    expect(clampHistoryLines(HISTORY_LINES_MIN - 1)).toBe(HISTORY_LINES_MIN)
    expect(clampHistoryLines(HISTORY_LINES_MAX + 1)).toBe(HISTORY_LINES_MAX)
    expect(clampHistoryLines(9_999_999)).toBe(HISTORY_LINES_MAX)
  })

  it('非有限値は既定値', () => {
    expect(clampHistoryLines(Number.NaN)).toBe(HISTORY_LINES_DEFAULT)
    expect(clampHistoryLines(Number.POSITIVE_INFINITY)).toBe(HISTORY_LINES_DEFAULT)
  })
})

describe('push-enabled 設定', () => {
  beforeEach(() => localStorage.clear())

  it('既定は false', () => {
    expect(loadPushEnabled()).toBe(false)
  })

  it('保存して読み戻せる', () => {
    savePushEnabled(true)
    expect(loadPushEnabled()).toBe(true)
    savePushEnabled(false)
    expect(loadPushEnabled()).toBe(false)
  })
})
