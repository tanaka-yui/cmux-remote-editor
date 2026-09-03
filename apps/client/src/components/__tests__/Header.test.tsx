// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Header } from '../Header'

describe('Header', () => {
  it('長い端末名をヘッダー内で縮めて省略する', () => {
    render(
      <Header
        workspaceTitle="workspace"
        surfaceTitle="[3] claude — cmux-remote-editor with a very long title"
        onMenuToggle={vi.fn()}
        status="connected"
        freshness={null}
        onOpenSettings={vi.fn()}
      />,
    )

    const title = screen.getByText('[3] claude — cmux-remote-editor with a very long title')
    expect(title.style.minWidth).toBe('0px')
    expect(title.style.overflow).toBe('hidden')
    expect(title.style.textOverflow).toBe('ellipsis')
    expect(title.style.flexShrink).not.toBe('0')
  })
})
