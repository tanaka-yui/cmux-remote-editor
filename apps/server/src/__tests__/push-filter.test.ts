import { describe, expect, test } from 'bun:test'
import { isActionable } from '../push/filter'
import type { CmuxNotification } from '../push/types'

function note(partial: Partial<CmuxNotification>): CmuxNotification {
  return {
    id: 'n1',
    title: 'cmux',
    subtitle: '',
    body: '',
    workspace_id: 'ws1',
    surface_id: 'sf1',
    is_read: false,
    ...partial,
  }
}

describe('isActionable', () => {
  test('Needs input: body に waiting for your input', () => {
    expect(isActionable(note({ body: 'Claude is waiting for your input' }))).toBe(true)
  })

  test('Needs input: subtitle が waiting（完全一致, 大小無視）', () => {
    expect(isActionable(note({ subtitle: 'Waiting' }))).toBe(true)
  })

  test('Permission: body に permission', () => {
    expect(isActionable(note({ body: 'Needs permission to run a command' }))).toBe(true)
  })

  test('完了/Idle 系は false', () => {
    expect(isActionable(note({ subtitle: 'Completed' }))).toBe(false)
    expect(isActionable(note({ body: '処理が完了しました' }))).toBe(false)
  })

  test('該当文言なしは false', () => {
    expect(isActionable(note({ body: 'just an update' }))).toBe(false)
  })

  test('既読は actionable でも false', () => {
    expect(isActionable(note({ body: 'waiting for your input', is_read: true }))).toBe(false)
  })
})
