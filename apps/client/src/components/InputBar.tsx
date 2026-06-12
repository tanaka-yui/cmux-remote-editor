import { useState } from 'react'

interface InputBarProps {
  disabled: boolean
  onSendText: (text: string) => void
  onSendKey: (key: string) => void
}

const SPECIAL_KEYS: { label: string; key: string }[] = [
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

export function InputBar({ disabled, onSendText, onSendKey }: InputBarProps) {
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
          <button key={k.key} type="button" disabled={disabled} onClick={() => onSendKey(k.key)} style={keyButtonStyle}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  )
}
