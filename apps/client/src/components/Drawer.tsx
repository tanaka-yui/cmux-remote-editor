import * as AlertDialog from '@radix-ui/react-alert-dialog'
import * as Dialog from '@radix-ui/react-dialog'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'

import type { CmuxNotification, Workspace } from '../lib/cmux-rpc'

const SIDEBAR_WIDTH = 220
const DESKTOP_BREAKPOINT = 768

interface DrawerProps {
  open: boolean
  workspaces: Workspace[]
  currentWorkspace: string | null
  notifications: CmuxNotification[]
  onSelect: (id: string) => void
  onCloseWorkspace: (ref: string) => void
  onNewWorkspace: () => Promise<void>
  onClose: () => void
}

/** Default palette for workspaces without custom_color (matches cmux desktop) */
const DEFAULT_PALETTE = [
  '#4A5C18',
  '#C0392B',
  '#1565C0',
  '#32A06D',
  '#8E44AD',
  '#D35400',
  '#2980B9',
  '#27AE60',
  '#E74C3C',
  '#16A085',
  '#F39C12',
  '#3498DB',
  '#2ECC71',
  '#E67E22',
  '#9B59B6',
]

function paletteColor(index: number): string {
  return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length] ?? '#3E4B5E'
}

/** Extract folder name from path */
function folderName(path?: string): string | null {
  if (!path) return null
  const parts = path.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || null
}

/** Get latest notification per workspace */
function latestNotificationByWorkspace(notifications: CmuxNotification[]): Map<string, CmuxNotification> {
  const latest = new Map<string, CmuxNotification>()
  for (const n of notifications) {
    latest.set(n.workspace_id, n)
  }
  return latest
}

/** Count unread notifications per workspace */
function unreadCountByWorkspace(notifications: CmuxNotification[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const n of notifications) {
    if (!n.is_read) {
      counts.set(n.workspace_id, (counts.get(n.workspace_id) ?? 0) + 1)
    }
  }
  return counts
}

/** Derive status from notification */
function deriveStatus(n?: CmuxNotification): { label: string; color: string } | null {
  if (!n) return null
  const body = n.body.toLowerCase()
  const subtitle = n.subtitle.toLowerCase()

  if (!n.is_read) {
    if (body.includes('waiting for your input') || subtitle === 'waiting') {
      return { label: 'Needs input', color: 'var(--color-warning)' }
    }
    if (body.includes('permission')) {
      return { label: 'Permission', color: 'var(--color-danger)' }
    }
  }
  if (subtitle.includes('completed') || body.includes('完了')) {
    return { label: 'Idle', color: 'var(--color-text-subtle)' }
  }
  return null
}

function WorkspaceItem({
  ws,
  index,
  isCurrent,
  unreadCount,
  notification,
  onClick,
  onRequestClose,
}: {
  ws: Workspace
  index: number
  isCurrent: boolean
  unreadCount: number
  notification?: CmuxNotification
  onClick: () => void
  onRequestClose: () => void
}) {
  const color = ws.custom_color ?? paletteColor(index)
  const folder = folderName(ws.current_directory)
  const status = deriveStatus(notification)

  const notifPreview = notification?.body
    ? notification.body.slice(0, 60) + (notification.body.length > 60 ? '...' : '')
    : null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: isCurrent ? 'var(--color-selected)' : 'none',
        borderLeft: `3px solid ${isCurrent ? color || 'var(--color-accent)' : 'transparent'}`,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        style={{
          display: 'flex',
          gap: 8,
          flex: 1,
          minWidth: 0,
          padding: '8px 10px',
          background: 'none',
          border: 'none',
          color: 'var(--color-text)',
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer',
          alignItems: 'flex-start',
        }}
      >
        <span
          style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0, marginTop: 4 }}
        />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <span
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: isCurrent ? 'var(--color-text)' : 'var(--color-text-muted)',
              fontWeight: isCurrent ? 600 : 400,
            }}
          >
            {ws.title || ws.ref}
          </span>
          {notifPreview && (
            <span
              style={{
                display: 'block',
                fontSize: 10,
                color: 'var(--color-text-subtle)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 1,
              }}
            >
              {notifPreview}
            </span>
          )}
          {status && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 10,
                color: status.color,
                marginTop: 2,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: status.color }} />
              {status.label}
            </span>
          )}
          {folder && (
            <span
              style={{
                display: 'block',
                fontSize: 10,
                color: 'var(--color-text-subtle)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 1,
              }}
            >
              ~/git/{folder}
            </span>
          )}
        </span>
        {unreadCount > 0 && (
          <span
            style={{
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor:
                status?.label === 'Needs input' || status?.label === 'Permission'
                  ? status.color
                  : 'var(--color-danger)',
              color: 'var(--color-accent-contrast)',
              fontSize: 10,
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 4px',
              flexShrink: 0,
              marginTop: 2,
            }}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {/* 閉じる: AlertDialog で確認（破壊的操作）。 */}
      <button
        type="button"
        onClick={onRequestClose}
        aria-label="Close workspace"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          background: 'none',
          border: 'none',
          color: 'var(--color-text-subtle)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <X size={18} />
      </button>
    </div>
  )
}

function WorkspaceList({
  workspaces,
  currentWorkspace,
  notifications,
  onSelect,
  onCloseWorkspace,
  onClose,
  isDesktop,
}: Omit<DrawerProps, 'open' | 'onNewWorkspace'> & { isDesktop: boolean }) {
  const unreadCounts = unreadCountByWorkspace(notifications)
  const latestNotifs = latestNotificationByWorkspace(notifications)
  // 閉じる確認の対象ワークスペース（null=ダイアログ非表示）。
  const [closing, setClosing] = useState<Workspace | null>(null)

  return (
    <>
      <ul style={{ listStyle: 'none', margin: 0, padding: '4px 0', flex: 1, overflowY: 'auto' }}>
        {workspaces.map((ws, i) => (
          <li key={ws.ref} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
            <WorkspaceItem
              ws={ws}
              index={i}
              isCurrent={ws.ref === currentWorkspace}
              unreadCount={unreadCounts.get(ws.id) ?? 0}
              notification={latestNotifs.get(ws.id)}
              onClick={() => {
                onSelect(ws.ref)
                if (!isDesktop) onClose()
              }}
              onRequestClose={() => setClosing(ws)}
            />
          </li>
        ))}
        {workspaces.length === 0 && (
          <li style={{ padding: '12px 16px', color: 'var(--color-text-subtle)', fontSize: 12 }}>No workspaces</li>
        )}
      </ul>

      <AlertDialog.Root open={closing !== null} onOpenChange={(o) => !o && setClosing(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay style={{ position: 'fixed', inset: 0, background: 'var(--color-scrim)', zIndex: 110 }} />
          <AlertDialog.Content
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'calc(100% - 32px)',
              maxWidth: 320,
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 10,
              color: 'var(--color-text)',
              padding: 20,
              zIndex: 111,
            }}
          >
            <AlertDialog.Title style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              ワークスペースを閉じる
            </AlertDialog.Title>
            <AlertDialog.Description style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 18 }}>
              「{closing?.title || closing?.ref}」を閉じますか？
            </AlertDialog.Description>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <AlertDialog.Cancel
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
              </AlertDialog.Cancel>
              <AlertDialog.Action
                onClick={() => {
                  if (closing) onCloseWorkspace(closing.ref)
                }}
                style={{
                  background: 'var(--color-danger)',
                  border: 'none',
                  borderRadius: 6,
                  color: 'var(--color-accent-contrast)',
                  fontSize: 14,
                  fontWeight: 600,
                  padding: '8px 16px',
                  cursor: 'pointer',
                }}
              >
                ワークスペースを閉じる
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  )
}

function NewWorkspaceButton({ onNewWorkspace }: { onNewWorkspace: () => Promise<void> }) {
  const [creating, setCreating] = useState(false)
  return (
    <button
      type="button"
      aria-label="New workspace"
      disabled={creating}
      onClick={async () => {
        if (creating) return
        setCreating(true)
        try {
          await onNewWorkspace()
        } finally {
          setCreating(false)
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        padding: '10px 12px',
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        background: 'none',
        border: 'none',
        borderTop: '1px solid var(--color-border-subtle)',
        color: creating ? 'var(--color-text-subtle)' : 'var(--color-text)',
        fontSize: 12,
        fontWeight: 600,
        textAlign: 'left',
        cursor: creating ? 'default' : 'pointer',
        flexShrink: 0,
      }}
    >
      <Plus size={15} />
      {creating ? '作成中…' : '新規ワークスペース'}
    </button>
  )
}

export { DESKTOP_BREAKPOINT, SIDEBAR_WIDTH }

export function Drawer({
  open,
  workspaces,
  currentWorkspace,
  notifications,
  onSelect,
  onCloseWorkspace,
  onNewWorkspace,
  onClose,
}: DrawerProps) {
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT

  const sidebarContent = (
    <WorkspaceList
      workspaces={workspaces}
      currentWorkspace={currentWorkspace}
      notifications={notifications}
      onSelect={onSelect}
      onCloseWorkspace={onCloseWorkspace}
      onClose={onClose}
      isDesktop={isDesktop}
    />
  )

  // Desktop/タブレット: ピン留めサイドバー（非モーダル）。開閉でスライドし本文が全幅になる。
  if (isDesktop) {
    return (
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: SIDEBAR_WIDTH,
          backgroundColor: 'var(--color-sidebar)',
          borderRight: '1px solid var(--color-border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          paddingTop: 'env(safe-area-inset-top)',
          zIndex: 50,
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.2s ease-out',
        }}
      >
        <div
          style={{
            padding: '0 12px',
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--color-text-subtle)',
            height: 44,
            display: 'flex',
            alignItems: 'center',
            borderBottom: '1px solid var(--color-border-subtle)',
          }}
        >
          cmux Remote
        </div>
        {sidebarContent}
        <NewWorkspaceButton onNewWorkspace={onNewWorkspace} />
      </nav>
    )
  }

  // Mobile: radix Dialog によるモーダルオーバーレイ（フォーカストラップ/Escape/スクロールロック）。
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="drawer-overlay"
          style={{ position: 'fixed', inset: 0, backgroundColor: 'var(--color-scrim)', zIndex: 90 }}
        />
        <Dialog.Content
          className="drawer-content"
          aria-describedby={undefined}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            bottom: 0,
            width: 260,
            backgroundColor: 'var(--color-sidebar)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            paddingTop: 'env(safe-area-inset-top)',
          }}
        >
          <Dialog.Title
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: 'hidden',
              clip: 'rect(0 0 0 0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          >
            ワークスペース
          </Dialog.Title>
          {sidebarContent}
          <NewWorkspaceButton onNewWorkspace={onNewWorkspace} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
