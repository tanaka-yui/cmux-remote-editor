import { Plus, X } from 'lucide-react'

import type { Surface } from '../lib/cmux-rpc'

interface TabBarProps {
  surfaces: Surface[]
  currentSurface: string | null
  onSelect: (ref: string) => void
  onClose: (ref: string) => void
  onCreate: () => void
}

// Strip the leading "[NN] " index prefix cmux adds to terminal titles.
function shortTitle(title: string): string {
  return title.replace(/^\[\d+\]\s*/, '').trim() || title
}

export function TabBar({ surfaces, currentSurface, onSelect, onClose, onCreate }: TabBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 38,
        backgroundColor: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      {surfaces.map((surface, i) => {
        const active = surface.ref === currentSurface
        // Mark the first tab of a new split pane to visually separate groups.
        const newPaneGroup = i > 0 && surface.pane_ref !== surfaces[i - 1]?.pane_ref
        return (
          <div
            key={surface.ref}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 10px',
              maxWidth: 180,
              borderRight: '1px solid var(--color-border)',
              borderLeft: newPaneGroup ? '2px solid var(--color-tab-group-border)' : undefined,
              backgroundColor: active ? 'var(--color-bg)' : 'transparent',
              borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <button
              type="button"
              onClick={() => onSelect(surface.ref)}
              style={{
                background: 'none',
                border: 'none',
                color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
                fontSize: 13,
                padding: 0,
                cursor: 'pointer',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 140,
              }}
            >
              {shortTitle(surface.title)}
            </button>
            <button
              type="button"
              onClick={() => onClose(surface.ref)}
              aria-label="Close tab"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-subtle)',
                padding: '0 2px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={onCreate}
        aria-label="New tab"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--color-text-muted)',
          padding: '0 14px',
          cursor: 'pointer',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Plus size={18} />
      </button>
    </div>
  )
}
