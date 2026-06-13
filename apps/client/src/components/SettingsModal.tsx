import { useEffect, useState } from 'react'
import { clampHistoryLines, HISTORY_LINES_MAX, HISTORY_LINES_MIN } from '../lib/settings'

interface SettingsModalProps {
  open: boolean
  historyLines: number
  onSave: (lines: number) => void
  onClose: () => void
}

// 設定モーダル。今は履歴(スクロールバック)行数のみ。開くたびに現在値で編集状態を初期化し、
// キャンセル/オーバーレイクリックで破棄、保存でクランプして反映する。
export function SettingsModal({ open, historyLines, onSave, onClose }: SettingsModalProps) {
  // 入力中の文字列(空や途中入力を許容するため number ではなく string で保持)。
  const [draft, setDraft] = useState(String(historyLines))
  useEffect(() => {
    if (open) setDraft(String(historyLines))
  }, [open, historyLines])

  if (!open) return null

  const parsed = Number.parseInt(draft, 10)
  const valid = Number.isFinite(parsed) && parsed >= HISTORY_LINES_MIN && parsed <= HISTORY_LINES_MAX
  const save = () => {
    onSave(clampHistoryLines(parsed))
    onClose()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: overlay click-to-close is a common dismissable pattern
    // biome-ignore lint/a11y/useKeyWithClickEvents: dismiss-on-backdrop; the dialog's buttons handle keyboard
    <div
      onClick={(e) => {
        // 背景(オーバーレイ自身)クリックでのみ閉じる。カード内クリックは currentTarget と一致しない。
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="設定"
        style={{
          width: '100%',
          maxWidth: 360,
          background: '#16213e',
          border: '1px solid #2a2a4e',
          borderRadius: 10,
          color: '#e0e0e0',
          padding: 20,
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>設定</div>

        <label htmlFor="history-lines" style={{ display: 'block', fontSize: 13, color: '#aaa', marginBottom: 6 }}>
          履歴バッファ（行数）
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            id="history-lines"
            type="range"
            min={HISTORY_LINES_MIN}
            max={HISTORY_LINES_MAX}
            step={1000}
            value={valid ? parsed : HISTORY_LINES_MIN}
            onChange={(e) => setDraft(e.target.value)}
            style={{ flex: 1, minWidth: 0, accentColor: '#4caf50' }}
          />
          <input
            type="number"
            min={HISTORY_LINES_MIN}
            max={HISTORY_LINES_MAX}
            step={1000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={{
              width: 90,
              background: '#1a1a2e',
              border: `1px solid ${valid ? '#2a2a4e' : '#f44336'}`,
              borderRadius: 4,
              color: '#e0e0e0',
              fontSize: 14,
              padding: '6px 8px',
              outline: 'none',
            }}
          />
        </div>
        <div style={{ fontSize: 12, color: '#777', marginTop: 6 }}>
          {HISTORY_LINES_MIN.toLocaleString()}〜{HISTORY_LINES_MAX.toLocaleString()} 行（履歴モードで取得する
          スクロールバック行数。大きいほど重くなります）
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: '1px solid #2a2a4e',
              borderRadius: 6,
              color: '#ccc',
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
              background: valid ? '#4caf50' : '#2a2a4e',
              border: 'none',
              borderRadius: 6,
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              padding: '8px 16px',
              cursor: valid ? 'pointer' : 'default',
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
