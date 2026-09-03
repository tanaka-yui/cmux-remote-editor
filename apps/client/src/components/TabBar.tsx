import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

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

function tabLabel(surface: Surface, subscribed: boolean, activity: boolean): string {
  const name = `${surface.workspace_title} / ${shortTitle(surface.title)}`
  if (surface.type === 'browser') return `${name}、browser、購読対象外`
  return `${name}、${subscribed ? 'ライブ購読中' : '未購読'}${activity ? '、更新あり' : ''}`
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
  const [rovingRef, setRovingRef] = useState<string | null>(() => foreground ?? surfaces[0]?.ref ?? null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: 前面 ref の変化を 1 箇所で拾ってスクロールする。
  useEffect(() => {
    setRovingRef(foreground ?? surfaces[0]?.ref ?? null)
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [foreground])

  const select = (surface: Surface) => {
    setRovingRef(surface.ref)
    onSelect(surface)
  }

  const moveFocus = (tab: HTMLDivElement, direction: -1 | 1) => {
    const tabs = Array.from(tab.parentElement?.querySelectorAll<HTMLDivElement>('[role="tab"]') ?? [])
    const currentIndex = tabs.indexOf(tab)
    if (currentIndex < 0 || tabs.length === 0) return
    const next = tabs[(currentIndex + direction + tabs.length) % tabs.length]
    if (!next) return
    const nextRef = next.dataset.ref
    if (!nextRef) return
    setRovingRef(nextRef)
    next.focus()
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 38,
        backgroundColor: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}
    >
      <div role="tablist" style={{ display: 'flex', alignItems: 'stretch', flex: 1, minWidth: 0, overflowX: 'auto' }}>
        {surfaces.map((surface, index) => {
          const active = surface.ref === foreground
          const subscribed = surface.type !== 'browser' && subscribedRefs.has(surface.ref)
          const feed = feeds.get(surface.ref)
          const isError = feed?.status === 'error'
          const hasActivity = feed?.activity === true
          const hasLiveDot = surface.type !== 'browser' && (subscribed || isError)
          const startsWorkspace = index > 0 && surface.workspace_ref !== surfaces[index - 1]?.workspace_ref
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
              aria-label={tabLabel(surface, subscribed, hasActivity)}
              aria-selected={active}
              aria-keyshortcuts="Delete Backspace"
              aria-description="タブを閉じる"
              data-ref={surface.ref}
              tabIndex={surface.ref === rovingRef ? 0 : -1}
              onClick={(event) => {
                const target = event.target
                if (target instanceof Element && target.closest('[data-close-tab-hit]')) {
                  onClose(surface.ref)
                  return
                }
                select(surface)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault()
                  onClose(surface.ref)
                  return
                }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  moveFocus(event.currentTarget, event.key === 'ArrowLeft' ? -1 : 1)
                  return
                }
                if (event.key === ' ') {
                  event.preventDefault()
                  select(surface)
                  return
                }
                if (event.key === 'Enter') select(surface)
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
              {hasLiveDot ? (
                <span
                  aria-hidden="true"
                  data-testid="live-dot"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: isError
                      ? 'var(--color-warning)'
                      : hasActivity
                        ? 'var(--color-accent)'
                        : 'transparent',
                    border: isError || hasActivity ? 'none' : '1px solid var(--color-accent)',
                    boxSizing: 'border-box',
                    flexShrink: 0,
                  }}
                />
              ) : null}
              <span
                aria-hidden="true"
                data-close-tab-hit="true"
                data-testid="close-tab-hit"
                style={{
                  color: 'var(--color-text-subtle)',
                  padding: '0 2px',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <X size={14} />
              </span>
            </div>
          )
        })}
      </div>
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
