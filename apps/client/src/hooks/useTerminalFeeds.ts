import { useEffect, useMemo, useRef } from 'react'

import type { RenderGrid } from '../lib/render-grid'
import { isStaleSurfaceError } from '../lib/rpc-error'
import { stripVisibleScreen, visibleLineCount } from '../lib/scrollback'
import { saveSurfaceScreen } from '../lib/surface-cache'
import type { SurfaceLike, TerminalFeed, ViewState } from '../lib/view-state'
import { BACKGROUND_STAGGER, pollPlan } from '../lib/view-state'
import type { TopologySnapshot } from './useCmux'
import type { ConnectionStatus } from './useWebSocket'

const isDocumentHidden = (): boolean => document.visibilityState === 'hidden'

export interface UseTerminalFeedsProps {
  status: ConnectionStatus
  view: ViewState
  surfaces: readonly SurfaceLike[]
  feeds: ReadonlyMap<string, TerminalFeed>
  visibleRefs: readonly string[]
  pinned: boolean
  historyLines: number
  readGrid: (ref: string) => Promise<RenderGrid | null>
  readText: (ref: string, opts: { scrollback: boolean; lines: number }) => Promise<string>
  applyFeedResult: (a: { ref: string; epoch: number; grid: RenderGrid | null; now: number }) => void
  applyFeedHistory: (a: { ref: string; epoch: number; history: string }) => void
  applyFeedError: (a: { ref: string; epoch: number }) => void
  requestTopologyRefresh: () => Promise<TopologySnapshot>
  // F8 / F9。status の edge でだけ呼ぶ（同じ status での再 render では呼ばない）。
  markDisconnected: () => void
  repromote: () => void
}

export function useTerminalFeeds(props: UseTerminalFeedsProps): void {
  // 分割代入するのは effect の依存に使う値だけにする。feeds / pinned / historyLines は
  // await 後に latest.current から読むので、ここでローカルに取ると noUnusedLocals で止まる。
  const { status, view, surfaces, visibleRefs } = props

  // 毎ポーリング変わる値は ref 経由で読む。effect の依存に入れるとタイマーが張り直される。
  const latest = useRef(props)
  latest.current = props

  const plan = useMemo(() => pollPlan(view, surfaces, visibleRefs), [view, surfaces, visibleRefs])
  // 依存の同一性を保つため、計画を「ref:interval」の文字列に畳んで比較する。
  const planKey = plan.map((p) => `${p.ref}:${p.intervalMs}`).join(',')

  const inFlightRef = useRef(new Set<string>())
  const staleResyncRef = useRef(new Set<string>())
  const lastGridJsonRef = useRef(new Map<string, string>())
  const lastScrollbackRef = useRef(new Map<string, string>())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: planKey が plan の ref・順序・前背面 interval を代表し、更新頻度の高い値は latest から読む。
  useEffect(() => {
    if (status !== 'connected') return
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    let stopped = false
    const shouldDiscardResponse = () =>
      !mountedRef.current || latest.current.status !== 'connected' || isDocumentHidden()

    // タイマーは ref ごとに常に 1 本。張る前に既存を必ず clear する。
    const arm = (ref: string, intervalMs: number, delay: number) => {
      if (stopped) return
      const existing = timers.get(ref)
      if (existing) clearTimeout(existing)
      timers.set(
        ref,
        setTimeout(() => void cycle(ref, intervalMs), delay),
      )
    }

    const cycle = async (ref: string, intervalMs: number) => {
      if (stopped) return
      // E4: hidden 中はタイマーを張らない。ここで予約しないでよいのは、
      // 復帰ハンドラ（下の resume）が **全 plan entry** を張り直すからである
      // （前面は 0ms、背面は interval + stagger）。
      if (isDocumentHidden()) return
      // E2: サーフェスごとの in-flight は常に 1 件まで。
      if (inFlightRef.current.has(ref)) {
        arm(ref, intervalMs, intervalMs)
        return
      }
      inFlightRef.current.add(ref)
      // **開始時点で固定してよいのは epoch だけ**である。
      // F7: 適用可否は epoch の一致で判定する。時刻（promotedAt 以降か）では、
      // 追い出し前に開始した RPC が再昇格の後に返るケースを除外できない。
      const epoch = latest.current.feeds.get(ref)?.epoch ?? 0
      try {
        const grid = await latest.current.readGrid(ref)
        // E4: 取得中に hidden になった応答、および切断・unmount 後の応答は反映しない。
        // hidden からの復帰時は onVisibility が全 plan entry を張り直す。
        if (shouldDiscardResponse()) return
        // **await の後は必ず latest.current を読み直す。** 開始時点の isVisible を
        // 使い回すと、待機中に別端末へ切り替えたときに「もう背面になった ref」へ
        // scrollback RPC を投げ、localStorage にも書いてしまう（C1/C6 と
        // 「背面では scrollback を取らない」の両方に反する）。
        const p = latest.current
        const isVisible = p.visibleRefs.includes(ref)
        const now = Date.now()
        p.applyFeedResult({ ref, epoch, grid, now })
        staleResyncRef.current.delete(ref)

        // C1/C6: 永続化するのは前面かつ内容変化時のみ。背面の grid を 3 秒ごとに
        // 同期書き込みしない。
        if (isVisible && grid) {
          const json = JSON.stringify(grid)
          if (json !== lastGridJsonRef.current.get(ref)) {
            lastGridJsonRef.current.set(ref, json)
            saveSurfaceScreen(ref, { grid, updatedAt: now })
          }
        }

        // E5: 前面のサイクルは replay →（ピン留め中のみ）read_text で 1 サイクル。
        // alternate screen(TUI)にスクロールバックの概念は無く、停止端末(grid なし)は
        // read_text 自体が失敗するため、いずれも取得しない。
        if (isVisible && p.pinned && grid && grid.active_screen !== 'alternate') {
          const text = await p.readText(ref, { scrollback: true, lines: p.historyLines })
          // read_text の待機中に hidden・unpin・**前面の切替**が起きた応答は反映しない。
          // grid 側だけ確認して history 側を素通しすると、背面になった ref の
          // state と localStorage が更新される。
          const after = latest.current
          if (shouldDiscardResponse() || !after.pinned || !after.visibleRefs.includes(ref)) return
          after.applyFeedHistory({ ref, epoch, history: stripVisibleScreen(text, visibleLineCount(grid)) })
          if (text !== lastScrollbackRef.current.get(ref)) {
            lastScrollbackRef.current.set(ref, text)
            saveSurfaceScreen(ref, { scrollback: text, updatedAt: now })
          }
        }
      } catch (err) {
        // 待機中に hidden になってから返った rejection も反映しない
        // （hidden 中に applyFeedError と T4 の topology refresh が走ってしまう）。
        if (shouldDiscardResponse()) return
        const p = latest.current
        // T4: 閉じられた surface を指すと cmux は「Missing or invalid terminal_id」を
        // 返し続ける。一覧を取り直せば reconcile が生きた surface へ退避する。
        // ref ごとに 1 回だけ試みてループを防ぐ。
        // stale でも取得は失敗しているので、F6 の error 遷移は必ず行う。
        p.applyFeedError({ ref, epoch })
        if (isStaleSurfaceError(err) && !staleResyncRef.current.has(ref)) {
          staleResyncRef.current.add(ref)
          p.requestTopologyRefresh().catch(() => {
            staleResyncRef.current.delete(ref)
          })
        }
      } finally {
        inFlightRef.current.delete(ref)
        // E1: 完了してから次回を予約する。開始時刻を起点に遅れを取り戻さない。
        // hidden 中は張らない（復帰時に resume が全件張り直す。E4）。
        if (!isDocumentHidden()) arm(ref, intervalMs, intervalMs)
      }
    }

    // E3: 背面の初回発火を index * BACKGROUND_STAGGER だけずらす（burst の平準化）。
    // hidden のまま mount した場合や、hidden 中に status / planKey が変わって effect が
    // 作り直された場合は **1 本も張らない**（E4 の「hidden 中はタイマーを張らない」）。
    // 復帰は下の onVisibility が担当する。
    if (!isDocumentHidden()) {
      let backgroundIndex = 0
      for (const entry of plan) {
        const delay = visibleRefs.includes(entry.ref) ? 0 : backgroundIndex++ * BACKGROUND_STAGGER
        arm(entry.ref, entry.intervalMs, delay)
      }
    }

    // E4: hidden になったら全タイマーを clear し、復帰したら全件を張り直す。
    // 「前面のみ再開」ではいけない — 背面を張り直さないと復帰後も止まったままになる。
    // 前面は 0ms（即時再取得）、背面は interval + stagger（次の周期から、burst を避ける）。
    const clearAll = () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
    const onVisibility = () => {
      if (stopped) return
      if (isDocumentHidden()) {
        clearAll()
        return
      }
      let bg = 0
      for (const entry of plan) {
        const isVisible = latest.current.visibleRefs.includes(entry.ref)
        arm(entry.ref, entry.intervalMs, isVisible ? 0 : entry.intervalMs + bg++ * BACKGROUND_STAGGER)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onVisibility)
    window.addEventListener('focus', onVisibility)

    return () => {
      stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
    // feeds は依存に入れない（毎ポーリング変わるため。最新値は latest.current から読む）。
  }, [status, planKey])

  // F8 / F9。status の edge でだけ dispatch する（同じ status での再 render では呼ばない）。
  const prevStatusRef = useRef(status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (prev === status) return
    if (status === 'connected') latest.current.repromote()
    else latest.current.markDisconnected()
  }, [status])
}
