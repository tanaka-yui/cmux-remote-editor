import { useState } from 'react'
import type { SpecialKey } from '../lib/terminal-keys'

interface InputBarProps {
  disabled: boolean
  onSendText: (text: string) => void
  onSendKey: (key: SpecialKey) => void
  // フォントサイズ増減（+1 拡大 / -1 縮小）。ピンチ廃止の代替。
  onAdjustFontSize: (delta: number) => void
}

const SPECIAL_KEYS: { label: string; key: SpecialKey }[] = [
  { label: 'Esc', key: 'escape' },
  { label: 'Tab', key: 'tab' },
  { label: '^C', key: 'ctrl+c' },
  { label: '↑', key: 'up' },
  { label: '↓', key: 'down' },
  { label: '←', key: 'left' },
  { label: '→', key: 'right' },
]

const keyButtonStyle = {
  background: '#1a1a2e',
  border: '1px solid #2a2a4e',
  borderRadius: 4,
  color: '#ccc',
  fontSize: 13,
  padding: '4px 10px',
  cursor: 'pointer',
  flexShrink: 0,
} as const

// 押している間だけ背景色を変えてフィードバックする小ボタン（タップ/クリック両対応）。
function KeyButton({
  label,
  onPress,
  disabled,
  ariaLabel,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  ariaLabel?: string
}) {
  const [pressed, setPressed] = useState(false)
  const release = () => setPressed(false)
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={onPress}
      onPointerDown={() => setPressed(true)}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      style={{
        ...keyButtonStyle,
        background: pressed ? '#4a5a9a' : keyButtonStyle.background,
        borderColor: pressed ? '#6a7ace' : '#2a2a4e',
        color: pressed ? '#fff' : keyButtonStyle.color,
      }}
    >
      {label}
    </button>
  )
}

export function InputBar({ disabled, onSendText, onSendKey, onAdjustFontSize }: InputBarProps) {
  const [text, setText] = useState('')

  // Send the typed text then a newline so the command runs, matching how a user
  // would type and press Enter in the terminal.
  const submit = () => {
    if (disabled) return
    if (text) onSendText(text)
    onSendKey('enter')
    setText('')
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '6px 8px',
        backgroundColor: '#16213e',
        borderTop: '1px solid #2a2a4e',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={text}
          disabled={disabled}
          placeholder={disabled ? 'No tab selected' : 'Type a command…'}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: '#1a1a2e',
            border: '1px solid #2a2a4e',
            borderRadius: 4,
            color: '#e0e0e0',
            fontSize: 14,
            padding: '8px 10px',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          style={{
            background: disabled ? '#2a2a4e' : '#4caf50',
            border: 'none',
            borderRadius: 4,
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            padding: '8px 16px',
            cursor: disabled ? 'default' : 'pointer',
            flexShrink: 0,
          }}
        >
          Send
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
        {SPECIAL_KEYS.map((k) => (
          <KeyButton key={k.key} label={k.label} disabled={disabled} onPress={() => onSendKey(k.key)} />
        ))}
        {/* フォント増減（ピンチの代替）。表示倍率なので surface 未選択でも有効。 */}
        <KeyButton label="A-" ariaLabel="フォント縮小" onPress={() => onAdjustFontSize(-1)} />
        <KeyButton label="A+" ariaLabel="フォント拡大" onPress={() => onAdjustFontSize(1)} />
      </div>
    </div>
  )
}
