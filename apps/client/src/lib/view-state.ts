// 複数端末スイッチャの表示状態。UI も RPC も知らない純粋モジュール。
// 前面(foreground)と購読集合(subscriptions)を別々に更新すると「前面が購読集合の外を
// 指す」状態を作れてしまうため、1 つの値と 4 つの遷移関数に閉じ込める。

export const MAX_LIVE_SUBSCRIPTIONS = 8
export const MAX_RETAINED_FEEDS = 24
export const FOREGROUND_POLL_INTERVAL = 1000
export const BACKGROUND_POLL_INTERVAL = 3000
export const BACKGROUND_STAGGER = 400
export const TOPOLOGY_POLL_INTERVAL = 5000

// サーバーの FlatSurface のうち、このモジュールが必要とする最小の形。
export interface SurfaceLike {
  ref: string
  type: string
  workspace_ref: string
  // 全ワークスペースを平坦化した system.tree 順の位置（FlatSurface.index）。
  // LRU の tie-break に使う。focus は一覧を受け取らないので、購読へ入れる時点で写し取る。
  index: number
  // system.tree の result.active.surface_ref と一致する 1 件だけ true（D7）。
  active?: boolean
}

export interface ViewState {
  // 購読中サーフェスの ref。配列の順序は「購読へ入れた順」であって tree 順ではない
  // （focus は選んだ ref を一度除いて末尾へ足すため、実体は選択履歴になる）。
  // したがって tie-break には配列 index ではなく treeIndex を使う。
  subscriptions: { ref: string; lastForegroundAt: number; treeIndex: number }[]
  foreground: string | null
  // 前面のワークスペース。foreground と必ず同時に更新する。消えた前面の退避（reconcile の
  // 退避順 2）は、消えた ref から辿れないためこの値を使う。
  foregroundWorkspaceRef: string | null
}

const isTerminal = (s: SurfaceLike): boolean => s.type !== 'browser'

function withForeground(subscriptions: ViewState['subscriptions'], surface: SurfaceLike | null): ViewState {
  return {
    subscriptions,
    foreground: surface?.ref ?? null,
    foregroundWorkspaceRef: surface?.workspace_ref ?? null,
  }
}

// 追い出し候補の選定。lastForegroundAt が最古のものを外す。
// 同値のときは treeIndex が大きい（system.tree 順で後ろの）ものを先に外す。
// 配列 index で代用してはならない — subscriptions の並びは選択履歴であって tree 順ではない。
// 前面自身(keepRef)は候補から除く（I2 を破らないため）。
function evict(subscriptions: ViewState['subscriptions'], keepRef: string, cap: number): ViewState['subscriptions'] {
  const out = [...subscriptions]
  while (out.length > cap) {
    let worstIdx = -1
    for (let i = 0; i < out.length; i++) {
      const entry = out[i]
      if (!entry || entry.ref === keepRef) continue
      const worst = worstIdx >= 0 ? out[worstIdx] : undefined
      if (!worst) {
        worstIdx = i
        continue
      }
      if (entry.lastForegroundAt < worst.lastForegroundAt) worstIdx = i
      else if (entry.lastForegroundAt === worst.lastForegroundAt && entry.treeIndex > worst.treeIndex) worstIdx = i
    }
    if (worstIdx < 0) break // 前面しか残っていない
    out.splice(worstIdx, 1)
  }
  return out
}

// タブ/ドロワーからサーフェスを選ぶ。terminal なら購読集合へ入れ、あふれたら
// lastForegroundAt 最古を外す（foreground 自身は追い出さない。I2 を破らないため）。
// browser なら foreground だけ更新し、購読集合には触れない（I3）。
// 対象の type が必要なので ref ではなく SurfaceLike を受け取る。
// cap の事前条件は 1 <= cap <= MAX_LIVE_SUBSCRIPTIONS。I5 は cap を上限として検査する。
export function focus(state: ViewState, surface: SurfaceLike, now: number, cap: number): ViewState {
  if (!isTerminal(surface)) return withForeground(state.subscriptions, surface)
  const without = state.subscriptions.filter((s) => s.ref !== surface.ref)
  const next = [...without, { ref: surface.ref, lastForegroundAt: now, treeIndex: surface.index }]
  return withForeground(evict(next, surface.ref, cap), surface)
}

// 生存一覧に合わせて掃除する。消えた ref を subscriptions から外し、
// foreground が消えていたら D3 の退避順で選び直す。
// 退避順 2 に必要な「消えた前面のワークスペース」は state.foregroundWorkspaceRef から取る
// （消えた ref は surfaces に無いので、新しい一覧からは引けない）。
export function reconcile(state: ViewState, surfaces: readonly SurfaceLike[], now: number): ViewState {
  const alive = new Map(surfaces.map((s) => [s.ref, s]))
  const subscriptions = state.subscriptions
    .filter((s) => {
      const surface = alive.get(s.ref)
      return surface !== undefined && isTerminal(surface)
    })
    // treeIndex を現在の tree 順へ写し直す。外部で前方のサーフェスが増減すると
    // 生存サーフェスの index は変わるので、購読時の値を固定したままだと
    // tie-break が「現在の system.tree 順」を表さなくなる。
    .map((s) => ({ ...s, treeIndex: (alive.get(s.ref) as SurfaceLike).index }))

  const current = state.foreground === null ? undefined : alive.get(state.foreground)
  if (current) return { ...state, subscriptions }

  // 退避順 1: 購読に残る中で lastForegroundAt が最も新しいもの
  const newest = [...subscriptions].sort((a, b) => b.lastForegroundAt - a.lastForegroundAt)[0]
  if (newest) return withForeground(subscriptions, alive.get(newest.ref) as SurfaceLike)

  // 退避順 2: 消えた前面と同じワークスペースの先頭
  const sameWs = surfaces.find((s) => s.workspace_ref === state.foregroundWorkspaceRef)
  // 退避順 3: 生存一覧の先頭（別ワークスペースへ移る）／ 4: 空なら null
  const next = sameWs ?? surfaces[0] ?? null
  if (next === null) return withForeground([], null)
  return focus({ subscriptions, foreground: null, foregroundWorkspaceRef: null }, next, now, MAX_LIVE_SUBSCRIPTIONS)
}

// 初期化。preferredRef は「ディープリンク → sessionStorage の前回前面」の順で
// 呼び出し側が 1 個に解決して渡す。どちらも無ければ null。
// initialize 内部では preferredRef -> s.active -> 先頭 の順で決める（D3）。
// 初期購読集合は「前面が terminal ならそれ 1 件だけ、browser または null なら空」。
// 先頭から cap 件まとめて購読することはしない（理由は D6）。
export function initialize(surfaces: readonly SurfaceLike[], preferredRef: string | null, now: number): ViewState {
  const preferred = preferredRef === null ? undefined : surfaces.find((s) => s.ref === preferredRef)
  const chosen = preferred ?? surfaces.find((s) => s.active === true) ?? surfaces[0] ?? null
  if (chosen === null) return withForeground([], null)
  return focus(
    { subscriptions: [], foreground: null, foregroundWorkspaceRef: null },
    chosen,
    now,
    MAX_LIVE_SUBSCRIPTIONS,
  )
}

// ポーリング計画。表示中(visibleRefs)は 1Hz、その他の購読は 3s、非購読と browser は含めない。
// visibleRefs を集合で受けるのは、分割ビュー(UR5)で「表示中」が複数になっても
// この API の形を変えずに済ませるため。今回は常に foreground 1 件だけを渡す。
export function pollPlan(
  state: ViewState,
  surfaces: readonly SurfaceLike[],
  visibleRefs: readonly string[],
): { ref: string; intervalMs: number }[] {
  const alive = new Map(surfaces.map((s) => [s.ref, s]))
  const visible = new Set(visibleRefs)
  return state.subscriptions
    .filter((s) => {
      const surface = alive.get(s.ref)
      return surface !== undefined && isTerminal(surface)
    })
    .map((s) => ({
      ref: s.ref,
      intervalMs: visible.has(s.ref) ? FOREGROUND_POLL_INTERVAL : BACKGROUND_POLL_INTERVAL,
    }))
}
