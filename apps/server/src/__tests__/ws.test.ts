import { describe, expect, it } from 'bun:test'
import { createLineFramer, flattenSurfaces, rewriteRequest } from '../ws'

describe('createLineFramer', () => {
  it('チャンク境界で割れたマルチバイト文字(絵文字)を復元する', () => {
    const framer = createLineFramer()
    const line = `${JSON.stringify({ text: '🙌あ' })}\n`
    const bytes = Buffer.from(line, 'utf8')
    // 絵文字(🙌 = F0 9F 99 8C)の途中で分割する。
    const cut = bytes.indexOf(0xf0) + 2
    const out = [...framer.push(bytes.subarray(0, cut)), ...framer.push(bytes.subarray(cut))]
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0] as string).text).toBe('🙌あ')
  })

  it('複数行・末尾の不完全行を跨いで完全な行だけ返す', () => {
    const framer = createLineFramer()
    expect(framer.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":', 'utf8'))).toEqual(['{"a":1}', '{"b":2}'])
    expect(framer.push(Buffer.from('3}\n', 'utf8'))).toEqual(['{"c":3}'])
  })

  it('空行は除外する', () => {
    const framer = createLineFramer()
    expect(framer.push(Buffer.from('\n\n{"a":1}\n', 'utf8'))).toEqual(['{"a":1}'])
  })
})

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
      params: { type: 'terminal', focus: false, workspace_ref: 'workspace:23' },
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

  const treeWithTwoWorkspaces = {
    windows: [
      {
        workspaces: [
          {
            ref: 'workspace:1',
            id: 'C459840B-0000-0000-0000-000000000001',
            title: 'influencer-platform',
            panes: [
              { ref: 'pane:1', surfaces: [{ ref: 'surface:1', title: '[1] zsh', type: 'terminal', selected: true }] },
            ],
          },
          {
            ref: 'workspace:26',
            id: 'C459840B-0000-0000-0000-000000000026',
            title: 'freelance-jp-app',
            panes: [
              {
                ref: 'pane:9',
                surfaces: [
                  { ref: 'surface:98', title: '[7] vim', type: 'terminal', selected: true },
                  { ref: 'surface:99', title: 'docs', type: 'browser', url: 'https://example.com' },
                ],
              },
            ],
          },
        ],
      },
    ],
    active: { workspace_ref: 'workspace:26', surface_ref: 'surface:98' },
  }

  it('全ワークスペースの各行に workspace_ref / workspace_title / workspace_id を付ける', () => {
    const out = flattenSurfaces(treeWithTwoWorkspaces)
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({
      ref: 'surface:1',
      workspace_ref: 'workspace:1',
      workspace_title: 'influencer-platform',
      workspace_id: 'C459840B-0000-0000-0000-000000000001',
    })
    expect(out[2]).toMatchObject({
      ref: 'surface:99',
      workspace_ref: 'workspace:26',
      workspace_title: 'freelance-jp-app',
      url: 'https://example.com',
    })
  })

  it('active は result.active.surface_ref と一致する 1 件だけ true になる', () => {
    const out = flattenSurfaces(treeWithTwoWorkspaces)
    expect(out.filter((s) => s.active)).toHaveLength(1)
    expect(out.find((s) => s.active)?.ref).toBe('surface:98')
  })

  it('selected は複数 true になり得るが active は 1 件に保たれる', () => {
    const out = flattenSurfaces(treeWithTwoWorkspaces)
    expect(out.filter((s) => s.selected).length).toBeGreaterThan(1)
    expect(out.filter((s) => s.active)).toHaveLength(1)
  })

  it('active が tree に無ければ全件 false', () => {
    const out = flattenSurfaces({ ...treeWithTwoWorkspaces, active: undefined })
    expect(out.every((s) => !s.active)).toBe(true)
  })
})

describe('rewriteRequest の surface.create 既定 (D6.1)', () => {
  it('focus:false を注入する', () => {
    const out = rewriteRequest({ id: '1', method: 'surface.create', params: {} })
    expect(out.wire.params).toMatchObject({ type: 'terminal', focus: false })
  })

  it('呼び出し側が渡した workspace_id と focus は上書きしない', () => {
    const out = rewriteRequest({
      id: '1',
      method: 'surface.create',
      params: { workspace_id: 'C459840B-0000-0000-0000-000000000026', focus: true },
    })
    expect(out.wire.params).toMatchObject({
      type: 'terminal',
      focus: true,
      workspace_id: 'C459840B-0000-0000-0000-000000000026',
    })
  })
})
