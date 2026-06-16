import { describe, expect, test } from 'bun:test'
import { buildPayload } from '../push/payload'
import type { CmuxNotification } from '../push/types'

const base: CmuxNotification = {
  id: 'n1',
  title: 'my-workspace',
  subtitle: 'Claude',
  body: 'waiting for your input',
  workspace_id: 'ws-123',
  surface_id: 'sf-1',
  is_read: false,
}

describe('buildPayload', () => {
  test('title/body/data を JSON 文字列で返す', () => {
    const parsed = JSON.parse(buildPayload(base))
    expect(parsed.title).toBe('my-workspace')
    expect(parsed.body).toContain('waiting for your input')
    expect(parsed.data.workspace_id).toBe('ws-123')
    expect(parsed.data.url).toBe('/?workspace=ws-123')
    expect(parsed.tag).toBe('ws-123')
  })

  test('title が空なら cmux にフォールバック', () => {
    const parsed = JSON.parse(buildPayload({ ...base, title: '' }))
    expect(parsed.title).toBe('cmux')
  })

  test('workspace_id は URL エンコードされる', () => {
    const parsed = JSON.parse(buildPayload({ ...base, workspace_id: 'a b/c' }))
    expect(parsed.data.url).toBe('/?workspace=a%20b%2Fc')
  })
})
