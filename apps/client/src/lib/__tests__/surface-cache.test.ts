// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RenderGrid } from '../render-grid'
import {
  loadSurfaceScreen,
  MAX_CACHED_CHARS,
  MAX_CACHED_ENTRY_BYTES,
  MAX_CACHED_SURFACES,
  saveSurfaceScreen,
} from '../surface-cache'

beforeEach(() => {
  localStorage.clear()
})

describe('surface-cache', () => {
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
    expect(loaded?.text?.length).toBeLessThanOrEqual(MAX_CACHED_CHARS)
    // 末尾（最新行）が保持される
    expect(loaded?.text?.endsWith('x')).toBe(true)
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

describe('C5 entry サイズ上限（実バイト数）', () => {
  it('サイズは UTF-16 code unit ではなく TextEncoder の実バイト数で測る', () => {
    const cjk = 'あ'.repeat(MAX_CACHED_ENTRY_BYTES / 3)
    saveSurfaceScreen('surface:1', { scrollback: cjk, updatedAt: 1 })
    const raw = localStorage.getItem('cmux-surface-cache:surface:1') as string
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_CACHED_ENTRY_BYTES)
  })

  it('超過したらまず scrollback を削る', () => {
    saveSurfaceScreen('surface:1', {
      text: 'short text',
      scrollback: 'x'.repeat(MAX_CACHED_ENTRY_BYTES),
      updatedAt: 1,
    })
    const loaded = loadSurfaceScreen('surface:1')
    expect(loaded?.text).toBe('short text')
    expect((loaded?.scrollback ?? '').length).toBeLessThan(MAX_CACHED_ENTRY_BYTES)
  })

  it('超過した scrollback は CJK の末尾を残して実バイト上限まで切り詰める', () => {
    const grid: RenderGrid = { columns: 80, rows: 1, styles: [], row_spans: [] }
    const scrollback = `${'あ'.repeat(MAX_CACHED_CHARS - 1)}終`
    saveSurfaceScreen('surface:1', { grid, scrollback, updatedAt: 1 })
    const loaded = loadSurfaceScreen('surface:1')
    const raw = localStorage.getItem('cmux-surface-cache:surface:1') as string
    expect(loaded?.grid).toEqual(grid)
    expect(loaded?.scrollback).toBeTruthy()
    expect(loaded?.scrollback?.endsWith('終')).toBe(true)
    expect(loaded?.scrollback?.length).toBeLessThan(scrollback.length)
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_CACHED_ENTRY_BYTES)
  })

  it('超過した text は CJK の末尾を残して実バイト上限まで切り詰める', () => {
    const text = `${'い'.repeat(MAX_CACHED_CHARS - 1)}終`
    saveSurfaceScreen('surface:1', { text, updatedAt: 1 })
    const loaded = loadSurfaceScreen('surface:1')
    const raw = localStorage.getItem('cmux-surface-cache:surface:1') as string
    expect(loaded?.text).toBeTruthy()
    expect(loaded?.text?.endsWith('終')).toBe(true)
    expect(loaded?.text?.length).toBeLessThan(text.length)
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_CACHED_ENTRY_BYTES)
  })

  it('scrollback を削っても収まらなければ text も削る', () => {
    saveSurfaceScreen('surface:1', {
      text: 'y'.repeat(MAX_CACHED_ENTRY_BYTES),
      scrollback: 'x'.repeat(MAX_CACHED_ENTRY_BYTES),
      grid: { columns: 80, rows: 1, styles: [], row_spans: [] } as RenderGrid,
      updatedAt: 1,
    })
    const loaded = loadSurfaceScreen('surface:1')
    expect(loaded?.grid).toBeDefined()
    const raw = localStorage.getItem('cmux-surface-cache:surface:1') as string
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_CACHED_ENTRY_BYTES)
  })

  it('grid だけでも超えるならその entry は保存しない', () => {
    const huge: RenderGrid = {
      columns: 80,
      rows: 1,
      styles: [],
      row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 1, text: 'z'.repeat(MAX_CACHED_ENTRY_BYTES) }],
    }
    saveSurfaceScreen('surface:1', { grid: huge, updatedAt: 1 })
    expect(localStorage.getItem('cmux-surface-cache:surface:1')).toBeNull()
  })
})

describe('C3 QuotaExceededError の反復退避', () => {
  it('候補が尽きるか成功するまで、updatedAt の古い順に削除して再試行する', () => {
    for (let i = 0; i < 5; i++) saveSurfaceScreen(`surface:${i}`, { text: `t${i}`, updatedAt: i })
    let failures = 3
    const original = localStorage.setItem
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('cmux-surface-cache:surface:new') && failures-- > 0) {
        const err = new Error('quota') as Error & { name: string }
        err.name = 'QuotaExceededError'
        throw err
      }
      original.call(this, k, v)
    })
    saveSurfaceScreen('surface:new', { text: 'new', updatedAt: 99 })
    spy.mockRestore()
    expect(loadSurfaceScreen('surface:new')?.text).toBe('new')
    expect(loadSurfaceScreen('surface:0')).toBeNull()
    expect(loadSurfaceScreen('surface:2')).toBeNull()
    expect(loadSurfaceScreen('surface:4')).not.toBeNull()
  })

  it('候補が尽きたら諦める（例外を投げない）', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      const err = new Error('quota') as Error & { name: string }
      err.name = 'QuotaExceededError'
      throw err
    })
    expect(() => saveSurfaceScreen('surface:1', { text: 'x', updatedAt: 1 })).not.toThrow()
    spy.mockRestore()
  })
})

describe('C4 件数の二次ガード', () => {
  it(`MAX_CACHED_SURFACES(${MAX_CACHED_SURFACES}) を超えたら updatedAt の古い順に消す`, () => {
    for (let i = 0; i < MAX_CACHED_SURFACES + 3; i++) {
      saveSurfaceScreen(`surface:${i}`, { text: `t${i}`, updatedAt: i })
    }
    const keys = Object.keys(localStorage).filter((key) => key.startsWith('cmux-surface-cache:'))
    expect(keys.length).toBeLessThanOrEqual(MAX_CACHED_SURFACES)
    expect(loadSurfaceScreen('surface:0')).toBeNull()
    expect(loadSurfaceScreen(`surface:${MAX_CACHED_SURFACES + 2}`)).not.toBeNull()
  })
})
