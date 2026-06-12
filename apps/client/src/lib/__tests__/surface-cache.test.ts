// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { loadSurfaceScreen, MAX_CACHED_CHARS, saveSurfaceScreen } from '../surface-cache'

describe('surface-cache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('未保存のサーフェスは null を返す', () => {
    expect(loadSurfaceScreen('surface:1')).toBeNull()
  })

  it('保存した画面内容をそのまま読み戻せる', () => {
    saveSurfaceScreen('surface:1', { text: 'hello', updatedAt: 1000 })
    expect(loadSurfaceScreen('surface:1')).toEqual({ text: 'hello', updatedAt: 1000 })
  })

  it('scrollback も保存・読み戻しできる', () => {
    saveSurfaceScreen('surface:1', { text: 'live', scrollback: 'old history', updatedAt: 2000 })
    expect(loadSurfaceScreen('surface:1')).toEqual({ text: 'live', scrollback: 'old history', updatedAt: 2000 })
  })

  it('サーフェスごとにキーが分離される', () => {
    saveSurfaceScreen('surface:1', { text: 'one', updatedAt: 1 })
    saveSurfaceScreen('surface:2', { text: 'two', updatedAt: 2 })
    expect(loadSurfaceScreen('surface:1')?.text).toBe('one')
    expect(loadSurfaceScreen('surface:2')?.text).toBe('two')
  })

  it('上限を超える内容は末尾を残して切り詰めて保存する', () => {
    const huge = 'x'.repeat(MAX_CACHED_CHARS + 5000)
    saveSurfaceScreen('surface:1', { text: huge, updatedAt: 1 })
    const loaded = loadSurfaceScreen('surface:1')
    expect(loaded).not.toBeNull()
    expect(loaded?.text.length).toBeLessThanOrEqual(MAX_CACHED_CHARS)
    // 末尾（最新行）が保持される
    expect(loaded?.text.endsWith('x')).toBe(true)
  })

  it('scrollback 未指定で保存すると既存の scrollback を引き継ぐ', () => {
    saveSurfaceScreen('surface:1', { text: 'live1', scrollback: 'deep history', updatedAt: 1 })
    saveSurfaceScreen('surface:1', { text: 'live2', updatedAt: 2 })
    const loaded = loadSurfaceScreen('surface:1')
    expect(loaded?.text).toBe('live2')
    expect(loaded?.scrollback).toBe('deep history')
    expect(loaded?.updatedAt).toBe(2)
  })

  it('grid を保存・読み戻しできる', () => {
    const grid = { columns: 2, rows: 1, styles: [], row_spans: [] }
    saveSurfaceScreen('surface:1', { grid, updatedAt: 5 })
    expect(loadSurfaceScreen('surface:1')?.grid).toEqual(grid)
  })

  it('text 未指定の保存は既存の text/scrollback を引き継ぐ（grid だけ更新）', () => {
    saveSurfaceScreen('surface:1', { text: 'old', scrollback: 'hist', updatedAt: 1 })
    const grid = { columns: 1, rows: 1, styles: [], row_spans: [] }
    saveSurfaceScreen('surface:1', { grid, updatedAt: 2 })
    const loaded = loadSurfaceScreen('surface:1')
    expect(loaded?.text).toBe('old')
    expect(loaded?.scrollback).toBe('hist')
    expect(loaded?.grid).toEqual(grid)
    expect(loaded?.updatedAt).toBe(2)
  })

  it('壊れた JSON は null を返す（クラッシュしない）', () => {
    localStorage.setItem('cmux-surface-cache:surface:1', '{not json')
    expect(loadSurfaceScreen('surface:1')).toBeNull()
  })
})
