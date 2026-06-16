import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'

// React のエラーバウンダリは class でしか書けない（getDerivedStateFromError / componentDidCatch に
// 対応する hook が無い）。描画中に想定外の例外が出ると、バウンダリ無しでは React がツリー全体を
// アンマウントして「背景色 1 色・操作不能」になる。ここで捕捉して復帰導線を出す最後の砦。
interface Props {
  children: ReactNode
  // inline=true はコンテンツ領域（タブの中身）だけを覆う版。アプリの枠（Header/TabBar/InputBar）は
  // 親に残るので、エラー時もユーザーは別タブへ切替/このタブを閉じるで復帰できる。reload は出さない
  // （壊れた surface が復元され即再クラッシュし逃げ場にならないため）。既定の全画面版は最後の砦。
  inline?: boolean
  // resetKey が変わったらエラー状態を解除する。タブ切替で別 surface に移った時、コンテンツ領域の
  // エラーを子の再マウント無しで自動回復させる（react-error-boundary の resetKeys 相当）。
  resetKey?: string | null
}
interface State {
  error: Error | null
  // 直近に観測した resetKey。次レンダーとの差分でエラー解除を判定する。
  lastResetKey: string | null | undefined
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, lastResetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  // resetKey が変化したら（= 別 surface へ切替）エラーを解除して新しい内容の描画を試みる。
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.lastResetKey) {
      return { error: null, lastResetKey: props.resetKey }
    }
    return null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[app] Render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    const inline = this.props.inline === true
    const containerStyle: CSSProperties = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      padding: 24,
      backgroundColor: '#1a1a2e',
      color: '#e0e0e0',
      textAlign: 'center',
      // inline はコンテンツ領域（flex 列の残り）を埋め、全画面版はビューポート全高を覆う。
      ...(inline ? { flex: 1, minHeight: 0 } : { height: 'var(--app-height)' }),
    }

    return (
      <div style={containerStyle}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          {inline ? 'このタブの表示でエラーが発生しました' : '表示エラーが発生しました'}
        </div>
        <div style={{ fontSize: 13, opacity: 0.7, maxWidth: 360, wordBreak: 'break-word' }}>
          {this.state.error.message}
        </div>
        {inline ? (
          // 枠の TabBar が生きているので、ここでは復帰操作を案内するだけ（reload は出さない）。
          <div style={{ fontSize: 13, opacity: 0.7, maxWidth: 360 }}>
            上のタブから別のタブを選ぶか、× でこのタブを閉じてください。
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              window.location.reload()
            }}
            style={{
              padding: '10px 20px',
              fontSize: 14,
              color: '#e0e0e0',
              backgroundColor: '#2a2a4a',
              border: '1px solid #44446a',
              borderRadius: 8,
              cursor: 'pointer',
            }}
          >
            再読み込み
          </button>
        )}
      </div>
    )
  }
}
