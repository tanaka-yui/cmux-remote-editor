// cmux ソケットのエラーレスポンスから生成された Error。code は JSON-RPC エラーの code を保持する
// （useCmux の rpc 層が reject 時に付与する）。
export interface RpcError extends Error {
  code?: string
}

// terminal.replay の surface_id が「閉じられた/存在しない surface」を指すと cmux はエラーを返す:
//   - 短縮 ref（surface:N）が無効 → invalid_params「Missing or invalid terminal_id」
//   - UUID が不一致 → not_found「Terminal surface not found」
// （いずれも実機プローブで確認）。これは前面サーフェスが無効化された合図なので、検出して
// surface 一覧を再取得し、生きた surface へ退避する。通信不良の RPC タイムアウト等は対象外
// （surface は有効なまま一時的に届かないだけなので、タブを切り替えてはいけない）。
export function isStaleSurfaceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const { code } = err as RpcError
  if (code === 'invalid_params' || code === 'not_found') return true
  return /terminal_id|surface not found/i.test(err.message)
}
