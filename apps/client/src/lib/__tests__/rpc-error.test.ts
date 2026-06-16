import { describe, expect, it } from 'vitest'

import { isStaleSurfaceError, type RpcError } from '../rpc-error'

function withCode(message: string, code: string): RpcError {
  const err = new Error(message) as RpcError
  err.code = code
  return err
}

describe('isStaleSurfaceError', () => {
  // 実機プローブで確認: 閉じた/存在しない短縮 ref を terminal.replay すると
  // invalid_params「Missing or invalid terminal_id」、不正 UUID なら not_found「Terminal surface not found」。
  it('閉じた短縮 ref のエラー（invalid_params / Missing or invalid terminal_id）を検出する', () => {
    expect(isStaleSurfaceError(withCode('Missing or invalid terminal_id', 'invalid_params'))).toBe(true)
  })

  it('不正 UUID のエラー（not_found / Terminal surface not found）を検出する', () => {
    expect(isStaleSurfaceError(withCode('Terminal surface not found', 'not_found'))).toBe(true)
  })

  it('code が無くてもメッセージだけで検出する（code はクライアントを跨いで欠落し得る）', () => {
    expect(isStaleSurfaceError(new Error('Missing or invalid terminal_id'))).toBe(true)
    expect(isStaleSurfaceError(new Error('Terminal surface not found'))).toBe(true)
  })

  it('RPC タイムアウト（通信不良）は stale 扱いしない（surface 切替を誘発させない）', () => {
    expect(isStaleSurfaceError(new Error('RPC timeout: terminal.replay'))).toBe(false)
  })

  it('無関係なエラーは false', () => {
    expect(isStaleSurfaceError(withCode('boom', 'internal_error'))).toBe(false)
    expect(isStaleSurfaceError(new Error('something else'))).toBe(false)
    expect(isStaleSurfaceError('not an error')).toBe(false)
    expect(isStaleSurfaceError(null)).toBe(false)
  })
})
