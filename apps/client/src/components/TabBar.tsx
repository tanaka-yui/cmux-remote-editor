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
        backgroundColor: '#16213e',
        borderBottom: '1px solid #2a2a4e',
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
              borderRight: '1px solid #2a2a4e',
              borderLeft: newPaneGroup ? '2px solid #4a4a6e' : undefined,
              backgroundColor: active ? '#1a1a2e' : 'transparent',
              borderBottom: active ? '2px solid #4caf50' : '2px solid transparent',
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
                color: active ? '#e0e0e0' : '#aaa',
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
                color: '#777',
                fontSize: 16,
                lineHeight: 1,
                padding: '0 2px',
                cursor: 'pointer',
              }}
            >
              &times;
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
          color: '#aaa',
          fontSize: 20,
          lineHeight: 1,
          padding: '0 14px',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        +
      </button>
    </div>
  )
}
