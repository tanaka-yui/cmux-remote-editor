import * as Dialog from '@radix-ui/react-dialog'
import * as Slider from '@radix-ui/react-slider'
import * as Switch from '@radix-ui/react-switch'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Monitor, Moon, Sun, X } from 'lucide-react'
import { type CSSProperties, useEffect, useState } from 'react'
import { clampHistoryLines, HISTORY_LINES_MAX, HISTORY_LINES_MIN } from '../lib/settings'
import type { ThemeSetting } from '../lib/theme'

interface SettingsModalProps {
  open: boolean
  themeSetting: ThemeSetting
  onThemeChange: (t: ThemeSetting) => void
  historyLines: number
  pushSupported: boolean
  pushEnabled: boolean
  onTogglePush: (enabled: boolean) => void
  onSave: (lines: number) => void
  onClose: () => void
}

const THEME_OPTIONS: { value: ThemeSetting; label: string; Icon: typeof Monitor }[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

const labelStyle: CSSProperties = { display: 'block', fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6 }

// 設定モーダル。テーマ/通知は即時反映、履歴行数は draft→保存で確定（従来挙動）。
export function SettingsModal({
  open,
  themeSetting,
  onThemeChange,
  historyLines,
  pushSupported,
  pushEnabled,
  onTogglePush,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [draft, setDraft] = useState(String(historyLines))
  useEffect(() => {
    if (open) setDraft(String(historyLines))
  }, [open, historyLines])

  const parsed = Number.parseInt(draft, 10)
  const valid = Number.isFinite(parsed) && parsed >= HISTORY_LINES_MIN && parsed <= HISTORY_LINES_MAX
  const save = () => {
    onSave(clampHistoryLines(parsed))
    onClose()
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, background: 'var(--color-scrim)', zIndex: 100 }} />
        <Dialog.Content
          aria-describedby={undefined}
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'calc(100% - 32px)',
            maxWidth: 360,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 10,
            color: 'var(--color-text)',
            padding: 20,
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
            zIndex: 101,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <Dialog.Title style={{ fontSize: 16, fontWeight: 600 }}>設定</Dialog.Title>
            <Dialog.Close
              aria-label="閉じる"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
                display: 'flex',
                padding: 4,
              }}
            >
              <X size={18} />
            </Dialog.Close>
          </div>

          {/* テーマ（即時反映） */}
          <div style={{ marginBottom: 18 }}>
            <span style={labelStyle}>テーマ</span>
            <ToggleGroup.Root
              type="single"
              value={themeSetting}
              onValueChange={(v) => {
                if (v && THEME_OPTIONS.some((o) => o.value === v)) onThemeChange(v as ThemeSetting)
              }}
              style={{ display: 'flex', gap: 6 }}
            >
              {THEME_OPTIONS.map(({ value, label, Icon }) => {
                const active = themeSetting === value
                return (
                  <ToggleGroup.Item
                    key={value}
                    value={value}
                    aria-label={label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      flex: 1,
                      padding: '8px 0',
                      fontSize: 13,
                      borderRadius: 6,
                      border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                      background: active ? 'var(--color-accent)' : 'transparent',
                      color: active ? 'var(--color-accent-contrast)' : 'var(--color-text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <Icon size={16} />
                    {label}
                  </ToggleGroup.Item>
                )
              })}
            </ToggleGroup.Root>
          </div>

          {/* 通知（Web Push） */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>通知（Web Push）</span>
              <Switch.Root
                checked={pushEnabled}
                disabled={!pushSupported}
                onCheckedChange={onTogglePush}
                style={{
                  width: 42,
                  height: 24,
                  borderRadius: 12,
                  border: 'none',
                  position: 'relative',
                  background: pushEnabled ? 'var(--color-accent)' : 'var(--color-border)',
                  cursor: pushSupported ? 'pointer' : 'default',
                  opacity: pushSupported ? 1 : 0.5,
                  flexShrink: 0,
                }}
              >
                <Switch.Thumb
                  style={{
                    display: 'block',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'transform 0.15s',
                    transform: pushEnabled ? 'translateX(21px)' : 'translateX(3px)',
                  }}
                />
              </Switch.Root>
            </div>
            {!pushSupported && (
              <div style={{ fontSize: 12, color: 'var(--color-text-subtle)', marginTop: 6 }}>
                この環境では利用できません（HTTPS のホーム画面追加 PWA・iOS 16.4+ が必要です）。
              </div>
            )}
          </div>

          {/* 履歴バッファ（行数）。draft→保存で確定。 */}
          <span style={labelStyle}>履歴バッファ（行数）</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Slider.Root
              min={HISTORY_LINES_MIN}
              max={HISTORY_LINES_MAX}
              step={1000}
              value={[valid ? parsed : HISTORY_LINES_MIN]}
              onValueChange={([v]) => setDraft(String(v))}
              style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, height: 20 }}
            >
              <Slider.Track
                style={{
                  position: 'relative',
                  flexGrow: 1,
                  height: 4,
                  borderRadius: 2,
                  background: 'var(--color-border)',
                }}
              >
                <Slider.Range
                  style={{ position: 'absolute', height: '100%', borderRadius: 2, background: 'var(--color-accent)' }}
                />
              </Slider.Track>
              <Slider.Thumb
                aria-label="履歴バッファ"
                style={{
                  display: 'block',
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: 'var(--color-accent)',
                }}
              />
            </Slider.Root>
            <input
              type="number"
              min={HISTORY_LINES_MIN}
              max={HISTORY_LINES_MAX}
              step={1000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{
                width: 90,
                background: 'var(--color-control-bg)',
                border: `1px solid ${valid ? 'var(--color-border)' : 'var(--color-danger)'}`,
                borderRadius: 4,
                color: 'var(--color-text)',
                fontSize: 14,
                padding: '6px 8px',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-subtle)', marginTop: 6 }}>
            {HISTORY_LINES_MIN.toLocaleString()}〜{HISTORY_LINES_MAX.toLocaleString()} 行（ライブ表示で上へ
            遡れるスクロールバック行数。大きいほど重くなります）
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text-muted)',
                fontSize: 14,
                padding: '8px 14px',
                cursor: 'pointer',
              }}
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!valid}
              style={{
                background: valid ? 'var(--color-accent)' : 'var(--color-border)',
                border: 'none',
                borderRadius: 6,
                color: 'var(--color-accent-contrast)',
                fontSize: 14,
                fontWeight: 600,
                padding: '8px 16px',
                cursor: valid ? 'pointer' : 'default',
              }}
            >
              保存
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
