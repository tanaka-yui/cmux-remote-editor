import { Plus, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { Surface } from '../lib/cmux-rpc'
import type { TerminalFeed } from '../lib/view-state'

interface TabBarProps {
  surfaces: Surface[]
  foreground: string | null
  subscribedRefs: ReadonlySet<string>
  feeds: ReadonlyMap<string, TerminalFeed>
  workspaceColor: (workspaceRef: string) => string
  onSelect: (surface: Surface) => void
  onClose: (ref: string) => void
  onCreate: () => void
}

// Strip the leading "[NN] " index prefix cmux adds to terminal titles.
function shortTitle(title: string): string {
  return title.replace(/^\[\d+\]\s*/, '').trim() || title
}

function tabLabel(surface: Surface, subscribed: boolean): string {
  const name = `${surface.workspace_title} / ${shortTitle(surface.title)}`
  if (surface.type === 'browser') return `${name}、browser、購読対象外`
  return `${name}、${subscribed ? 'ライブ購読中' : '未購読'}`
}

export function TabBar({
  surfaces,
  foreground,
  subscribedRefs,
  feeds,
  workspaceColor,
  onSelect,
  onClose,
  onCreate,
}: TabBarProps) {
  const activeRef = useRef<HTMLDivElement | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: 前面 ref の変化を 1 箇所で拾ってスクロールする。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [foreground])

  return (
    <div
      role="tablist"
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
      {surfaces.map((surface, index) => {
        const active = surface.ref === foreground
        const subscribed = surface.type !== 'browser' && subscribedRefs.has(surface.ref)
        const feed = feeds.get(surface.ref)
        const isError = feed?.status === 'error'
        const startsWorkspace = index > 0 && surface.workspace_ref !== surfaces[index - 1]?.workspace_ref
        const liveDotSize = feed?.activity ? 6 : 5
        const titleColor = isError
          ? 'var(--color-text-subtle)'
          : subscribed
            ? 'var(--color-text)'
            : 'var(--color-text-muted)'

        return (
          <div
            key={surface.ref}
            ref={active ? activeRef : null}
            role="tab"
            aria-label={tabLabel(surface, subscribed)}
            aria-selected={active}
            data-ref={surface.ref}
            tabIndex={0}
            onClick={() => onSelect(surface)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect(surface)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 10px',
              maxWidth: 180,
              borderRight: '1px solid var(--color-border)',
              borderLeft: startsWorkspace ? '2px solid var(--color-tab-group-border)' : undefined,
              backgroundColor: active ? 'var(--color-bg)' : 'transparent',
              borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 4,
                height: 4,
                borderRadius: '50%',
                backgroundColor: workspaceColor(surface.workspace_ref),
                flexShrink: 0,
              }}
            />
            <span
              style={{
                color: titleColor,
                fontSize: 13,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 140,
              }}
            >
              {shortTitle(surface.title)}
            </span>
            {subscribed ? (
              <span
                aria-hidden="true"
                data-testid="live-dot"
                style={{
                  width: liveDotSize,
                  height: liveDotSize,
                  borderRadius: '50%',
                  backgroundColor: isError ? 'var(--color-warning)' : 'var(--color-accent)',
                  flexShrink: 0,
                }}
              />
            ) : null}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onClose(surface.ref)
              }}
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
