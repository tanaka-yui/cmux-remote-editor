import { describe, expect, it } from 'bun:test'
import { flattenSurfaces, rewriteRequest } from '../ws'

describe('rewriteRequest', () => {
  it('surface.list は system.tree へ書き換え、workspace_ref を保持する', () => {
    const out = rewriteRequest({ id: '1', method: 'surface.list', params: { workspace_ref: 'workspace:23' } })
    expect(out.wire).toEqual({ id: '1', method: 'system.tree', params: {} })
    expect(out.expectList).toBe(true)
    expect(out.workspaceRef).toBe('workspace:23')
  })

  it('surface.list は workspace_ref 未指定でも system.tree にする', () => {
    const out = rewriteRequest({ id: '2', method: 'surface.list', params: {} })
    expect(out.wire).toEqual({ id: '2', method: 'system.tree', params: {} })
    expect(out.expectList).toBe(true)
    expect(out.workspaceRef).toBeUndefined()
  })

  it('surface.create は type/focus 既定を注入し、呼び出し側 params を優先する', () => {
    const out = rewriteRequest({ id: '3', method: 'surface.create', params: { workspace_ref: 'workspace:23' } })
    expect(out.wire).toEqual({
      id: '3',
      method: 'surface.create',
      params: { type: 'terminal', focus: true, workspace_ref: 'workspace:23' },
    })
    expect(out.expectList).toBe(false)

    const override = rewriteRequest({ id: '4', method: 'surface.create', params: { type: 'browser' } })
    expect((override.wire.params as Record<string, unknown>).type).toBe('browser')
  })

  it('surface.read_text/send_text/send_key/close は素通しする', () => {
    for (const method of ['surface.read_text', 'surface.send_text', 'surface.send_key', 'surface.close']) {
      const req = { id: '9', method, params: { surface_ref: 'surface:44' } }
      const out = rewriteRequest(req)
      expect(out.wire).toEqual(req)
      expect(out.expectList).toBe(false)
    }
  })
})

describe('flattenSurfaces', () => {
  const tree = {
    windows: [
      {
        workspaces: [
          {
            ref: 'workspace:23',
            panes: [
              {
                ref: 'pane:26',
                surfaces: [{ ref: 'surface:44', selected: true, title: '[44] Claude Code', type: 'terminal' }],
              },
              {
                ref: 'pane:27',
                surfaces: [{ ref: 'surface:45', selected: true, title: 'shell', type: 'terminal' }],
              },
            ],
          },
          {
            ref: 'workspace:99',
            panes: [{ ref: 'pane:99', surfaces: [{ ref: 'surface:99', title: 'other', type: 'terminal' }] }],
          },
        ],
      },
    ],
  }

  it('split パネル含め全 pane の surface を flatten する', () => {
    const result = flattenSurfaces(tree, 'workspace:23')
    expect(result.map((s) => s.ref)).toEqual(['surface:44', 'surface:45'])
    expect(result[1].pane_ref).toBe('pane:27')
  })

  it('workspace 指定で対象外 workspace を除外する', () => {
    const result = flattenSurfaces(tree, 'workspace:99')
    expect(result.map((s) => s.ref)).toEqual(['surface:99'])
    expect(result[0].selected).toBe(false)
  })

  it('ブラウザサーフェスの url を保持し、ターミナルは url:null にする', () => {
    const browserTree = {
      windows: [
        {
          workspaces: [
            {
              ref: 'workspace:6',
              panes: [
                {
                  ref: 'pane:8',
                  surfaces: [
                    { ref: 'surface:1', title: 'shell', type: 'terminal' },
                    { ref: 'surface:2', title: 'Example Domain', type: 'browser', url: 'https://example.com/' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    const result = flattenSurfaces(browserTree, 'workspace:6')
    expect(result.map((s) => s.url)).toEqual([null, 'https://example.com/'])
    expect(result[1].type).toBe('browser')
  })
})
