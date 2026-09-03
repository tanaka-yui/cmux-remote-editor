// 複数端末スイッチャの表示状態。UI も RPC も知らない純粋モジュール。
// 前面(foreground)と購読集合(subscriptions)を別々に更新すると「前面が購読集合の外を
// 指す」状態を作れてしまうため、1 つの値と 4 つの遷移関数に閉じ込める。

import type { RenderGrid } from './render-grid'
import type { CachedScreen } from './surface-cache'

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

export type FeedStatus = 'live' | 'warming' | 'loading' | 'error'

export type FeedSource = 'memory' | 'cache' | 'none'

export interface TerminalFeed {
  grid: RenderGrid | null
  history: string
  updatedAt: number | null
  activity: boolean
  // カーソル点滅を内容の変化とみなさないよう、row_spans だけをハッシュする（spec §10 R4）。
  contentHash: string
  status: FeedStatus
  source: FeedSource
  epoch: number
  promotedAt: number
}

export function describeFeed(
  feed: TerminalFeed | undefined,
): { kind: 'grid'; freshness: string | null } | { kind: 'message'; message: string; freshness: string | null } | null {
  if (!feed) return null
  const hhmmss = (time: number) => new Date(time).toTimeString().slice(0, 8)
  const hhmm = (time: number) => new Date(time).toTimeString().slice(0, 5)

  if (feed.status === 'error') {
    const freshness = feed.updatedAt === null ? '接続なし' : `接続なし · 最終 ${hhmm(feed.updatedAt)}`
    return feed.source === 'none' ? { kind: 'message', message: '接続なし', freshness } : { kind: 'grid', freshness }
  }
  if (feed.source === 'none') {
    return feed.status === 'live'
      ? { kind: 'message', message: '表示できる内容がありません（端末が停止しています）', freshness: null }
      : { kind: 'message', message: '読み込み中', freshness: null }
  }
  if (feed.status === 'live') return { kind: 'grid', freshness: null }
  if (feed.source === 'cache') {
    return { kind: 'grid', freshness: `オフライン時点の内容 · 最終 ${hhmm(feed.updatedAt ?? 0)}` }
  }
  return { kind: 'grid', freshness: `更新: ${hhmmss(feed.updatedAt ?? 0)}` }
}

export interface SwitcherState {
  view: ViewState
  feeds: Map<string, TerminalFeed>
}

export type SwitcherAction =
  | { type: 'select'; surface: SurfaceLike; now: number; cap: number }
  | { type: 'initialize'; surfaces: readonly SurfaceLike[]; preferredRef: string | null; now: number }
  | { type: 'reconcile'; surfaces: readonly SurfaceLike[]; now: number }
  | { type: 'feedResult'; ref: string; epoch: number; grid: RenderGrid | null; now: number }
  | { type: 'feedHistory'; ref: string; epoch: number; history: string }
  | { type: 'feedError'; ref: string; epoch: number }
  | { type: 'disconnected' }
  | { type: 'repromote'; now: number }

// F1〜F3。昇格ごとに epoch を進め、論理的な source で排他的に分岐する。
function promote(
  feeds: ReadonlyMap<string, TerminalFeed>,
  ref: string,
  now: number,
  readCache: (ref: string) => CachedScreen | null,
): TerminalFeed {
  const prev = feeds.get(ref)
  const base = { epoch: (prev?.epoch ?? 0) + 1, promotedAt: now, activity: false }

  if (prev?.source === 'memory') return { ...prev, ...base, status: 'warming' }
  if (prev?.source === 'cache') return { ...prev, ...base, status: 'warming' }
  if (!prev) {
    const cached = readCache(ref)
    if (cached && (cached.grid || cached.scrollback || cached.text)) {
      return {
        ...base,
        grid: cached.grid ?? null,
        history: cached.scrollback ?? cached.text ?? '',
        updatedAt: cached.updatedAt,
        contentHash: cached.grid === undefined ? '' : JSON.stringify(cached.grid.row_spans),
        status: 'warming',
        source: 'cache',
      }
    }
  }
  return {
    ...base,
    grid: null,
    history: '',
    updatedAt: prev?.updatedAt ?? null,
    contentHash: '',
    status: 'loading',
    source: 'none',
  }
}

// D3.2 の保持上限。購読中の feed と前面の feed は退避対象外にする。
function retain(feeds: Map<string, TerminalFeed>, view: ViewState): Map<string, TerminalFeed> {
  if (feeds.size <= MAX_RETAINED_FEEDS) return feeds
  const subscribed = new Set(view.subscriptions.map((subscription) => subscription.ref))
  const evictable = [...feeds.entries()]
    .filter(([ref]) => !subscribed.has(ref) && ref !== view.foreground)
    .sort((left, right) => left[1].promotedAt - right[1].promotedAt)
  const retained = new Map(feeds)
  for (const [ref] of evictable) {
    if (retained.size <= MAX_RETAINED_FEEDS) break
    retained.delete(ref)
  }
  return retained
}

export function createSwitcherReducer(
  readCache: (ref: string) => CachedScreen | null,
): (state: SwitcherState, action: SwitcherAction) => SwitcherState {
  return (state, action) => {
    // F5 / F5n / F7 / activity
    if (action.type === 'feedResult') {
      const feed = state.feeds.get(action.ref)
      // F7: 昇格前に開始した RPC の遅延応答を、開始時点の epoch で破棄する。
      if (!feed || feed.epoch !== action.epoch) return state

      // activity は取得開始時ではなく、結果を適用する時点の foreground で判定する。
      const isForeground = state.view.foreground === action.ref
      // cursor の移動だけを変化に数えないよう、内容の row_spans だけをハッシュする。
      const contentHash = action.grid === null ? '' : JSON.stringify(action.grid.row_spans)
      const changed = contentHash !== '' && feed.contentHash !== '' && contentHash !== feed.contentHash
      const activity = isForeground ? false : feed.activity || changed

      const next: TerminalFeed =
        action.grid === null
          ? {
              ...feed,
              grid: null,
              history: '',
              contentHash: '',
              status: 'live',
              source: 'none',
              updatedAt: action.now,
              activity,
            }
          : {
              ...feed,
              grid: action.grid,
              contentHash,
              status: 'live',
              source: 'memory',
              updatedAt: action.now,
              activity,
            }
      return { view: state.view, feeds: new Map(state.feeds).set(action.ref, next) }
    }

    if (action.type === 'feedHistory') {
      const feed = state.feeds.get(action.ref)
      if (!feed || feed.epoch !== action.epoch) return state
      return {
        view: state.view,
        feeds: new Map(state.feeds).set(action.ref, { ...feed, history: action.history }),
      }
    }

    // F6: source と描画中フレームを保持したまま error にする。
    if (action.type === 'feedError') {
      const feed = state.feeds.get(action.ref)
      if (!feed || feed.epoch !== action.epoch) return state
      return {
        view: state.view,
        feeds: new Map(state.feeds).set(action.ref, { ...feed, status: 'error' }),
      }
    }

    // F8: 切断時も最後に描画できたフレームと source を保持する。
    if (action.type === 'disconnected') {
      const feeds = new Map<string, TerminalFeed>()
      for (const [ref, feed] of state.feeds) feeds.set(ref, { ...feed, status: 'error' })
      return { view: state.view, feeds }
    }

    // F9: subscriptions が不変でも、再接続では全購読 feed の epoch を進めて再昇格する。
    if (action.type === 'repromote') {
      const feeds = new Map(state.feeds)
      for (const subscription of state.view.subscriptions) {
        feeds.set(subscription.ref, promote(state.feeds, subscription.ref, action.now, readCache))
      }
      return { view: state.view, feeds }
    }

    const nextView =
      action.type === 'select'
        ? focus(state.view, action.surface, action.now, action.cap)
        : action.type === 'initialize'
          ? initialize(action.surfaces, action.preferredRef, action.now)
          : reconcile(state.view, action.surfaces, action.now)

    // F1〜F3 は、この action で subscriptions に新しく加わった ref だけに適用する。
    const previousRefs = new Set(state.view.subscriptions.map((subscription) => subscription.ref))
    const addedRefs = nextView.subscriptions
      .map((subscription) => subscription.ref)
      .filter((ref) => !previousRefs.has(ref))
    if (addedRefs.length === 0) return { view: nextView, feeds: state.feeds }

    const feeds = new Map(state.feeds)
    for (const ref of addedRefs) feeds.set(ref, promote(state.feeds, ref, action.now, readCache))
    return { view: nextView, feeds: retain(feeds, nextView) }
  }
}
