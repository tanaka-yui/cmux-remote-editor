import { Keyboard } from 'lucide-react'
import { type CSSProperties, type ReactNode, useState } from 'react'
import { type CharMods, encodeChar, type SpecialKey } from '../lib/terminal-keys'

interface InputBarProps {
  disabled: boolean
  onSendText: (text: string) => void
  onSendKey: (key: SpecialKey) => void
  // フォントサイズ増減（+1 拡大 / -1 縮小）。ピンチ廃止の代替。
  onAdjustFontSize: (delta: number) => void
}

// QWERTY パネルのキー種別。Esc/Tab=特殊キー、Ctrl/Opt/Shift=ワンショット修飾、⌫/⏎=生シーケンス、
// それ以外は文字キー。縦幅を抑えるため専用行を作らず、実キーボードの位置（Esc=左上、Backspace=数字行末、
// Tab=Q 行頭、Enter=ホーム行末、Shift=Z 行頭、Ctrl/Opt=最下段）に混在配置する。
type KbKey =
  | { kind: 'char'; char: string; label?: string; flex?: number }
  | { kind: 'special'; label: string; key: SpecialKey; flex?: number }
  | { kind: 'mod'; label: string; mod: keyof CharMods; flex?: number }
  | { kind: 'raw'; label: string; ariaLabel: string; seq: string; flex?: number }

const chars = (s: string): KbKey[] => s.split('').map((char) => ({ kind: 'char', char }))

// フル US ANSI 配列。記号も物理キーボードと同じ相対位置に並べる（muscle memory のため）。Esc=左上、
// Backspace=数字行末、Tab=Q 行頭、Ctrl=Tab の下(ホーム行頭/CapsLock 位置)、Enter=ホーム行末、Shift=Z 行頭、
// Opt=最下段。Shift 武装で各キーは US 記号/大文字。
const KB_LAYOUT: KbKey[][] = [
  [
    { kind: 'special', label: 'Esc', key: 'escape', flex: 1.5 },
    ...chars('`1234567890-='),
    { kind: 'raw', label: '⌫', ariaLabel: 'Backspace', seq: '\x7f', flex: 2 },
  ],
  [{ kind: 'special', label: 'Tab', key: 'tab', flex: 1.5 }, ...chars('qwertyuiop[]\\')],
  [
    { kind: 'mod', label: 'Ctrl', mod: 'ctrl', flex: 1.75 },
    ...chars("asdfghjkl;'"),
    { kind: 'raw', label: '⏎', ariaLabel: 'Enter', seq: '\r', flex: 1.8 },
  ],
  [{ kind: 'mod', label: 'Shift', mod: 'shift', flex: 1.8 }, ...chars('zxcvbnm,./')],
  [
    { kind: 'mod', label: 'Opt', mod: 'option', flex: 1.5 },
    { kind: 'char', char: ' ', label: 'space', flex: 8 },
    // 矢印キーはフルキーボード時のみ・スペースの右に置く（コンパクト行には出さない）。
    { kind: 'special', label: '↑', key: 'up' },
    { kind: 'special', label: '↓', key: 'down' },
    { kind: 'special', label: '←', key: 'left' },
    { kind: 'special', label: '→', key: 'right' },
  ],
]

const NO_MODS: CharMods = { ctrl: false, shift: false, option: false }

const keyButtonStyle = {
  background: 'var(--color-control-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  color: 'var(--color-text-muted)',
  fontSize: 13,
  padding: '4px 10px',
  cursor: 'pointer',
  flexShrink: 0,
} as const

// 押している間だけ背景色を変えてフィードバックする小ボタン（タップ/クリック両対応）。
// flex 指定時は行内で均等幅に伸びる（QWERTY パネル用）。
function KeyButton({
  label,
  onPress,
  disabled,
  ariaLabel,
  flex,
}: {
  label: ReactNode
  onPress: () => void
  disabled?: boolean
  ariaLabel?: string
  flex?: number
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
        ...(flex ? { flex, minWidth: 0, padding: '8px 0' } : null),
        background: pressed ? 'var(--color-key-armed-bg)' : keyButtonStyle.background,
        borderColor: pressed ? 'var(--color-key-armed-border)' : 'var(--color-border)',
        color: pressed ? 'var(--color-key-armed-text)' : keyButtonStyle.color,
      }}
    >
      {label}
    </button>
  )
}

// 武装/開閉などの ON 状態をハイライト表示するトグルボタン（modifier・⌨ 共通）。
function ToggleButton({
  label,
  active,
  onToggle,
  disabled,
  ariaLabel,
  flex,
}: {
  label: ReactNode
  active: boolean
  onToggle: () => void
  disabled?: boolean
  ariaLabel?: string
  flex?: number
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onToggle}
      style={{
        ...keyButtonStyle,
        ...(flex ? { flex, minWidth: 0, padding: '8px 0' } : null),
        background: active ? 'var(--color-key-armed-bg)' : keyButtonStyle.background,
        borderColor: active ? 'var(--color-key-armed-border)' : 'var(--color-border)',
        color: active ? 'var(--color-key-armed-text)' : keyButtonStyle.color,
      }}
    >
      {label}
    </button>
  )
}

const rowStyle: CSSProperties = { display: 'flex', gap: 4 }

export function InputBar({ disabled, onSendText, onSendKey, onAdjustFontSize }: InputBarProps) {
  const [text, setText] = useState('')
  // ワンショット修飾キー（QWERTY パネルのキーにのみ適用、1 キー送出で自動解除）。
  const [mods, setMods] = useState<CharMods>(NO_MODS)
  const [keyboardOpen, setKeyboardOpen] = useState(false)

  // Send the typed text then a newline so the command runs, matching how a user
  // would type and press Enter in the terminal.
  const submit = () => {
    if (disabled) return
    if (text) onSendText(text)
    onSendKey('enter')
    setText('')
  }

  const toggleMod = (key: keyof CharMods) => setMods((m) => ({ ...m, [key]: !m[key] }))

  // パネル開閉時は武装中の修飾を解除（パネル外に持ち越さない）。
  const toggleKeyboard = () => {
    setMods(NO_MODS)
    setKeyboardOpen((o) => !o)
  }

  // QWERTY パネルの文字キー: 武装中の修飾を適用して送り、ワンショットを解除する。
  const pressChar = (char: string) => {
    if (disabled) return
    onSendText(encodeChar(char, mods))
    setMods(NO_MODS)
  }

  // space 以外の制御キー(⌫/⏎): Option 武装時のみ ESC 前置（Alt+Backspace で単語削除 等）。
  const pressRaw = (seq: string) => {
    if (disabled) return
    onSendText(mods.option ? `\x1b${seq}` : seq)
    setMods(NO_MODS)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingTop: 6,
        paddingLeft: 8,
        paddingRight: 8,
        // 最下部要素なのでホームインジケータ(iPhone)に被らない程度の余白を確保しつつ詰める。
        // フル inset(≈34px)はボタン下が空きすぎるため、inset から 24px 差し引いた値（最低 6px）にする。
        paddingBottom: 'max(6px, calc(env(safe-area-inset-bottom) - 24px))',
        backgroundColor: 'var(--color-surface)',
        borderTop: '1px solid var(--color-border)',
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
            background: 'var(--color-control-bg)',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            color: 'var(--color-text)',
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
            background: disabled ? 'var(--color-border)' : 'var(--color-accent)',
            border: 'none',
            borderRadius: 4,
            color: 'var(--color-accent-contrast)',
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
      {/* 常時表示のコンパクト行。⌨ とフォントのみ。特殊キー/矢印はフルキーボード側へ寄せて短く保つ。 */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
        {/* 英数字 QWERTY パネルの表示/非表示トグル。 */}
        <ToggleButton
          label={<Keyboard size={16} />}
          ariaLabel="キーボード表示切替"
          active={keyboardOpen}
          onToggle={toggleKeyboard}
        />
        {/* フォント増減（ピンチの代替）。表示倍率なので surface 未選択でも有効。 */}
        <KeyButton label="A-" ariaLabel="フォント縮小" onPress={() => onAdjustFontSize(-1)} />
        <KeyButton label="A+" ariaLabel="フォント拡大" onPress={() => onAdjustFontSize(1)} />
      </div>
      {keyboardOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {KB_LAYOUT.map((row) => (
            <div key={row.map((k) => (k.kind === 'char' ? k.char : k.label)).join('')} style={rowStyle}>
              {row.map((key) => {
                const flex = key.flex ?? 1
                switch (key.kind) {
                  case 'special':
                    return (
                      <KeyButton
                        key={key.key}
                        label={key.label}
                        disabled={disabled}
                        onPress={() => onSendKey(key.key)}
                        flex={flex}
                      />
                    )
                  case 'mod':
                    return (
                      <ToggleButton
                        key={key.mod}
                        label={key.label}
                        active={mods[key.mod]}
                        disabled={disabled}
                        onToggle={() => toggleMod(key.mod)}
                        flex={flex}
                      />
                    )
                  case 'raw':
                    return (
                      <KeyButton
                        key={key.label}
                        label={key.label}
                        ariaLabel={key.ariaLabel}
                        disabled={disabled}
                        onPress={() => pressRaw(key.seq)}
                        flex={flex}
                      />
                    )
                  default:
                    return (
                      // 文字キー。表示は Shift 武装中だけ大文字/記号（送出値も encodeChar が同規則で算出）。
                      // space 等は label を優先。
                      <KeyButton
                        key={key.char}
                        label={key.label ?? encodeChar(key.char, { ...NO_MODS, shift: mods.shift })}
                        disabled={disabled}
                        onPress={() => pressChar(key.char)}
                        flex={flex}
                      />
                    )
                }
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
