import { StringDecoder } from 'node:string_decoder'

// UTF-8 安全な行フレーマ。net.Socket の data チャンクは UTF-8 文字や行の途中で切れ得るため、
// data.toString() を直接連結すると絵文字(4byte)/CJK(3byte) 等のマルチバイト文字がチャンク境界で
// 分割され、各破片が U+FFFD(画面上は「?」)に化ける(→「??」)。StringDecoder で未完成バイトを次
// チャンクまで保持して文字境界を跨いで復元し、改行で区切った完全な行(空行除く)だけを返す。
export function createLineFramer(): { push(chunk: Buffer): string[] } {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  return {
    push(chunk: Buffer): string[] {
      buffer += decoder.write(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      return lines.filter((line) => line.trim() !== '')
    },
  }
}
