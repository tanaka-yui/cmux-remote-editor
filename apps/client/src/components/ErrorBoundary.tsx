import { Component, type ErrorInfo, type ReactNode } from 'react'

// React のエラーバウンダリは class でしか書けない（getDerivedStateFromError / componentDidCatch に
// 対応する hook が無い）。描画中に想定外の例外が出ると、バウンダリ無しでは React がツリー全体を
// アンマウントして「背景色 1 色・操作不能」になる。ここで捕捉して再読み込み導線を出す最後の砦。
interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[app] Render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          height: 'var(--app-height)',
          padding: 24,
          backgroundColor: '#1a1a2e',
          color: '#e0e0e0',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>表示エラーが発生しました</div>
        <div style={{ fontSize: 13, opacity: 0.7, maxWidth: 360, wordBreak: 'break-word' }}>
          {this.state.error.message}
        </div>
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
      </div>
    )
  }
}
