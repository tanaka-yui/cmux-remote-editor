import { describe, expect, it } from 'vitest'

import {
  focus,
  initialize,
  MAX_LIVE_SUBSCRIPTIONS,
  pollPlan,
  reconcile,
  type SurfaceLike,
  type ViewState,
} from '../view-state'

// index は system.tree 順の位置。既定は ref の数値部分に合わせる。
const term = (ref: string, ws = 'workspace:1', active = false, index?: number): SurfaceLike => ({
  ref,
  type: 'terminal',
  workspace_ref: ws,
  index: index ?? Number(ref.split(':')[1] ?? 0),
  active,
})
const browser = (ref: string, ws = 'workspace:1', index?: number): SurfaceLike => ({
  ref,
  type: 'browser',
  workspace_ref: ws,
  index: index ?? Number(ref.split(':')[1] ?? 0),
})

// 不変条件は各テストの末尾で必ず呼ぶ。
function expectInvariants(state: ViewState, surfaces: readonly SurfaceLike[], cap = MAX_LIVE_SUBSCRIPTIONS) {
  const alive = new Map(surfaces.map((s) => [s.ref, s]))
  // I1
  if (state.foreground !== null) expect(alive.has(state.foreground)).toBe(true)
  // I2
  if (state.foreground !== null && alive.get(state.foreground)?.type === 'terminal') {
    expect(state.subscriptions.map((s) => s.ref)).toContain(state.foreground)
  }
  // I3
  for (const sub of state.subscriptions) {
    expect(alive.get(sub.ref)?.type).toBe('terminal')
  }
  // I4
  const refs = state.subscriptions.map((s) => s.ref)
  expect(new Set(refs).size).toBe(refs.length)
  // I5
  expect(state.subscriptions.length).toBeLessThanOrEqual(cap)
  // I6
  if (state.foreground === null) expect(state.foregroundWorkspaceRef).toBeNull()
  else expect(state.foregroundWorkspaceRef).toBe(alive.get(state.foreground)?.workspace_ref)
}

describe('initialize', () => {
  it('preferredRef が生存していればそれを前面にし、購読は 1 件だけ作る', () => {
    const surfaces = [term('surface:1'), term('surface:2'), term('surface:3')]
    const state = initialize(surfaces, 'surface:2', 1000)
    expect(state.foreground).toBe('surface:2')
    expect(state.subscriptions.map((s) => s.ref)).toEqual(['surface:2'])
    expectInvariants(state, surfaces)
  })

  it('preferredRef が無ければ active === true のサーフェスを採る', () => {
    const surfaces = [term('surface:1'), term('surface:2', 'workspace:1', true)]
    const state = initialize(surfaces, null, 1000)
    expect(state.foreground).toBe('surface:2')
    expectInvariants(state, surfaces)
  })

  it('preferredRef も active も無ければ先頭', () => {
    const surfaces = [term('surface:1'), term('surface:2')]
    expect(initialize(surfaces, null, 1000).foreground).toBe('surface:1')
  })

  it('preferredRef が生存一覧に無ければ無視して次の候補へ落ちる', () => {
    const surfaces = [term('surface:1')]
    expect(initialize(surfaces, 'surface:99', 1000).foreground).toBe('surface:1')
  })

  it('一覧が空なら foreground も foregroundWorkspaceRef も null', () => {
    const state = initialize([], null, 1000)
    expect(state.foreground).toBeNull()
    expect(state.foregroundWorkspaceRef).toBeNull()
    expect(state.subscriptions).toEqual([])
  })

  it('前面が browser なら購読集合は空になる（起動直後に 8 件まとめて購読しない）', () => {
    const surfaces = [browser('surface:9'), term('surface:1')]
    const state = initialize(surfaces, 'surface:9', 1000)
    expect(state.foreground).toBe('surface:9')
    expect(state.subscriptions).toEqual([])
    expectInvariants(state, surfaces)
  })
})

describe('focus', () => {
  it('terminal を選ぶと購読集合へ入り lastForegroundAt が更新される', () => {
    const surfaces = [term('surface:1'), term('surface:2')]
    const s0 = initialize(surfaces, 'surface:1', 1000)
    const s1 = focus(s0, surfaces[1] as SurfaceLike, 2000, MAX_LIVE_SUBSCRIPTIONS)
    expect(s1.foreground).toBe('surface:2')
    expect(s1.subscriptions.map((s) => s.ref).sort()).toEqual(['surface:1', 'surface:2'])
    expect(s1.subscriptions.find((s) => s.ref === 'surface:2')?.lastForegroundAt).toBe(2000)
    expectInvariants(s1, surfaces)
  })

  it('browser を選ぶと foreground だけ変わり購読集合は不変', () => {
    const surfaces = [term('surface:1'), browser('surface:9')]
    const s0 = initialize(surfaces, 'surface:1', 1000)
    const s1 = focus(s0, surfaces[1] as SurfaceLike, 2000, MAX_LIVE_SUBSCRIPTIONS)
    expect(s1.foreground).toBe('surface:9')
    expect(s1.subscriptions).toEqual(s0.subscriptions)
    expectInvariants(s1, surfaces)
  })

  it('cap を超えたら lastForegroundAt 最古を外す。前面自身は追い出さない', () => {
    const surfaces = [term('surface:1'), term('surface:2'), term('surface:3')]
    let state = initialize(surfaces, 'surface:1', 1000)
    state = focus(state, surfaces[1] as SurfaceLike, 2000, 2)
    state = focus(state, surfaces[2] as SurfaceLike, 3000, 2)
    expect(state.subscriptions.map((s) => s.ref).sort()).toEqual(['surface:2', 'surface:3'])
    expect(state.foreground).toBe('surface:3')
    expectInvariants(state, surfaces, 2)
  })

  it('lastForegroundAt が同値なら system.tree 順で後ろにあるものを先に外す', () => {
    const surfaces = [term('surface:1'), term('surface:2'), term('surface:3')]
    // 同時刻で 1 と 2 を購読させ、cap=2 のまま 3 を足す
    let state = initialize(surfaces, 'surface:1', 1000)
    state = focus(state, surfaces[1] as SurfaceLike, 1000, 3)
    state = focus(state, surfaces[2] as SurfaceLike, 1000, 2)
    // 同値なら tree 順で後ろ（surface:2）が先に外れ、surface:1 が残る
    expect(state.subscriptions.map((s) => s.ref).sort()).toEqual(['surface:1', 'surface:3'])
    expectInvariants(state, surfaces, 2)
  })

  it('tie-break は配列順ではなく treeIndex で決まる（選択順と tree 順が逆のケース）', () => {
    // tree 順は 1, 2, 3。選択順は 2 -> 1 -> 3 なので配列は [2, 1, 3] になる。
    // 配列後方で決めると surface:1 が外れてしまうが、正しくは tree 順で後ろの surface:2 が外れる。
    const surfaces = [term('surface:1'), term('surface:2'), term('surface:3')]
    let state = initialize(surfaces, 'surface:2', 1000)
    state = focus(state, surfaces[0] as SurfaceLike, 1000, 3)
    expect(state.subscriptions.map((s) => s.ref)).toEqual(['surface:2', 'surface:1'])
    state = focus(state, surfaces[2] as SurfaceLike, 1000, 2)
    expect(state.subscriptions.map((s) => s.ref).sort()).toEqual(['surface:1', 'surface:3'])
    expectInvariants(state, surfaces, 2)
  })

  it('すでに前面の terminal を選び直しても重複しない (I4)', () => {
    const surfaces = [term('surface:1')]
    const s0 = initialize(surfaces, 'surface:1', 1000)
    const s1 = focus(s0, surfaces[0] as SurfaceLike, 2000, MAX_LIVE_SUBSCRIPTIONS)
    expect(s1.subscriptions).toHaveLength(1)
    expectInvariants(s1, surfaces)
  })

  it('foregroundWorkspaceRef が前面のワークスペースへ追従する (I6)', () => {
    const surfaces = [term('surface:1', 'workspace:1'), term('surface:2', 'workspace:26')]
    const s0 = initialize(surfaces, 'surface:1', 1000)
    expect(s0.foregroundWorkspaceRef).toBe('workspace:1')
    const s1 = focus(s0, surfaces[1] as SurfaceLike, 2000, MAX_LIVE_SUBSCRIPTIONS)
    expect(s1.foregroundWorkspaceRef).toBe('workspace:26')
  })
})

describe('reconcile', () => {
  it('消えた ref を購読集合から外す', () => {
    const before = [term('surface:1'), term('surface:2')]
    let state = initialize(before, 'surface:1', 1000)
    state = focus(state, before[1] as SurfaceLike, 2000, MAX_LIVE_SUBSCRIPTIONS)
    const after = [term('surface:1')]
    const next = reconcile(state, after, 3000)
    expect(next.subscriptions.map((s) => s.ref)).toEqual(['surface:1'])
    expectInvariants(next, after)
  })

  it('退避順 1: 購読に残る中で lastForegroundAt が最も新しいもの', () => {
    const before = [term('surface:1'), term('surface:2'), term('surface:3')]
    let state = initialize(before, 'surface:1', 1000)
    state = focus(state, before[1] as SurfaceLike, 2000, MAX_LIVE_SUBSCRIPTIONS)
    state = focus(state, before[2] as SurfaceLike, 3000, MAX_LIVE_SUBSCRIPTIONS)
    const after = [term('surface:1'), term('surface:2')]
    const next = reconcile(state, after, 4000) // 前面 surface:3 が消えた
    expect(next.foreground).toBe('surface:2') // lastForegroundAt=2000 > 1000
    expectInvariants(next, after)
  })

  it('退避順 2: 購読が空なら foregroundWorkspaceRef と同じワークスペースの先頭', () => {
    const before = [
      term('surface:1', 'workspace:1'),
      term('surface:2', 'workspace:26'),
      term('surface:3', 'workspace:26'),
    ]
    const state = initialize(before, 'surface:2', 1000)
    // 前面 surface:2 が消える。購読は surface:2 だけだったので空になる。
    const after = [term('surface:1', 'workspace:1'), term('surface:3', 'workspace:26')]
    const next = reconcile(state, after, 2000)
    expect(next.foreground).toBe('surface:3') // 消えた前面と同じ workspace:26 の先頭
    expectInvariants(next, after)
  })

  it('退避順 3: 同じワークスペースにも無ければ生存一覧の先頭（＝別ワークスペースへ移る）', () => {
    const before = [term('surface:2', 'workspace:26')]
    const state = initialize(before, 'surface:2', 1000)
    const after = [term('surface:1', 'workspace:1')]
    const next = reconcile(state, after, 2000)
    expect(next.foreground).toBe('surface:1')
    expect(next.foregroundWorkspaceRef).toBe('workspace:1')
    expectInvariants(next, after)
  })

  it('退避順 4: 生存一覧が空なら null（cmux 全体が空のときだけ）', () => {
    const before = [term('surface:1')]
    const state = initialize(before, 'surface:1', 1000)
    const next = reconcile(state, [], 2000)
    expect(next.foreground).toBeNull()
    expect(next.foregroundWorkspaceRef).toBeNull()
    expectInvariants(next, [])
  })

  it('browser の前面が消えても退避順が働く', () => {
    const before = [browser('surface:9', 'workspace:26'), term('surface:3', 'workspace:26')]
    const state = initialize(before, 'surface:9', 1000)
    const after = [term('surface:3', 'workspace:26')]
    const next = reconcile(state, after, 2000)
    expect(next.foreground).toBe('surface:3')
    expectInvariants(next, after)
  })

  it('surface.move で ref が振り直されても、移動前のワークスペースの先頭へ移る', () => {
    // surface:118 が workspace:26 から移動し surface:119 として workspace:1 に現れた
    const before = [term('surface:118', 'workspace:26'), term('surface:3', 'workspace:26')]
    const state = initialize(before, 'surface:118', 1000)
    const after = [term('surface:119', 'workspace:1'), term('surface:3', 'workspace:26')]
    const next = reconcile(state, after, 2000)
    expect(next.foreground).toBe('surface:3') // 移動先を追いかけない
    expectInvariants(next, after)
  })

  it('外部でサーフェスが増えても、tie-break は現在の tree 順で決まる', () => {
    const before = [term('surface:5', 'workspace:1', false, 0), term('surface:6', 'workspace:1', false, 1)]
    let state = initialize(before, 'surface:5', 1000)
    state = focus(state, before[1] as SurfaceLike, 1000, 2)
    expect(state.subscriptions.map((s) => s.treeIndex)).toEqual([0, 1])
    // 外部で surface:1 が先頭に挿入され、5 と 6 の index が 1 つずつ後ろへずれる
    const after = [
      term('surface:1', 'workspace:1', false, 0),
      term('surface:5', 'workspace:1', false, 1),
      term('surface:6', 'workspace:1', false, 2),
    ]
    const next = reconcile(state, after, 2000)
    expect(next.subscriptions.map((s) => s.treeIndex).sort()).toEqual([1, 2])
    expectInvariants(next, after, 2)
  })

  it('前面が生きていれば何も変えない', () => {
    const surfaces = [term('surface:1'), term('surface:2')]
    const state = initialize(surfaces, 'surface:1', 1000)
    const next = reconcile(state, surfaces, 2000)
    expect(next.foreground).toBe('surface:1')
    expect(next.subscriptions).toEqual(state.subscriptions)
  })

  it('cap を小さくして focus した後も、reconcile は上限を保存する (I5)', () => {
    const surfaces = [term('surface:1'), term('surface:2')]
    let state = initialize(surfaces, 'surface:1', 1000)
    state = focus(state, surfaces[1] as SurfaceLike, 2000, 2)
    const after = [term('surface:2')]
    const next = reconcile(state, after, 3000)
    expectInvariants(next, after, 2)
  })
})

describe('pollPlan', () => {
  it('表示中は 1Hz、その他の購読は 3s、非購読と browser は含めない', () => {
    const surfaces = [term('surface:1'), term('surface:2'), term('surface:3'), browser('surface:9')]
    let state = initialize(surfaces, 'surface:1', 1000)
    state = focus(state, surfaces[1] as SurfaceLike, 2000, MAX_LIVE_SUBSCRIPTIONS)
    const plan = pollPlan(state, surfaces, ['surface:2'])
    expect(plan).toEqual(
      expect.arrayContaining([
        { ref: 'surface:2', intervalMs: 1000 },
        { ref: 'surface:1', intervalMs: 3000 },
      ]),
    )
    expect(plan.map((p) => p.ref)).not.toContain('surface:3')
    expect(plan.map((p) => p.ref)).not.toContain('surface:9')
  })

  it('visibleRefs が複数でも扱える（分割ビューの基盤。UR5）', () => {
    const surfaces = [term('surface:1'), term('surface:2')]
    let state = initialize(surfaces, 'surface:1', 1000)
    state = focus(state, surfaces[1] as SurfaceLike, 2000, MAX_LIVE_SUBSCRIPTIONS)
    const plan = pollPlan(state, surfaces, ['surface:1', 'surface:2'])
    expect(plan.every((p) => p.intervalMs === 1000)).toBe(true)
  })
})
