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
    // Keep the last one per workspace (API returns in order)
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

  if (body.includes('waiting for your input') || subtitle === 'waiting') {
    return { label: 'Needs input', color: '#F39C12' }
  }
  if (body.includes('permission')) {
    return { label: 'Permission', color: '#E74C3C' }
  }
  if (subtitle.includes('completed') || body.includes('完了')) {
    return { label: 'Idle', color: '#7f8c8d' }
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
  onCloseWorkspace,
}: {
  ws: Workspace
  index: number
  isCurrent: boolean
  unreadCount: number
  notification?: CmuxNotification
  onClick: () => void
  onCloseWorkspace: (ref: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const color = ws.custom_color ?? paletteColor(index)
  const folder = folderName(ws.current_directory)
  const status = deriveStatus(notification)

  // Truncate notification body for preview
  const notifPreview = notification?.body
    ? notification.body.slice(0, 60) + (notification.body.length > 60 ? '...' : '')
    : null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: isCurrent ? 'rgba(255, 255, 255, 0.08)' : 'none',
        borderLeft: `3px solid ${isCurrent ? color || '#64ffda' : 'transparent'}`,
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
          color: '#e0e0e0',
          fontSize: 12,
          textAlign: 'left',
          cursor: 'pointer',
          alignItems: 'flex-start',
        }}
      >
        {/* Color dot */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: color,
            flexShrink: 0,
            marginTop: 4,
          }}
        />

        {/* Content */}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {/* Title */}
          <span
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: isCurrent ? '#fff' : '#ccc',
              fontWeight: isCurrent ? 600 : 400,
            }}
          >
            {ws.title || ws.ref}
          </span>

          {/* Notification preview */}
          {notifPreview && (
            <span
              style={{
                display: 'block',
                fontSize: 10,
                color: '#999',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 1,
              }}
            >
              {notifPreview}
            </span>
          )}

          {/* Status badge */}
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
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: status.color,
                }}
              />
              {status.label}
            </span>
          )}

          {/* Folder path */}
          {folder && (
            <span
              style={{
                display: 'block',
                fontSize: 10,
                color: '#555',
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

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span
            style={{
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor:
                status?.label === 'Needs input' || status?.label === 'Permission' ? status.color : '#e74c3c',
              color: '#fff',
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

      {/* Close affordance: inline 2-step confirm (ワークスペース close は破壊的なため) */}
      {confirming ? (
        <>
          <button
            type="button"
            onClick={() => onCloseWorkspace(ws.ref)}
            aria-label="Confirm close"
            style={{
              background: 'none',
              border: 'none',
              color: '#e74c3c',
              fontSize: 15,
              fontWeight: 700,
              lineHeight: 1,
              padding: '0 6px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            &#10003;
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            aria-label="Cancel close"
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              fontSize: 15,
              lineHeight: 1,
              padding: '0 8px 0 2px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            &times;
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label="Close workspace"
          style={{
            background: 'none',
            border: 'none',
            color: '#777',
            fontSize: 16,
            lineHeight: 1,
            padding: '0 10px',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          &times;
        </button>
      )}
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
}: Omit<DrawerProps, 'open' | 'onNewWorkspace'>) {
  const unreadCounts = unreadCountByWorkspace(notifications)
  const latestNotifs = latestNotificationByWorkspace(notifications)

  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: '4px 0',
        flex: 1,
        overflowY: 'auto',
      }}
    >
      {workspaces.map((ws, i) => (
        <li key={ws.ref} style={{ borderBottom: '1px solid #1a2340' }}>
          <WorkspaceItem
            ws={ws}
            index={i}
            isCurrent={ws.ref === currentWorkspace}
            unreadCount={unreadCounts.get(ws.id) ?? 0}
            notification={latestNotifs.get(ws.id)}
            onClick={() => {
              onSelect(ws.ref)
              onClose()
            }}
            onCloseWorkspace={onCloseWorkspace}
          />
        </li>
      ))}
      {workspaces.length === 0 && <li style={{ padding: '12px 16px', color: '#666', fontSize: 12 }}>No workspaces</li>}
    </ul>
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
        borderTop: '1px solid #1e2a42',
        color: creating ? '#888' : '#e0e0e0',
        fontSize: 12,
        fontWeight: 600,
        textAlign: 'left',
        cursor: creating ? 'default' : 'pointer',
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
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
    />
  )

  // Desktop/タブレット: ピン留めサイドバー。既定で開いた状態（自動収納しない）だが、
  // ヘッダーのメニューボタンで開閉できる。閉じたら画面外へスライドし、本文が全幅になる。
  if (isDesktop) {
    return (
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: SIDEBAR_WIDTH,
          backgroundColor: '#0f1729',
          borderRight: '1px solid #1e2a42',
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
            color: '#888',
            height: 44,
            display: 'flex',
            alignItems: 'center',
            borderBottom: '1px solid #1e2a42',
          }}
        >
          cmux Remote
        </div>
        {sidebarContent}
        <NewWorkspaceButton onNewWorkspace={onNewWorkspace} />
      </nav>
    )
  }

  // Mobile: overlay drawer
  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close drawer"
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 90,
            border: 'none',
            padding: 0,
            cursor: 'default',
          }}
        />
      )}
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 260,
          backgroundColor: '#0f1729',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.2s ease-out',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          paddingTop: 'env(safe-area-inset-top)',
        }}
      >
        {sidebarContent}
        <NewWorkspaceButton onNewWorkspace={onNewWorkspace} />
      </nav>
    </>
  )
}
