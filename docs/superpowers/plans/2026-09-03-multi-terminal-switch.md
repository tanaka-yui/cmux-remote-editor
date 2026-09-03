# 複数端末の同時接続と切り替え Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA が複数の cmux 端末を同時にライブ購読し、ワークスペースを跨いだ 1 本のタブ行から即座に切り替えられるようにする（cmux 本体の選択状態には一切触れない）。

**Architecture:** 表示状態（前面 + 購読集合）と端末ごとのフィードを 1 つの合成状態 `SwitcherState` にまとめ、`lib/view-state.ts` の純粋な reducer だけが遷移させる。取得は `useTerminalFeeds` が `pollPlan` に従って自己再帰スケジュールで回す。サーバーは平坦化サーフェスにワークスペース属性を付けるだけで、透過中継の仕組みは変えない。

**Tech Stack:** React 19 / TypeScript / Vite / vitest + @testing-library/react（クライアント）、Bun + Hono / bun:test（サーバー）、Biome。

**Spec:** `docs/superpowers/specs/2026-09-03-multi-terminal-switch-design.md`

## Global Constraints

これは spec 全体に効く制約である。**すべてのタスクの要件に暗黙に含まれる。**

- **`workspace.select` を一度も呼ばない**（UR4 / D1）。`selectWorkspace` は公開 API から削除する。設定トグルも作らない。
- **`surface.focus` も呼ばない**。PWA の前面化は `SwitcherState` の中だけで完結する。
- surface 系 RPC のパラメータは **`surface_id`**（`surface_ref` は無視されフォーカス中サーフェスへフォールバックする）。
- `surface.create` の作成先指定は **`workspace_id`（UUID）**。`workspace_ref` は無視される（P6/P7）。無効な `workspace_id` はエラーにならず選択中 WS に作られるので、**レスポンスの `workspace_id` を必ず検証する**（P8）。
- 定数（`lib/view-state.ts` に置く）:
  ```
  MAX_LIVE_SUBSCRIPTIONS   = 8
  MAX_RETAINED_FEEDS       = 24
  FOREGROUND_POLL_INTERVAL = 1000
  BACKGROUND_POLL_INTERVAL = 3000
  BACKGROUND_STAGGER       = 400
  TOPOLOGY_POLL_INTERVAL   = 5000
  MAX_CACHED_SURFACES      = 12
  ```
- **`RenderGrid` の実型**（`lib/render-grid.ts:42-50`）。**`lines` も `cols` も無い**:
  ```ts
  interface RenderGrid {
    columns: number
    rows: number
    styles: RenderStyle[]
    row_spans: RowSpan[]   // { row, column, style_id, cell_width, text }
    cursor?: GridCursor
    active_screen?: string
    modes?: TerminalMode[]
  }
  ```
  テストの fixture は既存 `lib/__tests__/render-grid.test.ts:23-25` の `grid()` ヘルパーと同じ形
  （`{ columns: 10, rows: 2, styles: [], row_spans: [], ...over }`）にする。
  **内容の同一性は `row_spans` で判定する**（`cursor` は別フィールドなので、
  `row_spans` だけをハッシュすれば R4 の「カーソル点滅を変化と見なさない」が自動的に満たされる）。
- **新しい CSS 色トークンを追加しない。** 既存の `--color-accent` / `--color-text-muted` / `--color-text-subtle` / `--color-warning` / `--color-tab-group-border` だけで表現する。
- **ターミナル描画は不可侵**: `components/Terminal.tsx` の描画ロジック、`lib/render-grid.ts`、`--term-*` 変数、ビューポートのダーク固定には触れない。`Terminal` に渡す props の形だけが変わる。
- **縦の余白を増やさない**: Header 44 / TabBar 38 / InputBar の高さは現行のまま。
- Biome: シングルクォート、セミコロンなし（asNeeded）、行幅 120。`class` を使わない。`any` / `unknown` を型注釈に使わない（RPC 境界の `unknown` からは必ず型付きに絞ってから使う）。
- 検証コマンドは `pnpm check`（tsc + biome）と `pnpm test`。**各タスクの最後で両方を通す。例外は無い** — `useCmux` の API 移行中も Task 6 の shim で型を保つ（Task 6 の「移行の作法」を参照）。
- コミットメッセージ末尾に必ず付ける:
  ```
  Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
  ```

### レビューの到達点（記録）

この plan は design review（codex / gpt-5.6-sol / xhigh）を **point=plan で 5 ラウンド**受けた。
これが運用上の上限である。

| round | 対象 | 結果 |
|---|---|---|
| 1 | `26accf1` | needs_work（P1 3 / P2 3） |
| 2 | `b50e345` | needs_work（P1 5 / P2 4） |
| 3 | `811ddb7` | needs_work（P1 5 / P2 3） |
| 4 | `f21e30e` | needs_work（P1 4 / P2 5） |
| 5 | `6abea96` | needs_work（P1 4 / P2 3） |

**round 5 の指摘 4 件（P1）も反映済みだが、その反映自体はレビューを受けていない。**
上限に達したため round 6 は行わない。とくに次の 4 点は**実装時の最初の検証対象**にすること。

1. `RenderGrid` の実型（`columns` / `row_spans`。`lines` も `cols` も無い）に全 fixture を揃える。
   activity のハッシュは `row_spans` のみ（`cursor` は別フィールドなので自動的に除かれる）
2. 「retained memory の再昇格」テストは `applyFeedResult` が公開される **Task 8** に置く
   （Task 6 の時点では型が通らない）
3. App レベルの受入テストは新規 `src/__tests__/app-integration.test.tsx`（`useCmux` を mock しない）
   に置く。既存の `useCmux.test.ts`（`.ts` で JSX 不可）にも `App.test.tsx`（`useCmux` を全面 mock）にも
   入らない
4. bootstrap の境界は `topologyReady`（最初の snapshot を適用したか）であって配列長ではない。
   成功した空 snapshot は正規状態であり、bootstrap を完了させて「端末がありません」を描く

spec 側も 5 ラウンドで打ち切っている（spec §10 の「レビューの到達点」）。

### plan が spec を supersede する箇所

**実装者へ: 次の 2 点は spec の記述より plan を優先すること。** spec 側にも同じ内容を反映済みだが、
判断に迷ったら plan が正である。

| 箇所 | spec の旧記述 | plan（正） | 理由 |
|---|---|---|---|
| D2.1 の共通 refresh | `requestTopologyRefresh(): Promise<number>`（generation を返し、呼び出し側は React state の一覧を読む） | **`Promise<TopologySnapshot>`**（`{ generation, surfaces, workspaces }` を返し、呼び出し側は snapshot から引く）。waiter の照合は generation ではなく**要求 seq** | async callback が閉じ込めた React state は `await` 後も更新されないため、常に作成前の一覧を見る。また generation は成功時しか進まないので、失敗時に queued waiter が到達不能な世代を待ち続ける（Task 7） |
| `ConnectionIndicator` | `lastUpdated?: number \| null` | **`freshness: string \| null`** | D3.1 は connected 中も「更新: HH:MM:SS」「オフライン時点の内容 · 最終 HH:MM」を出す。`number` だけでは 5 ケースを表せない（Task 10） |

### 未レビューの箇所（spec §10 R9）

spec のレビューは 5 ラウンド（上限）で打ち切っており、**最後の round 5 の修正内容だけはレビューを受けていない**。該当するのは次の 2 つで、**この plan では最初に実装してテストで固める**（Task 3 / Task 4 / Task 7）。

1. `createSwitcherReducer` の「F1〜F3 を適用するのは `subscriptions` に新しく加わった ref だけ」という規則
2. D2.1 の `requestTopologyRefresh()` が返す `generation` 契約

---

## File Structure

| ファイル | 責務 | タスク |
|---|---|---|
| `apps/server/src/ws.ts` | `FlatSurface` にワークスペース属性と `active` を付与。`surface.create` の既定を `focus:false` に | 1 |
| `apps/client/src/hooks/useWebSocket.ts` | `send` が送信可否を返す | 2 |
| `apps/client/src/lib/view-state.ts`（新規） | `ViewState` / `TerminalFeed` / 遷移関数 / `promote` / `createSwitcherReducer` / 定数。**UI も RPC も知らない純粋モジュール** | 3, 4 |
| `apps/client/src/lib/surface-cache.ts` | C1〜C6。実バイト数での entry 上限と Quota の反復退避 | 5 |
| `apps/client/src/hooks/useCmux.ts` | RPC 層 + `SwitcherState` の所有 + topology 再取得ループ | 2, 6, 7 |
| `apps/client/src/hooks/useTerminalFeeds.ts`（新規） | `pollPlan` に従うサーフェスごとの取得ループ（E1〜E5 / F5〜F9） | 8 |
| `apps/client/src/components/TabBar.tsx` | 全サーフェスのタブ行。購読ドット / WS 色 / 区切り / `aria-label` / `scrollIntoView` | 9 |
| `apps/client/src/components/Drawer.tsx` | ワークスペース行の展開折りたたみ + サーフェス行 | 10 |
| `apps/client/src/components/Header.tsx` | `ワークスペース名 · 端末名` の 1 行 2 要素 | 10 |
| `apps/client/src/App.tsx` | 単数スカラーの撤去。5 表示ケースの selector。browser 分岐の維持 | 11 |
| `CLAUDE.md` / `scripts/cmux-probe.mjs`（新規） | 誤記の訂正とプローブスクリプト | 12 |

---

## Task 1: サーバー — `FlatSurface` のワークスペース属性と `focus:false`

**Files:**
- Modify: `apps/server/src/ws.ts:20-70`（`TreeWorkspace` / `FlatSurface` / `flattenSurfaces`）, `apps/server/src/ws.ts:104-107`（`surface.create` の注入）
- Test: `apps/server/src/__tests__/ws.test.ts`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces: `FlatSurface` に `workspace_ref: string` / `workspace_title: string` / `workspace_id: string` / `active: boolean` が増える。クライアントの `Surface` 型（Task 6）がこれを受ける。

D7: `flattenSurfaces` は `workspaceRef` 省略時に全ワークスペースを返す実装が既にある。変更は各行への属性付与と、`system.tree` の `result.active.surface_ref` と一致する 1 件へ `active: true` を立てることだけ。`selected` は**ペイン内選択**の意味のまま残す（全 WS 平坦化では複数 `true` になり得る）。

- [ ] **Step 1: 失敗するテストを書く**

`apps/server/src/__tests__/ws.test.ts` の `describe('flattenSurfaces', ...)` に追記する。

```ts
const treeWithTwoWorkspaces = {
  windows: [
    {
      workspaces: [
        {
          ref: 'workspace:1',
          id: 'C459840B-0000-0000-0000-000000000001',
          title: 'influencer-platform',
          panes: [{ ref: 'pane:1', surfaces: [{ ref: 'surface:1', title: '[1] zsh', type: 'terminal', selected: true }] }],
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

describe('flattenSurfaces のワークスペース属性 (D7)', () => {
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
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/server && bun test src/__tests__/ws.test.ts`
Expected: FAIL。`workspace_ref` が `undefined`、`active` プロパティが存在しない、`focus` が `true`。

- [ ] **Step 3: 実装する**

`apps/server/src/ws.ts` の型と `flattenSurfaces` を差し替える。

```ts
interface TreeWorkspace {
  ref: string
  id?: string
  title?: string
  panes?: TreePane[]
}

interface CmuxTree {
  windows?: TreeWindow[]
  // system.tree は現在アクティブな workspace/surface/pane を result.active に載せる。
  active?: { workspace_ref?: string; surface_ref?: string; pane_ref?: string }
}

export interface FlatSurface {
  index: number
  ref: string
  // ペイン内選択。全ワークスペースを平坦化すると複数が true になり得る（active とは別物）。
  selected: boolean
  // system.tree の result.active.surface_ref と一致する 1 件だけ true。初期前面の決定に使う。
  active: boolean
  title: string
  type: string
  pane_ref: string
  workspace_ref: string
  workspace_title: string
  // surface.create の作成先指定に使う UUID（workspace_ref は無視される）。
  workspace_id: string
  // null for terminals; the browser surface's current URL otherwise.
  url: string | null
}

export function flattenSurfaces(tree: CmuxTree, workspaceRef?: string): FlatSurface[] {
  const activeSurfaceRef = tree.active?.surface_ref
  const out: FlatSurface[] = []
  for (const win of tree.windows ?? []) {
    for (const ws of win.workspaces ?? []) {
      if (workspaceRef && ws.ref !== workspaceRef) continue
      for (const pane of ws.panes ?? []) {
        for (const surface of pane.surfaces ?? []) {
          out.push({
            index: out.length,
            ref: surface.ref,
            selected: Boolean(surface.selected),
            active: activeSurfaceRef !== undefined && surface.ref === activeSurfaceRef,
            title: surface.title ?? surface.ref,
            type: surface.type ?? 'terminal',
            pane_ref: pane.ref,
            workspace_ref: ws.ref,
            workspace_title: ws.title ?? ws.ref,
            workspace_id: ws.id ?? '',
            url: surface.url ?? null,
          })
        }
      }
    }
  }
  return out
}
```

`surface.create` の注入を `focus: false` に変える（D6.1。`...params` が後なので呼び出し側の指定は残る）。

```ts
  if (req.method === 'surface.create') {
    // focus:true は cmux の選択を奪う（実測 P13）。PWA は cmux の選択に触れない（D1）ので
    // 既定を false にする。前面化は PWA の SwitcherState 側で行う。
    return {
      wire: { id: req.id, method: 'surface.create', params: { type: 'terminal', focus: false, ...params } },
      expectList: false,
    }
  }
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/server && bun test src/__tests__/ws.test.ts`
Expected: PASS（既存テストも含めて全件）。

- [ ] **Step 5: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 6: コミット**

```bash
git add apps/server/src/ws.ts apps/server/src/__tests__/ws.test.ts
git commit -m "$(cat <<'EOF'
feat(server): FlatSurface にワークスペース属性と active を付け、surface.create を focus:false に

D7: workspace_ref / workspace_title / workspace_id / active を平坦化行へ付与する。
active は system.tree の result.active.surface_ref と一致する 1 件だけ true にし、
ペイン内選択を表す selected（全 WS 平坦化で複数 true になり得る）と区別する。

D6.1: surface.create に注入する既定を focus:true から false へ。実測で focus:true は
cmux の選択を奪うため（付録 A の P13）、D1 の「PWA は cmux の選択に触れない」に反する。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 2: `send` の成否契約と pending RPC の後始末（D10）

**Files:**
- Modify: `apps/client/src/hooks/useWebSocket.ts:74-78`（`send`）, `apps/client/src/hooks/useCmux.ts:65-78`（`rpc`）
- Test: `apps/client/src/hooks/__tests__/useCmux.test.ts`

**Interfaces:**
- Consumes: なし（Task 1 と独立）
- Produces: `useWebSocket` が `{ status, send: (data: string) => boolean }` を返す。`useCmux` の `rpc` は送れなければ即 reject する。Task 6〜8 のポーリングがこれに依存する。

購読が 8 本になると切断時に 8 本の Promise が同時に宙に浮く。本設計が増幅する欠陥なので範囲内で直す（D10 の 4 点）。

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/hooks/__tests__/useCmux.test.ts` に追記する。既存の `vi.mock('../useWebSocket')` を、status と送信可否を差し替えられる形へ拡張する。

```ts
// hoisted に追加するフィールド:
//   status: { value: 'connected' as 'connected' | 'disconnected' },
//   canSend: { value: true },
//   swallow: { value: false },   // true なら送信はするが応答を返さない（in-flight を作る）
// mock の send は canSend.value が false のとき何もせず false を返す。

describe('rpc の登録順（同期 echo の回帰ガード）', () => {
  it('send の中で同期的に応答が返っても取りこぼさない', async () => {
    // 既存 mock は send の呼び出し中に onMessage を同期実行する。
    hoisted.responses['surface.read_text'] = { text: 'sync-echo' }
    const { result } = renderHook(() => useCmux())
    await expect(result.current.readText('surface:1')).resolves.toBe('sync-echo')
  })

  it('同期 echo で解決した RPC はタイマーを残さない', async () => {
    vi.useFakeTimers()
    hoisted.responses['surface.read_text'] = { text: 'ok' }
    const { result } = renderHook(() => useCmux())
    await result.current.readText('surface:1')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})

describe('D10 切断時の pending RPC', () => {
  it('切断で既存の pending が 10 秒を待たず reject される', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCmux())
    hoisted.swallow.value = true
    let rejected: Error | null = null
    const promise = result.current.readText('surface:1').catch((e: Error) => {
      rejected = e
      return ''
    })
    // まだ 1ms も進めていない時点で切断させる
    act(() => {
      hoisted.status.value = 'disconnected'
      hoisted.onClose.fn()
    })
    await promise
    expect(rejected).toBeInstanceOf(Error)
    expect(vi.getTimerCount()).toBe(0) // タイムアウトタイマーが残っていない
    vi.useRealTimers()
  })

  it('切断中に新しく呼んだ RPC は 10 秒待たず即 reject される', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useCmux())
    act(() => {
      hoisted.canSend.value = false
      hoisted.status.value = 'disconnected'
    })
    await expect(result.current.readText('surface:1')).rejects.toThrow(/not connected/i)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('アンマウントでも pending が reject され、タイマーが残らない', async () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useCmux())
    hoisted.swallow.value = true
    const promise = result.current.readText('surface:1').catch(() => 'rejected')
    act(() => {
      unmount()
    })
    await expect(promise).resolves.toBe('rejected')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('reject 後に遅れて届いた応答は破棄される（例外にならない）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.swallow.value = true
    const promise = result.current.readText('surface:1').catch(() => 'rejected')
    const sentId = (JSON.parse(hoisted.sent[hoisted.sent.length - 1] as string) as { id: string }).id
    act(() => {
      hoisted.onClose.fn()
    })
    await promise
    expect(() => {
      hoisted.onMessage.fn(JSON.stringify({ id: sentId, ok: true, result: { text: 'late' } }))
    }).not.toThrow()
  })
})
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: FAIL。`onClose` フックが存在せず、切断中の RPC が 10 秒タイマーで待つ。

- [ ] **Step 3: `useWebSocket` の `send` を成否が分かる契約にし、`onClose` を通知する**

```ts
interface UseWebSocketOptions {
  url: string
  onMessage: (data: string) => void
  // 切断のたびに呼ばれる。呼び出し側が in-flight の後始末をするためのフック。
  onClose?: () => void
  maxRetries?: number
}

  // 送れたかどうかを返す。呼び出し側（useCmux の rpc）は false のとき
  // pending へ登録せず即 reject する（無言 no-op だと 10 秒待たされるため。D10-4）。
  const send = useCallback((data: string): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false
    wsRef.current.send(data)
    return true
  }, [])
```

`ws.onclose` の中で `onCloseRef.current?.()` を呼ぶ（`onClose` は ref に載せて `connect` の依存から外す）。

- [ ] **Step 4: `useCmux` 側で 4 点すべてを満たす**

```ts
  // 全 pending を 1 回だけ reject し、タイムアウトタイマーを必ず clear する（D10-1/2）。
  const rejectAllPending = useCallback((reason: string) => {
    for (const [, pending] of pendingRef.current) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    pendingRef.current.clear()
  }, [])

  const handleClose = useCallback(() => {
    rejectAllPending('WebSocket disconnected')
  }, [rejectAllPending])

  const { status, send } = useWebSocket({ url: wsUrl, onMessage: handleMessage, onClose: handleClose })

  const rpc = useCallback(
    (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      return new Promise((resolve, reject) => {
        const req = createRpcRequest(method, params)
        const timer = setTimeout(() => {
          pendingRef.current.delete(req.id)
          reject(new Error(`RPC timeout: ${method}`))
        }, RPC_TIMEOUT)
        // pending は send より「先に」登録する。テストダブル（および将来の同期的な
        // メッセージ配送）は send の呼び出し中に onMessage を同期実行するため、
        // 後から登録すると応答を取りこぼして 10 秒 timeout になる。
        pendingRef.current.set(req.id, { resolve, reject, timer })
        // 送れなかったら登録を取り消して即 reject する。無言 no-op のままだと
        // 送られていない RPC を 10 秒待つことになる（D10-4）。
        if (!send(JSON.stringify(req))) {
          // 同期 echo で既に解決済みなら pending は消えている。その場合は何もしない。
          const pending = pendingRef.current.get(req.id)
          if (pending) {
            clearTimeout(pending.timer)
            pendingRef.current.delete(req.id)
            reject(new Error(`RPC failed: not connected (${method})`))
          }
        }
      })
    },
    [send],
  )

  // アンマウント時も同じ後始末をする（D10-2）。
  useEffect(() => rejectAllPending.bind(null, 'unmounted'), [rejectAllPending])
```

> **順序が重要**: 現行の `useCmux.test.ts` の `send` mock は **`send` の呼び出し中に `onMessage` を
> 同期実行する**。`send` を先に呼んで後から `pendingRef` へ登録すると、応答が届いた時点で
> pending が存在せず捨てられ、その後 10 秒 timeout になる。したがって
> **pending と timer を先に登録し、`send` が `false` を返したら取り消して reject する**。
> `Promise` executor は同期実行されるので、`reject` を後から呼んでも問題ない。

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: PASS（既存テストも含めて全件）。

- [ ] **Step 6: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 7: コミット**

```bash
git add apps/client/src/hooks/useWebSocket.ts apps/client/src/hooks/useCmux.ts apps/client/src/hooks/__tests__/useCmux.test.ts
git commit -m "$(cat <<'EOF'
fix(client): WS 切断時に pending RPC を即座に reject する (D10)

send を「送れたかどうかを返す」契約に変え、送れなかったら rpc が pending にも
タイムアウトタイマーにも登録せず即 reject する。切断時とアンマウント時は全 pending を
ちょうど 1 回 reject し、タイマーを必ず clear する。

単一端末なら宙に浮く Promise は 1 本だが、購読が 8 本になると同時に 8 本が浮く。
複数端末化が増幅する欠陥なので範囲内で直す。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 3: `lib/view-state.ts` — 型・定数・4 つの遷移関数（I1〜I6）

**Files:**
- Create: `apps/client/src/lib/view-state.ts`
- Test: `apps/client/src/lib/__tests__/view-state.test.ts`

**Interfaces:**
- Consumes: なし（純粋モジュール）
- Produces:
  ```ts
  export interface SurfaceLike { ref: string; type: string; workspace_ref: string; index: number; active?: boolean }
  export interface ViewState {
    // treeIndex は購読へ入れた時点の SurfaceLike.index（system.tree 順）。LRU の tie-break に使う。
    subscriptions: { ref: string; lastForegroundAt: number; treeIndex: number }[]
    foreground: string | null
    foregroundWorkspaceRef: string | null
  }
  export function focus(state: ViewState, surface: SurfaceLike, now: number, cap: number): ViewState
  export function reconcile(state: ViewState, surfaces: readonly SurfaceLike[], now: number): ViewState
  export function initialize(surfaces: readonly SurfaceLike[], preferredRef: string | null, now: number): ViewState
  export function pollPlan(state: ViewState, surfaces: readonly SurfaceLike[], visibleRefs: readonly string[]): { ref: string; intervalMs: number }[]
  ```
  Task 4 の `createSwitcherReducer` と Task 6〜8 がこれを使う。

**不変条件（全遷移の事後条件としてテストする）**

| # | 不変条件 |
|---|---|
| I1 | `foreground` は `null` か、生存する任意のサーフェスの ref（terminal でも browser でもよい） |
| I2 | `foreground` が terminal のときに限り、必ず `subscriptions` に含まれる |
| I3 | `subscriptions` に含まれるのは生存する terminal だけ（browser は入らない） |
| I4 | `subscriptions` の ref に重複はない |
| I5 | `subscriptions.length <= cap`（`cap` を受けるのは `focus` だけ。他は上限を保存する） |
| I6 | `foregroundWorkspaceRef` は `foreground` のワークスペースと一致。`foreground === null` なら `null` |

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/view-state.test.ts` を新規作成する。

```ts
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
    const before = [term('surface:1', 'workspace:1'), term('surface:2', 'workspace:26'), term('surface:3', 'workspace:26')]
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
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/view-state.test.ts`
Expected: FAIL（`../view-state` が存在しない）。

- [ ] **Step 3: `lib/view-state.ts` を実装する**

```ts
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

function withForeground(
  subscriptions: ViewState['subscriptions'],
  surface: SurfaceLike | null,
): ViewState {
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
function evict(
  subscriptions: ViewState['subscriptions'],
  keepRef: string,
  cap: number,
): ViewState['subscriptions'] {
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
export function initialize(
  surfaces: readonly SurfaceLike[],
  preferredRef: string | null,
  now: number,
): ViewState {
  const preferred = preferredRef === null ? undefined : surfaces.find((s) => s.ref === preferredRef)
  const chosen = preferred ?? surfaces.find((s) => s.active === true) ?? surfaces[0] ?? null
  if (chosen === null) return withForeground([], null)
  return focus({ subscriptions: [], foreground: null, foregroundWorkspaceRef: null }, chosen, now, MAX_LIVE_SUBSCRIPTIONS)
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
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/view-state.test.ts`
Expected: PASS（全 25 ケース前後）。

- [ ] **Step 5: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 6: コミット**

```bash
git add apps/client/src/lib/view-state.ts apps/client/src/lib/__tests__/view-state.test.ts
git commit -m "$(cat <<'EOF'
feat(client): 表示状態を純粋な状態機械にする (D2/D3/D6)

ViewState（前面 + 購読集合 + 前面のワークスペース）と focus/reconcile/initialize/pollPlan
の 4 つの遷移関数を lib/view-state.ts に追加する。不変条件 I1〜I6 を全遷移の
事後条件としてテストする。

foregroundWorkspaceRef を持つのは、前面が消えたときの退避順 2「消えた前面と同じ
ワークスペースの先頭」が、消えた ref からは辿れないため。surface.move による
ref 振り直しは「消えた」として扱い、移動先を追いかけない。

初期購読集合は前面 1 件だけにする（起動直後に 8 本の RPC を同時に立ち上げない。
購読ドットは「ユーザーが選んだ端末」を意味するため）。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 4: `lib/view-state.ts` — `TerminalFeed` / `promote` / `createSwitcherReducer`

**Files:**
- Modify: `apps/client/src/lib/view-state.ts`
- Test: `apps/client/src/lib/__tests__/view-state.test.ts`

**Interfaces:**
- Consumes: Task 3 の `ViewState` / `focus` / `initialize` / `reconcile` / `SurfaceLike`
- Produces:
  ```ts
  export type FeedStatus = 'live' | 'warming' | 'loading' | 'error'
  export type FeedSource = 'memory' | 'cache' | 'none'
  export interface TerminalFeed {
    grid: RenderGrid | null; history: string; updatedAt: number | null
    activity: boolean; contentHash: string
    status: FeedStatus; source: FeedSource; epoch: number; promotedAt: number
  }
  export function describeFeed(feed: TerminalFeed | undefined):
    | { kind: 'grid'; freshness: string | null }
    | { kind: 'message'; message: string; freshness: string | null }
    | null
  export interface SwitcherState { view: ViewState; feeds: Map<string, TerminalFeed> }
  export type SwitcherAction =
    | { type: 'select'; surface: SurfaceLike; now: number; cap: number }
    | { type: 'initialize'; surfaces: readonly SurfaceLike[]; preferredRef: string | null; now: number }
    | { type: 'reconcile'; surfaces: readonly SurfaceLike[]; now: number }
  export function createSwitcherReducer(
    readCache: (ref: string) => CachedScreen | null,
  ): (state: SwitcherState, action: SwitcherAction) => SwitcherState
  ```
  Task 6 が `useReducer` でこれを持ち、Task 8 が `feeds` を更新する。

**これが spec §10 R9 の未レビュー箇所である。テストを先に書いて固める。**

reducer の規則は 1 行に集約される: **F1〜F3 を適用するのは、その action で `subscriptions` に「新しく加わった」ref だけ**。

| 昇格の分岐 | 条件 | 結果 |
|---|---|---|
| F1 | 保持 feed があり `feed.source === 'memory'` | `epoch++` / `promotedAt=now` / `warming` / `memory` |
| F2 | `feed.source === 'cache'`、または feed が無く cache がある | `epoch++` / `promotedAt=now` / `warming` / `cache` |
| F3 | 上記以外（feed が無く cache も無い、または `source === 'none'`） | `epoch++` / `promotedAt=now` / `loading` / `none` |

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/view-state.test.ts` に追記する。

```ts
import { createSwitcherReducer, type SwitcherState, type TerminalFeed } from '../view-state'
import type { CachedScreen } from '../surface-cache'
import type { RenderGrid } from '../render-grid'

// 実型に合わせる（lib/__tests__/render-grid.test.ts:23-25 の grid() と同じ形）。
const grid = (text: string): RenderGrid => ({
  columns: 80,
  rows: 1,
  styles: [],
  row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: text.length, text }],
  active_screen: 'primary',
})

const noCache = () => null
const withCache = (refs: Record<string, CachedScreen>) => (ref: string) => refs[ref] ?? null

const emptyState = (): SwitcherState => ({
  view: { subscriptions: [], foreground: null, foregroundWorkspaceRef: null },
  feeds: new Map(),
})

describe('createSwitcherReducer — added 規則', () => {
  it('非購読 terminal を選ぶと F3（feed も cache も無い）', () => {
    const reduce = createSwitcherReducer(noCache)
    const surfaces = [term('surface:1')]
    const s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: null, now: 1000 })
    const feed = s.feeds.get('surface:1') as TerminalFeed
    expect(feed.status).toBe('loading')
    expect(feed.source).toBe('none')
    expect(feed.epoch).toBe(1)
    expect(feed.promotedAt).toBe(1000)
  })

  it('cache があれば F2（warming/cache）', () => {
    const reduce = createSwitcherReducer(withCache({ 'surface:1': { grid: grid('x'), updatedAt: 500 } }))
    const surfaces = [term('surface:1')]
    const s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: null, now: 1000 })
    const feed = s.feeds.get('surface:1') as TerminalFeed
    expect(feed.status).toBe('warming')
    expect(feed.source).toBe('cache')
    expect(feed.grid).not.toBeNull() // 復元も同じ遷移の中で行う
  })

  it('F4: すでに live/memory の購読中 terminal を前面化しても feeds と epoch が不変', () => {
    const reduce = createSwitcherReducer(noCache)
    const surfaces = [term('surface:1'), term('surface:2')]
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    s = reduce(s, { type: 'select', surface: surfaces[1] as SurfaceLike, now: 2000, cap: MAX_LIVE_SUBSCRIPTIONS })
    // surface:1 を live/memory に仕立てる
    const live: TerminalFeed = { ...(s.feeds.get('surface:1') as TerminalFeed), status: 'live', source: 'memory', grid: grid('a') }
    s = { ...s, feeds: new Map(s.feeds).set('surface:1', live) }
    const before = s.feeds
    const after = reduce(s, { type: 'select', surface: surfaces[0] as SurfaceLike, now: 3000, cap: MAX_LIVE_SUBSCRIPTIONS })
    expect(after.feeds.get('surface:1')).toEqual(live) // epoch も status も不変
    expect(after.feeds).toBe(before) // Map ごと同一参照（added が空なら 1 バイトも変えない）
    expect(after.view.foreground).toBe('surface:1')
  })

  it('D5: browser を前面化しても feeds が不変', () => {
    const reduce = createSwitcherReducer(noCache)
    const surfaces = [term('surface:1'), browser('surface:9')]
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    const before = s.feeds
    s = reduce(s, { type: 'select', surface: surfaces[1] as SurfaceLike, now: 2000, cap: MAX_LIVE_SUBSCRIPTIONS })
    expect(s.feeds).toBe(before)
    expect(s.view.foreground).toBe('surface:9')
  })

  it('reconcile が購読を削るだけのときは feeds が不変', () => {
    const reduce = createSwitcherReducer(noCache)
    const surfaces = [term('surface:1'), term('surface:2')]
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    s = reduce(s, { type: 'select', surface: surfaces[1] as SurfaceLike, now: 2000, cap: MAX_LIVE_SUBSCRIPTIONS })
    const before = s.feeds
    s = reduce(s, { type: 'reconcile', surfaces: [term('surface:1')], now: 3000 })
    expect(s.feeds).toBe(before) // 保持は D3.2 に従う。削除では feed を捨てない
  })

  it('reconcile が空の購読集合へ退避先 terminal を足すときは F1〜F3 が適用される', () => {
    const reduce = createSwitcherReducer(noCache)
    const before = [term('surface:2', 'workspace:26')]
    let s = reduce(emptyState(), { type: 'initialize', surfaces: before, preferredRef: 'surface:2', now: 1000 })
    const after = [term('surface:3', 'workspace:26')]
    s = reduce(s, { type: 'reconcile', surfaces: after, now: 2000 })
    const feed = s.feeds.get('surface:3') as TerminalFeed
    expect(feed).toBeDefined()
    expect(feed.status).toBe('loading')
    expect(feed.promotedAt).toBe(2000)
  })

  it('F2 -> F10 -> 再昇格 で source が cache のまま維持される（memory に化けない）', () => {
    const reduce = createSwitcherReducer(withCache({ 'surface:1': { grid: grid('x'), updatedAt: 500 } }))
    const surfaces = [term('surface:1'), term('surface:2'), term('surface:3')]
    // cap=1 で surface:1 を昇格 → F2、その後 surface:2 を選んで追い出す（F10）
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    expect((s.feeds.get('surface:1') as TerminalFeed).source).toBe('cache')
    s = reduce(s, { type: 'select', surface: surfaces[1] as SurfaceLike, now: 2000, cap: 1 })
    expect(s.view.subscriptions.map((x) => x.ref)).toEqual(['surface:2'])
    expect((s.feeds.get('surface:1') as TerminalFeed).source).toBe('cache') // F10 は据え置き
    const epochBefore = (s.feeds.get('surface:1') as TerminalFeed).epoch
    // 再昇格
    s = reduce(s, { type: 'select', surface: surfaces[0] as SurfaceLike, now: 3000, cap: 1 })
    const feed = s.feeds.get('surface:1') as TerminalFeed
    expect(feed.source).toBe('cache') // ← ここが memory に化けてはいけない
    expect(feed.status).toBe('warming')
    expect(feed.epoch).toBe(epochBefore + 1)
    expect(feed.promotedAt).toBe(3000)
  })

  it('F5n 後（source=none）の再昇格は、cache が残っていても F3 に入る', () => {
    const reduce = createSwitcherReducer(withCache({ 'surface:1': { grid: grid('x'), updatedAt: 500 } }))
    const surfaces = [term('surface:1'), term('surface:2')]
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    // F5n を模す: live/none で grid も history も無い
    const stopped: TerminalFeed = {
      ...(s.feeds.get('surface:1') as TerminalFeed),
      status: 'live',
      source: 'none',
      grid: null,
      history: '',
    }
    s = { ...s, feeds: new Map(s.feeds).set('surface:1', stopped) }
    s = reduce(s, { type: 'select', surface: surfaces[1] as SurfaceLike, now: 2000, cap: 1 })
    s = reduce(s, { type: 'select', surface: surfaces[0] as SurfaceLike, now: 3000, cap: 1 })
    const feed = s.feeds.get('surface:1') as TerminalFeed
    expect(feed.status).toBe('loading')
    expect(feed.source).toBe('none')
    expect(feed.grid).toBeNull() // 同一セッションでは cache を復活させない
  })

  it('MAX_RETAINED_FEEDS を超えたら LRU 退避するが、購読中の feed は退避対象外', () => {
    const reduce = createSwitcherReducer(noCache)
    const surfaces = Array.from({ length: MAX_RETAINED_FEEDS + 5 }, (_, i) => term(`surface:${i}`))
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:0', now: 1000 })
    for (let i = 1; i < surfaces.length; i++) {
      s = reduce(s, { type: 'select', surface: surfaces[i] as SurfaceLike, now: 1000 + i, cap: MAX_LIVE_SUBSCRIPTIONS })
    }
    expect(s.feeds.size).toBeLessThanOrEqual(MAX_RETAINED_FEEDS)
    for (const sub of s.view.subscriptions) {
      expect(s.feeds.has(sub.ref)).toBe(true) // 購読中は必ず残る
    }
  })
})
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/view-state.test.ts`
Expected: FAIL（`createSwitcherReducer` が存在しない）。

- [ ] **Step 3: 実装する**

`apps/client/src/lib/view-state.ts` に追記する。

```ts
import type { RenderGrid } from './render-grid'
import { stripVisibleScreen, visibleLineCount } from './scrollback'
import type { CachedScreen } from './surface-cache'

export type FeedStatus =
  | 'live'     // 今回の昇格後に 1 回以上取得成功した
  | 'warming'  // 昇格したが、まだ 1 回も成功していない（前回以前のフレームを見せている）
  | 'loading'  // 表示できるフレームが 1 つも無い（初見）
  | 'error'    // 直近の取得に失敗した / WS が切れている

export type FeedSource =
  | 'memory'   // このセッションで取得したフレーム
  | 'cache'    // localStorage から復元したスナップショット
  | 'none'     // 描けるフレームが無い

export interface TerminalFeed {
  grid: RenderGrid | null
  history: string
  updatedAt: number | null
  activity: boolean       // 前面を離れてから内容が変化した（タブのドット拡大に使う）
  // activity 判定用。row_spans だけをハッシュする。cursor は別フィールドなので、
  // これだけでカーソル点滅を変化と見なさない条件が満たされる（spec §10 R4）。
  contentHash: string
  status: FeedStatus
  source: FeedSource      // 表示ケースは (status, source) の組で決まる（D3.1）
  epoch: number           // 昇格ごとに単調増加。応答の適用可否判定に使う
  promotedAt: number      // 最後に昇格した時刻。表示とログ用（判定には epoch を使う）
}

// D3.1 の 5 表示ケース。(status, source) の組だけで決まる純粋関数。
// UI から色やレイアウトを分離し、テストを表とそのまま対応させる。
export function describeFeed(
  feed: TerminalFeed | undefined,
):
  | { kind: 'grid'; freshness: string | null }
  | { kind: 'message'; message: string; freshness: string | null }
  | null {
  if (!feed) return null
  const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8)
  const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5)

  // 5. error を source より先に判定する。F5n は live/none かつ updatedAt あり を作るので、
  //    その後 F6/F8 で error/none になったときも「接続なし · 最終 HH:MM」を出せる必要がある。
  if (feed.status === 'error') {
    const freshness = feed.updatedAt === null ? '接続なし' : `接続なし · 最終 ${hhmm(feed.updatedAt)}`
    // 描けるものがあれば残し、無ければメッセージ枠に出す。
    return feed.source === 'none' ? { kind: 'message', message: '接続なし', freshness } : { kind: 'grid', freshness }
  }
  // 4. 描けるフレームが無い（loading = 初見 / live = F5n の停止端末）
  if (feed.source === 'none') {
    return feed.status === 'live'
      ? { kind: 'message', message: '表示できる内容がありません（端末が停止しています）', freshness: null }
      : { kind: 'message', message: '読み込み中', freshness: null }
  }
  // 1. live/memory は鮮度を出さない
  if (feed.status === 'live') return { kind: 'grid', freshness: null }
  // 3. warming/cache
  if (feed.source === 'cache') {
    return { kind: 'grid', freshness: `オフライン時点の内容 · 最終 ${hhmm(feed.updatedAt ?? 0)}` }
  }
  // 2. warming/memory
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

// F1〜F3。昇格対象の feed を作る/更新する。epoch を進め、source を決める。
// 分岐は「物理的にフレームを持っているか」ではなく論理的な source で排他にする。
// ここを「メモリに描けるフレームがあるか」で分けると、追い出し(F10)→再昇格の往復で
// cache が memory に化け、取得成功前に「オフライン時点の内容」ラベルが消える。
function promote(
  feeds: ReadonlyMap<string, TerminalFeed>,
  ref: string,
  now: number,
  readCache: (ref: string) => CachedScreen | null,
): TerminalFeed {
  const prev = feeds.get(ref)
  const epoch = (prev?.epoch ?? 0) + 1
  const base = { epoch, promotedAt: now, activity: false }

  // F1: メモリのフレームを持っている
  if (prev && prev.source === 'memory') {
    return { ...prev, ...base, status: 'warming' }
  }
  // F2: 論理的に cache 由来、または feed が無くて cache がある
  if (prev?.source === 'cache') {
    return { ...prev, ...base, status: 'warming' }
  }
  if (!prev) {
    const cached = readCache(ref)
    // 旧バージョンが書いた text-only の entry も有効なキャッシュとして扱う
    // （現行アプリは grid の無い entry を scrollback ?? text で表示している）。
    if (cached && (cached.grid || cached.scrollback || cached.text)) {
      return {
        ...base,
        grid: cached.grid ?? null,
        history: cached.grid
          ? stripVisibleScreen(cached.scrollback ?? cached.text ?? '', visibleLineCount(cached.grid))
          : (cached.scrollback ?? cached.text ?? ''),
        updatedAt: cached.updatedAt,
        contentHash: cached.grid === undefined ? '' : JSON.stringify(cached.grid.row_spans),
        status: 'warming',
        source: 'cache',
      }
    }
  }
  // F3: それ以外（source === 'none' を含む。F5n の停止端末は同一セッションでは cache を使わない）
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

// D3.2 の保持上限。購読中の feed は退避対象から除外する。
function retain(feeds: Map<string, TerminalFeed>, view: ViewState): Map<string, TerminalFeed> {
  if (feeds.size <= MAX_RETAINED_FEEDS) return feeds
  const subscribed = new Set(view.subscriptions.map((s) => s.ref))
  const evictable = [...feeds.entries()]
    .filter(([ref]) => !subscribed.has(ref) && ref !== view.foreground)
    .sort((a, b) => a[1].promotedAt - b[1].promotedAt)
  const out = new Map(feeds)
  for (const [ref] of evictable) {
    if (out.size <= MAX_RETAINED_FEEDS) break
    out.delete(ref)
  }
  return out
}

// ViewState と feeds を 1 つの合成状態として動かす。2 つの setter に分けると、
// feed 側の updater が変更前の subscriptions を見られず「本当に購読が増えたか」を
// 判定できないため、すでに live の背面を前面化しただけで epoch++ して F4 を破る。
export function createSwitcherReducer(
  readCache: (ref: string) => CachedScreen | null,
): (state: SwitcherState, action: SwitcherAction) => SwitcherState {
  return (state, action) => {
    const nextView =
      action.type === 'select'
        ? focus(state.view, action.surface, action.now, action.cap)
        : action.type === 'initialize'
          ? initialize(action.surfaces, action.preferredRef, action.now)
          : reconcile(state.view, action.surfaces, action.now)

    // F1〜F3 を適用するのは、この action で subscriptions に新しく加わった ref だけ。
    // これだけで F4（既購読の前面化）・D5（browser）・initialize・reconcile が
    // すべて自動的に満たされる。
    const before = new Set(state.view.subscriptions.map((s) => s.ref))
    const added = nextView.subscriptions.map((s) => s.ref).filter((ref) => !before.has(ref))
    if (added.length === 0) return { view: nextView, feeds: state.feeds }

    const feeds = new Map(state.feeds)
    const now = action.now
    for (const ref of added) feeds.set(ref, promote(state.feeds, ref, now, readCache))
    return { view: nextView, feeds: retain(feeds, nextView) }
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/view-state.test.ts`
Expected: PASS。

- [ ] **Step 5: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 6: コミット**

```bash
git add apps/client/src/lib/view-state.ts apps/client/src/lib/__tests__/view-state.test.ts
git commit -m "$(cat <<'EOF'
feat(client): ViewState と feeds を 1 つの reducer にまとめる (D3.1)

TerminalFeed（status / source / epoch / promotedAt）と createSwitcherReducer を追加する。
規則は 1 行:「F1〜F3 を適用するのは subscriptions に新しく加わった ref だけ」。
これで F4（既購読の前面化では何も変えない）・D5（browser）・initialize・reconcile が
すべて自動的に満たされる。

2 つの setter に分けると feed 側の updater が変更前の subscriptions を見られず、
すでに live の背面を前面化しただけで epoch++ して F4 を破る。

F1/F2/F3 の分岐は物理的な格納場所ではなく論理的な source で排他にする。
「メモリに描けるフレームがあるか」で分けると、追い出し→再昇格の往復で cache が
memory に化け、取得成功前に「オフライン時点の内容」ラベルが消えるため。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 5: `lib/surface-cache.ts` — C1〜C6

**Files:**
- Modify: `apps/client/src/lib/surface-cache.ts`
- Test: `apps/client/src/lib/__tests__/surface-cache.test.ts`

**Interfaces:**
- Consumes: なし（純粋モジュール）
- Produces: `saveSurfaceScreen` / `loadSurfaceScreen` はシグネチャ据え置き。定数 `MAX_CACHED_SURFACES = 12` と `MAX_CACHED_ENTRY_BYTES` を export する。Task 4 の `readCache` と Task 8 の永続化がこれを使う。

多端末化は現行の 3 つの問題（件数無制限・Quota 握り潰し・毎ポーリング同期書き込み）をすべて悪化させる。C1 と C6 は Task 8（呼び出し側）で、C2〜C5 はこのモジュールで実装する。

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/lib/__tests__/surface-cache.test.ts` に追記する。

```ts
import { MAX_CACHED_ENTRY_BYTES, MAX_CACHED_SURFACES } from '../surface-cache'

describe('C5 entry サイズ上限（実バイト数）', () => {
  it('サイズは UTF-16 code unit ではなく TextEncoder の実バイト数で測る', () => {
    // CJK は 1 文字 3 バイト。code unit 数で測ると 1/3 に見積もって上限を突破する。
    const cjk = 'あ'.repeat(MAX_CACHED_ENTRY_BYTES / 3)
    saveSurfaceScreen('surface:1', { scrollback: cjk, updatedAt: 1 })
    const raw = localStorage.getItem('cmux-surface-cache:surface:1') as string
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_CACHED_ENTRY_BYTES)
  })

  it('超過したらまず scrollback を削る', () => {
    saveSurfaceScreen('surface:1', {
      text: 'short text',
      scrollback: 'x'.repeat(MAX_CACHED_ENTRY_BYTES),
      updatedAt: 1,
    })
    const loaded = loadSurfaceScreen('surface:1')
    expect(loaded?.text).toBe('short text')
    expect((loaded?.scrollback ?? '').length).toBeLessThan(MAX_CACHED_ENTRY_BYTES)
  })

  it('scrollback を削っても収まらなければ text も削る', () => {
    saveSurfaceScreen('surface:1', {
      text: 'y'.repeat(MAX_CACHED_ENTRY_BYTES),
      scrollback: 'x'.repeat(MAX_CACHED_ENTRY_BYTES),
      grid: { columns: 80, rows: 1, styles: [], row_spans: [] } as RenderGrid,
      updatedAt: 1,
    })
    const loaded = loadSurfaceScreen('surface:1')
    expect(loaded?.grid).toBeDefined()
    const raw = localStorage.getItem('cmux-surface-cache:surface:1') as string
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_CACHED_ENTRY_BYTES)
  })

  it('grid だけでも超えるならその entry は保存しない', () => {
    const huge: RenderGrid = { columns: 80, rows: 1, styles: [], row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: 1, text: 'z'.repeat(MAX_CACHED_ENTRY_BYTES) }] }
    saveSurfaceScreen('surface:1', { grid: huge, updatedAt: 1 })
    expect(localStorage.getItem('cmux-surface-cache:surface:1')).toBeNull()
  })
})

describe('C3 QuotaExceededError の反復退避', () => {
  it('候補が尽きるか成功するまで、updatedAt の古い順に削除して再試行する', () => {
    for (let i = 0; i < 5; i++) saveSurfaceScreen(`surface:${i}`, { text: `t${i}`, updatedAt: i })
    let failures = 3
    const original = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('cmux-surface-cache:surface:new') && failures-- > 0) {
        const err = new Error('quota') as Error & { name: string }
        err.name = 'QuotaExceededError'
        throw err
      }
      original.call(this, k, v)
    })
    saveSurfaceScreen('surface:new', { text: 'new', updatedAt: 99 })
    spy.mockRestore()
    expect(loadSurfaceScreen('surface:new')?.text).toBe('new')
    // 古い順に 3 件消えている
    expect(loadSurfaceScreen('surface:0')).toBeNull()
    expect(loadSurfaceScreen('surface:2')).toBeNull()
    expect(loadSurfaceScreen('surface:4')).not.toBeNull()
  })

  it('候補が尽きたら諦める（例外を投げない）', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      const err = new Error('quota') as Error & { name: string }
      err.name = 'QuotaExceededError'
      throw err
    })
    expect(() => saveSurfaceScreen('surface:1', { text: 'x', updatedAt: 1 })).not.toThrow()
    spy.mockRestore()
  })
})

describe('C4 件数の二次ガード', () => {
  it(`MAX_CACHED_SURFACES(${MAX_CACHED_SURFACES}) を超えたら updatedAt の古い順に消す`, () => {
    for (let i = 0; i < MAX_CACHED_SURFACES + 3; i++) {
      saveSurfaceScreen(`surface:${i}`, { text: `t${i}`, updatedAt: i })
    }
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('cmux-surface-cache:'))
    expect(keys.length).toBeLessThanOrEqual(MAX_CACHED_SURFACES)
    expect(loadSurfaceScreen('surface:0')).toBeNull()
    expect(loadSurfaceScreen(`surface:${MAX_CACHED_SURFACES + 2}`)).not.toBeNull()
  })
})
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/surface-cache.test.ts`
Expected: FAIL（`MAX_CACHED_ENTRY_BYTES` が無い、Quota を握り潰す、件数上限が無い）。

- [ ] **Step 3: 実装する**

`apps/client/src/lib/surface-cache.ts` の `saveSurfaceScreen` を差し替える。

```ts
const KEY_PREFIX = 'cmux-surface-cache:'

// 1 サーフェスあたりの保存上限（文字数）。超過分は末尾（最新行）を残して切り詰める。
export const MAX_CACHED_CHARS = 200_000
// 直列化後の 1 entry の上限（実バイト数）。text/scrollback に別々の文字数上限をかけても
// grid と JSON のオーバーヘッドが載るため、1 件で 500KB を超えうる。
export const MAX_CACHED_ENTRY_BYTES = 256 * 1024
// C3 が働く前に件数が無限に増えないようにする二次ガード。
export const MAX_CACHED_SURFACES = 12

const encoder = new TextEncoder()
const byteLength = (value: string): number => encoder.encode(value).length

function cacheKeys(): { key: string; updatedAt: number }[] {
  const out: { key: string; updatedAt: number }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key === null || !key.startsWith(KEY_PREFIX)) continue
    const raw = localStorage.getItem(key)
    let updatedAt = 0
    if (raw !== null) {
      try {
        updatedAt = (JSON.parse(raw) as CachedScreen).updatedAt ?? 0
      } catch {
        updatedAt = 0
      }
    }
    out.push({ key, updatedAt })
  }
  return out.sort((a, b) => a.updatedAt - b.updatedAt)
}

// C5: scrollback -> text -> grid の順に削って entry を上限に収める。
// grid だけでも超えるなら null を返し、その entry は保存しない。
function fitEntry(entry: CachedScreen): string | null {
  const attempt = (e: CachedScreen): string | null => {
    const json = JSON.stringify(e)
    return byteLength(json) <= MAX_CACHED_ENTRY_BYTES ? json : null
  }
  const full = attempt(entry)
  if (full !== null) return full
  const noScrollback = attempt({ ...entry, scrollback: undefined })
  if (noScrollback !== null) return noScrollback
  const gridOnly = attempt({ grid: entry.grid, updatedAt: entry.updatedAt })
  return gridOnly
}

export function saveSurfaceScreen(surfaceRef: string, screen: CachedScreen): void {
  if (typeof window === 'undefined') return

  const prev = loadSurfaceScreen(surfaceRef)
  const merged: CachedScreen = { updatedAt: screen.updatedAt }
  const text = screen.text ?? prev?.text
  if (text !== undefined) merged.text = clampTail(text)
  const scrollback = screen.scrollback ?? prev?.scrollback
  if (scrollback !== undefined) merged.scrollback = clampTail(scrollback)
  const grid = screen.grid ?? prev?.grid
  if (grid !== undefined) merged.grid = grid

  const payload = fitEntry(merged)
  if (payload === null) return // grid だけでも上限を超える。この entry は保存しない（C5）

  const key = keyFor(surfaceRef)
  // C4: 二次ガード。書く前に件数を上限内へ落とす。
  const others = cacheKeys().filter((k) => k.key !== key)
  while (others.length >= MAX_CACHED_SURFACES) {
    const oldest = others.shift()
    if (!oldest) break
    localStorage.removeItem(oldest.key)
  }

  // C3: Quota を捕まえたら古い順に消しながら、成功するか候補が尽きるまで再試行する。
  const candidates = cacheKeys().filter((k) => k.key !== key)
  for (;;) {
    try {
      localStorage.setItem(key, payload)
      return
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'QuotaExceededError') return
      const victim = candidates.shift()
      if (!victim) return // 候補が尽きた。諦める
      localStorage.removeItem(victim.key)
    }
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/lib/__tests__/surface-cache.test.ts`
Expected: PASS（既存テストも含めて全件）。

- [ ] **Step 5: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 6: コミット**

```bash
git add apps/client/src/lib/surface-cache.ts apps/client/src/lib/__tests__/surface-cache.test.ts
git commit -m "$(cat <<'EOF'
feat(client): オフラインキャッシュに entry 上限と Quota の反復退避を入れる (D8 C2-C5)

C5: 直列化後の 1 entry に実バイト数の上限を設ける。TextEncoder で測るのは
String.length が UTF-16 code unit 数で、CJK を含むと実バイト数と大きくずれるため。
超えたら scrollback -> text -> grid の順に削り、grid だけでも超えるなら保存しない。

C3: QuotaExceededError を握り潰さず、updatedAt の古い順に削除しながら成功するか
候補が尽きるまで再試行する。1 件だけ消して 1 回再試行では足りない。

C4: MAX_CACHED_SURFACES = 12 を二次ガードとして残す。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 6: `useCmux` — `SwitcherState` の所有と RPC の作り替え

**Files:**
- Modify: `apps/client/src/hooks/useCmux.ts`（`selectWorkspace` 削除、`createWorkspace` / `createSurface` / `listSurfaces` の作り替え、`useReducer` の導入、移行用 shim の追加）
- Modify: `apps/client/src/lib/cmux-rpc.ts:45-54`（`Surface` 型に D7 の属性を足す）
- Modify: `apps/client/src/App.tsx`（`selectWorkspace` の 2 呼び出し元、`listSurfaces(currentWorkspace)` の 2 箇所（`App.tsx:157,244`）、初期取得 effect）
- Modify: `apps/client/src/components/Drawer.tsx`（現行の prop 名は **`onSelect`**。ワークスペース行タップの意味を変える）
- Test: `apps/client/src/hooks/__tests__/useCmux.test.ts`
- Test: `apps/client/src/__tests__/App.test.tsx`（**既存テストが `listSurfaces` に workspace ref が付くことを期待している**。全ワークスペース契約へ更新する）
- Test: `apps/client/src/components/__tests__/Drawer.test.tsx`（`onSelect` の意味変更に追随）

**Interfaces:**
- Consumes: Task 1（`FlatSurface` の新属性）, Task 2（`rpc` の即時 reject）, Task 4（`createSwitcherReducer`）, Task 5（`loadSurfaceScreen`）
- Produces: `useCmux()` が返すもの:
  ```ts
  { status, workspaces, surfaces, notifications,
    view: ViewState, feeds: Map<string, TerminalFeed>,
    selectSurface: (surface: SurfaceLike) => void,
    initializeFrom: (surfaces: readonly SurfaceLike[], preferredRef: string | null) => void,
    reconcileWith: (surfaces: readonly SurfaceLike[]) => void,
    currentWorkspace: string | null,   // view.foregroundWorkspaceRef からの導出値
    listWorkspaces, listSurfaces, createSurface, createWorkspace, closeSurface, closeWorkspace,
    readText, readGrid, sendText, sendKey, getTree, listNotifications }
  ```
  **Task 6 の時点では旧 API を「新 state 上の薄い shim」として残す**（下の「移行の作法」）。
  最終的に削除するのは Task 11 である。Task 9〜11 が新 API を使う。

> `focus` / `promote` / `initialize` / `reconcile` は `lib/view-state.ts` の内部に留め、hook からは公開しない。

### 移行の作法 — 各タスクを常にグリーンに保つ

> **このタスクで削除する / 残すものの確定リストは、下の「実装手順 Step 4」の表が正である。**
> 以下は方針の説明であり、個々の関数名の扱いは Step 4 に従うこと。

Global Constraints は「各タスクの最後で `pnpm check` と `pnpm test` の両方を通す」と定めている。
`useCmux` の公開 API を一度に作り替えると Task 11 まで型エラーが残り、この契約を破る。
そこで **Task 6 では旧 API を削除せず、新しい `SwitcherState` の上に載る shim として残す。**

```ts
  // ---- 移行用 shim。Task 11 で削除する。新しいコードから使わないこと。----
  /** @deprecated Task 11 で削除。view.foreground を使う */
  const currentSurface = switcher.view.foreground
  /** @deprecated Task 11 で削除。selectSurface(surface) を使う */
  const focusSurface = useCallback(
    (ref: string) => {
      const surface = surfaces.find((s) => s.ref === ref)
      if (surface) selectSurface(surface)
    },
    [surfaces, selectSurface],
  )
```

**`selectWorkspace` だけは shim にしない** — 「何もしない関数」を残すと、Task 6〜10 の間だけ
ワークスペース切替が無言で壊れた状態になる。代わりに **Task 6 の中で呼び出し元を同時に直す**
（確定リストは Step 4 の表）。

`panes` / `currentPane` / `listPanes` / `navigatePane` / `navigateSurface` は本設計では使われないが、
**Task 6 では触らない**。Task 11 で `App.tsx` から参照が消えたのを確認してからまとめて削除する。
**`navigateWorkspace` だけは例外**で、`selectWorkspace` に依存するため Task 6 で削除する。

この方針により **Task 6 / 7 / 8 / 9 / 10 / 11 のすべてで `pnpm check` と `pnpm test` が通る。**

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe('D1 workspace.select を一度も呼ばない', () => {
  it('createWorkspace でも closeWorkspace でも workspace.select が飛ばない', async () => {
    hoisted.responses['workspace.create'] = {
      workspace_ref: 'workspace:30',
      workspace_id: 'C459840B-0000-0000-0000-000000000030',
      surface_ref: 'surface:200',
      surface_id: 'S-200',
    }
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:200', type: 'terminal', title: 'zsh', workspace_ref: 'workspace:30', workspace_id: 'C459840B-0000-0000-0000-000000000030' }],
    }
    hoisted.responses['workspace.list'] = { workspaces: [{ ref: 'workspace:30' }] }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.createWorkspace()
    })
    const methods = hoisted.sent.map((s) => (JSON.parse(s) as { method: string }).method)
    expect(methods).not.toContain('workspace.select')
  })

  it('selectWorkspace は公開 API から消えている', () => {
    const { result } = renderHook(() => useCmux())
    expect('selectWorkspace' in result.current).toBe(false)
  })

  it('移行用 shim（currentSurface / focusSurface）はまだ残っている', () => {
    // Task 11 で削除する。ここで存在を固定しておくことで、Task 6〜10 の間に
    // App.tsx が型エラーにならないことを保証する。
    const { result } = renderHook(() => useCmux())
    expect('currentSurface' in result.current).toBe(true)
    expect(typeof result.current.focusSurface).toBe('function')
  })
})

describe('D1.1 createWorkspace の 3 手順', () => {
  it('surface.create を呼ばず、workspace.create が返した surface を前面化する', async () => {
    // 上と同じ responses
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.createWorkspace()
    })
    const methods = hoisted.sent.map((s) => (JSON.parse(s) as { method: string }).method)
    expect(methods).not.toContain('surface.create')
    expect(methods.filter((m) => m === 'surface.list')).toHaveLength(1) // 共通 refresh を 1 回だけ
    expect(result.current.view.foreground).toBe('surface:200')
    // step 3 は selectSurface を通る（= 購読集合にも入る）。focus を直接呼ぶ経路は無い。
    expect(result.current.view.subscriptions.map((s) => s.ref)).toContain('surface:200')
  })

  it('返った surface_ref が一覧に無ければ前面を変えず、エラーにもしない', async () => {
    hoisted.responses['workspace.create'] = { workspace_ref: 'workspace:30', surface_ref: 'surface:999' }
    hoisted.responses['surface.list'] = { surfaces: [{ ref: 'surface:1', type: 'terminal', title: 'a', workspace_ref: 'workspace:1', workspace_id: 'W1' }] }
    const { result } = renderHook(() => useCmux())
    act(() => {
      result.current.initializeFrom([{ ref: 'surface:1', type: 'terminal', workspace_ref: 'workspace:1', index: 0 }], null)
    })
    await act(async () => {
      await expect(result.current.createWorkspace()).resolves.toBeDefined()
    })
    expect(result.current.view.foreground).toBe('surface:1')
  })
})

describe('P7/P8/P9 createSurface', () => {
  it('workspace_id を渡し、レスポンスの surface_ref を前面化する（差分探索をしない）', async () => {
    hoisted.responses['surface.create'] = {
      surface_ref: 'surface:118',
      surface_id: 'S-118',
      workspace_id: 'W26',
      type: 'terminal',
    }
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:118', type: 'terminal', title: 'zsh', workspace_ref: 'workspace:26', workspace_id: 'W26' }],
    }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.createSurface('W26')
    })
    const create = hoisted.sent.map((s) => JSON.parse(s) as { method: string; params: Record<string, unknown> }).find((r) => r.method === 'surface.create')
    expect(create?.params.workspace_id).toBe('W26')
    expect(create?.params.workspace_ref).toBeUndefined()
    expect(result.current.view.foreground).toBe('surface:118')
  })

  it('レスポンスの workspace_id が要求と違えば警告を返すが、端末は残す（P8）', async () => {
    hoisted.responses['surface.create'] = { surface_ref: 'surface:118', workspace_id: 'W1' }
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:118', type: 'terminal', title: 'zsh', workspace_ref: 'workspace:1', workspace_id: 'W1' }],
    }
    const { result } = renderHook(() => useCmux())
    let outcome: { misplaced: boolean } | undefined
    await act(async () => {
      outcome = await result.current.createSurface('W26')
    })
    expect(outcome?.misplaced).toBe(true)
    expect(result.current.view.foreground).toBe('surface:118') // rollback しない
  })
})

describe('listSurfaces は全ワークスペースを取る', () => {
  it('workspace_ref を渡さない', async () => {
    hoisted.responses['surface.list'] = { surfaces: [] }
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.listSurfaces()
    })
    const req = hoisted.sent.map((s) => JSON.parse(s) as { method: string; params: Record<string, unknown> }).find((r) => r.method === 'surface.list')
    expect(req?.params.workspace_ref).toBeUndefined()
  })
})

describe('currentWorkspace は導出値', () => {
  it('前面のワークスペースに追従する', () => {
    const { result } = renderHook(() => useCmux())
    act(() => {
      result.current.initializeFrom(
        [
          { ref: 'surface:1', type: 'terminal', workspace_ref: 'workspace:1', index: 0 },
          { ref: 'surface:2', type: 'terminal', workspace_ref: 'workspace:26', index: 1 },
        ],
        'surface:2',
      )
    })
    expect(result.current.currentWorkspace).toBe('workspace:26')
  })
})

describe('D3.1 selectSurface の原子性（合成 reducer の結合テスト）', () => {
  // retained memory / cache / none の 3 入力で、foreground が変わった「最初のコミット」に
  // 対応する feed が既に warming/loading になっていること（中間コミットが無いこと）。
  const renderCounts: { view: string | null; feedStatus: string | undefined }[] = []

  function trackingHook() {
    const cmux = useCmux()
    renderCounts.push({
      view: cmux.view.foreground,
      feedStatus: cmux.view.foreground === null ? undefined : cmux.feeds.get(cmux.view.foreground)?.status,
    })
    return cmux
  }

  beforeEach(() => {
    renderCounts.length = 0
    localStorage.clear()
  })

  it('none: 最初のコミットで loading/none になっている（中間コミットが無い）', () => {
    const { result } = renderHook(() => trackingHook())
    const surfaces = [{ ref: 'surface:1', type: 'terminal', workspace_ref: 'workspace:1', index: 0 }]
    act(() => {
      result.current.initializeFrom(surfaces, 'surface:1')
    })
    const firstWithForeground = renderCounts.find((r) => r.view === 'surface:1')
    expect(firstWithForeground?.feedStatus).toBe('loading')
  })

  it('cache: 最初のコミットで warming/cache になっている', () => {
    localStorage.setItem(
      'cmux-surface-cache:surface:1',
      JSON.stringify({ scrollback: 'cached', updatedAt: 500 }),
    )
    const { result } = renderHook(() => trackingHook())
    const surfaces = [{ ref: 'surface:1', type: 'terminal', workspace_ref: 'workspace:1', index: 0 }]
    act(() => {
      result.current.initializeFrom(surfaces, 'surface:1')
    })
    const first = renderCounts.find((r) => r.view === 'surface:1')
    expect(first?.feedStatus).toBe('warming')
    expect(result.current.feeds.get('surface:1')?.source).toBe('cache')
  })

  // 「retained memory（追い出し → 再昇格）で最初のコミットが warming/memory」は
  // feed を live へ進めるために applyFeedResult が要る。それが公開されるのは Task 8 なので、
  // このテストは Task 8 に置く（Task 6 時点では型が通らない）。

  it('focus / promote は hook の公開 API に出ていない', () => {
    const { result } = renderHook(() => useCmux())
    expect('focus' in result.current).toBe(false)
    expect('promote' in result.current).toBe(false)
    expect('reconcile' in result.current).toBe(false)
    expect('initialize' in result.current).toBe(false)
  })
})

describe('既存ガードの複数端末版', () => {
  it('read_text / terminal.replay / send_text は surface_id を使い surface_ref を使わない', async () => {
    const { result } = renderHook(() => useCmux())
    await act(async () => {
      await result.current.readText('surface:5')
      await result.current.readGrid('surface:6')
      await result.current.sendText('surface:7', 'ls')
    })
    const reqs = hoisted.sent.map((s) => JSON.parse(s) as { method: string; params: Record<string, unknown> })
    for (const method of ['surface.read_text', 'terminal.replay', 'surface.send_text']) {
      const req = reqs.find((r) => r.method === method)
      expect(req?.params.surface_ref).toBeUndefined()
      expect(typeof req?.params.surface_id).toBe('string')
    }
  })
})
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: FAIL。

- [ ] **Step 3: `Surface` 型を D7 に合わせる**

`apps/client/src/lib/cmux-rpc.ts`:

```ts
export interface Surface {
  index: number
  ref: string
  // ペイン内選択。全ワークスペースを平坦化すると複数 true になり得る（active とは別物）。
  selected: boolean
  // system.tree の result.active.surface_ref と一致する 1 件だけ true（D7）。初期前面の決定に使う。
  active?: boolean
  title: string
  type: string
  pane_ref?: string
  workspace_ref: string
  workspace_title: string
  // surface.create の作成先指定に使う UUID（workspace_ref は無視される。P6/P7）。
  workspace_id: string
  url?: string | null
}
```

- [ ] **Step 4: `useCmux` を作り替える**

**このタスクで削除するもの**: `selectWorkspace` / `navigateWorkspace` と、`useCmux.ts:101-103` の
誤ったコメント。`navigateWorkspace` は `useCmux.ts:283-292` で `selectWorkspace` を直接呼んでいるので、
残すと未定義参照になる。**同じコミットで削除する**（呼び出し元は現状 `App.tsx` のキーボード
ショートカット等だけなので、参照が無いことを `grep` で確認してから消す）。

**`selectWorkspace` の呼び出し元は 3 箇所ある**（実コードで確認済み）。すべて同じコミットで直す。

| 場所 | 現状 | Task 6 での扱い |
|---|---|---|
| `App.tsx:381` | ドロワーのワークスペース行タップ（`Drawer` の `onSelect` prop） | RPC を投げない。この時点では**空関数にせず、`Drawer` の `onSelect` prop ごと削除**して展開/折りたたみは Task 10 で入れる。暫定として「そのワークスペース配下の先頭サーフェスを `selectSurface` する」に置き換えてもよい（挙動が壊れない） |
| `App.tsx:345` | **Push 通知タップの遷移**（`workspaces.find(w => w.id === workspaceId)` で UUID から解決し `selectWorkspace(target.ref)`） | 下の「Push 経路の移行」のとおり `selectSurface` へ移す |
| `useCmux.ts:283-292` | `navigateWorkspace` | 関数ごと削除する |

> `closeWorkspace` は呼び出し元ではなく hook 内の別処理である（`currentWorkspace` を見て state を
> クリアしている）。`currentWorkspace` が導出値になるのでこのクリア自体が不要になる。

**Push 経路の移行（P1-4。spec §4 D1 の 3 番目の経路）**

Web Push が渡すのは **`workspace_id`（UUID）**である（`push/payload.ts:12` が
`/?workspace=${n.workspace_id}`、`sw.ts:55` が `postMessage({ type:'navigate', workspaceId })`）。
**`workspace_ref` ではない。** 現行の `workspaces.find(w => w.id === workspaceId)` による解決は
そのまま維持し、選択だけを差し替える。

```ts
    const navigateTo = (workspaceId: string) => {
      // Push が渡すのは UUID。Workspace.id で引く（ref では引けない）。
      const ws = workspaces.find((w) => w.id === workspaceId)
      if (!ws) return
      const inWs = surfaces.filter((s) => s.workspace_ref === ws.ref)
      // 購読中があればそれ、無ければ先頭（spec §4 D1 の表）。
      const subscribed = new Set(view.subscriptions.map((x) => x.ref))
      const target = inWs.find((s) => subscribed.has(s.ref)) ?? inWs[0]
      if (target) selectSurface(target)   // ← initializeFrom は使わない（下記）
    }
```

**マウント後の通知ジャンプに `initializeFrom` を使ってはならない。** `initialize` は購読集合を
「選んだ 1 件だけ」に作り直すので、それまでのバックグラウンド購読が全部落ちる。
`initializeFrom` は**初回 bootstrap のみ**で使い、そこには「ディープリンク → `sessionStorage`」を
1 個の `preferredRef` に解決してから渡す。

**このタスクでは削除しないもの**（Task 11 で削除する）: `currentSurface` / `focusSurface`（shim として残す）、
`panes` / `currentPane` / `listPanes` / `navigatePane` / `navigateSurface`（触らない）。

追加するもの:

```ts
  const reducer = useMemo(() => createSwitcherReducer(loadSurfaceScreen), [])
  const [switcher, dispatch] = useReducer(reducer, undefined, () => ({
    view: { subscriptions: [], foreground: null, foregroundWorkspaceRef: null },
    feeds: new Map<string, TerminalFeed>(),
  }))

  // 前面を変える公開経路はこの 3 つだけ。focus / promote は公開しない（D3.1）。
  const selectSurface = useCallback((surface: SurfaceLike) => {
    dispatch({ type: 'select', surface, now: Date.now(), cap: MAX_LIVE_SUBSCRIPTIONS })
  }, [])
  const initializeFrom = useCallback((surfaces: readonly SurfaceLike[], preferredRef: string | null) => {
    dispatch({ type: 'initialize', surfaces, preferredRef, now: Date.now() })
  }, [])
  const reconcileWith = useCallback((surfaces: readonly SurfaceLike[]) => {
    dispatch({ type: 'reconcile', surfaces, now: Date.now() })
  }, [])

  // 保持する state ではなく前面サーフェスからの導出値（D1）。
  const currentWorkspace = switcher.view.foregroundWorkspaceRef
```

`listSurfaces` は引数なしで全ワークスペースを取り、`reconcileWith` を通す:

```ts
  const listSurfaces = useCallback(async () => {
    const result = (await rpc('surface.list')) as { surfaces?: Surface[] }
    const list = result.surfaces ?? []
    setSurfaces(list)
    reconcileWith(list)
    return list
  }, [rpc, reconcileWith])
```

`createSurface` は `workspace_id` 指定 + レスポンスから ref を取り、`workspace_id` を検証する:

```ts
  const createSurface = useCallback(
    async (workspaceId: string): Promise<{ list: Surface[]; misplaced: boolean }> => {
      // workspace_ref は無視される。workspace_id（UUID）だけが効く（P6/P7）。
      const created = (await rpc('surface.create', { workspace_id: workspaceId })) as {
        surface_ref?: string
        workspace_id?: string
      }
      // 無効な workspace_id はエラーにならず選択中 WS に作られる（P8）。作成自体は成功して
      // いるので端末は残し、誤配置だけ呼び出し側へ伝える（自動 rollback はしない）。
      const misplaced = created.workspace_id !== undefined && created.workspace_id !== workspaceId
      const list = await listSurfaces()
      const surface = list.find((s) => s.ref === created.surface_ref)
      if (surface) selectSurface(surface)
      return { list, misplaced }
    },
    [rpc, listSurfaces, selectSurface],
  )
```

`createWorkspace` は D1.1 の 3 手順（`surface.create` を呼ばない）:

```ts
  const createWorkspace = useCallback(async () => {
    // workspace.create {} 自体が新しいワークスペースと既定のターミナルを 1 つ作り、
    // surface_ref を返す（P13-C）。ここで surface.create を呼ぶと端末が 2 つできる。
    const created = (await rpc('workspace.create')) as { surface_ref?: string }
    // レスポンスに type が無いので SurfaceLike を合成せず、一覧を引き直してから前面化する。
    const [list] = await Promise.all([listSurfaces(), listWorkspaces()])
    const surface = list.find((s) => s.ref === created.surface_ref)
    // 他クライアントが即座に閉じた等で見つからなければ前面を変えない（エラーにしない）。
    if (surface) selectSurface(surface)
    return list
  }, [rpc, listSurfaces, listWorkspaces, selectSurface])
```

`closeWorkspace` はサーフェス一覧も更新する（現行は `listWorkspaces()` しか呼んでいない）:

```ts
  const closeWorkspace = useCallback(
    async (workspaceRef: string) => {
      await rpc('workspace.close', { workspace_id: workspaceRef })
      // 閉じた WS 配下のサーフェスがタブに残らないよう、両方の一覧を更新する（D2.1 の T3）。
      const [, wsList] = await Promise.all([listSurfaces(), listWorkspaces()])
      return wsList
    },
    [rpc, listSurfaces, listWorkspaces],
  )
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts`
Expected: PASS。

- [ ] **Step 6: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。**shim のおかげでこの時点でもグリーンになる。**
`App.tsx` は `currentSurface` / `focusSurface` を通じて従来どおり動き続ける
（ポーリングの置き換えは Task 8、表示の作り替えは Task 11）。

- [ ] **Step 7: コミット**

```bash
git add apps/client/src/hooks/useCmux.ts apps/client/src/lib/cmux-rpc.ts apps/client/src/App.tsx apps/client/src/components/Drawer.tsx apps/client/src/hooks/__tests__/useCmux.test.ts apps/client/src/__tests__/App.test.tsx apps/client/src/components/__tests__/Drawer.test.tsx
git commit -m "$(cat <<'EOF'
feat(client): useCmux が SwitcherState を持ち workspace.select を捨てる (D1/D1.1)

selectWorkspace を削除し、selectSurface / initializeFrom / reconcileWith を公開する。
currentWorkspace は保持する state ではなく foregroundWorkspaceRef からの導出値にする。
currentSurface / focusSurface は新 state 上の移行用 shim として残す（Task 11 で削除）。
これにより App.tsx が追随するまでの間も pnpm check が通る。

createWorkspace は D1.1 の 3 手順に置き換える。workspace.create 自体が既定端末を
作るので surface.create を呼ぶと端末が 2 つできる。レスポンスに type が無いため
SurfaceLike を合成せず、一覧を引き直してから前面化する。

createSurface は workspace_id（UUID）を渡し、レスポンスの surface_ref を使う
（作成前後の差分探索は不要になった）。レスポンスの workspace_id が要求と違えば
誤配置として呼び出し側へ伝えるが、端末は残す（自動 rollback しない）。

closeWorkspace がサーフェス一覧も更新するようにした（閉じた WS 配下のタブが残る問題）。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 7: `useCmux` — topology 再取得ループ（D2.1 の T1〜T5 と `generation`）

**Files:**
- Modify: `apps/client/src/hooks/useCmux.ts`
- Modify: `apps/client/src/App.tsx`（**初期取得 effect から surface/workspace の直接取得を外す**。下記）
- Test: `apps/client/src/hooks/__tests__/useCmux.test.ts`
- Test: `apps/client/src/__tests__/App.test.tsx`（既存。`useCmux` を全面 mock している側）
- **Create: `apps/client/src/__tests__/app-integration.test.tsx`**（新規。`useCmux` を mock せず `App` を mount し、RPC 本数と到着順を検証する専用ハーネス）

**Interfaces:**
- Consumes: Task 6 の `listSurfaces` / `reconcileWith`
- Produces:
  ```ts
  export interface TopologySnapshot { generation: number; surfaces: Surface[]; workspaces: Workspace[] }
  requestTopologyRefresh: () => Promise<TopologySnapshot>
  ```
  Task 6 の `createWorkspace` / `createSurface` / `closeSurface` / `closeWorkspace` が「直接 `listSurfaces` を呼ぶ」代わりにこれを **1 回**呼び、**返ってきた `snapshot.surfaces` から**目的の ref を引く。

> **`Promise<number>` にしてはならない。** async callback が閉じ込めた React の `surfaces` state は
> 呼び出し開始時の render のものであり、refresh 内で `setSurfaces` が走って再 render されても、
> 実行中の continuation が新しい値を見ることはない。`await` の後に `surfaces` を読むと**常に
> 作成前のスナップショット**を見る（T5 と衝突したときだけの問題ではない）。
> 取得した一覧そのものを返すのが唯一の確実な方法である。
>
> **失敗した refresh は resolve してはならない。** 取得に失敗しても generation を進めて成功
> resolve すると、古い一覧を「適用済み」として扱うことになる。reject して呼び出し側に
> 判断させる（mutation 側は前面を変えず、エラーにもしない）。

**これも spec §10 R9 の未レビュー箇所である。**

| # | 再取得の契機 |
|---|---|
| T1 | WS の接続・再接続直後 |
| T2 | `visibilitychange` / `pageshow` / `focus` での復帰時 |
| T3 | 自 PWA が行ったトポロジ変更の直後（`surface.create` / `surface.close` / `workspace.create` / `workspace.close`） |
| T4 | stale surface エラーを検出したとき |
| T5 | `TOPOLOGY_POLL_INTERVAL = 5000ms` の低頻度ポーリング |

規律: E1（自己再帰スケジュール）・E2（in-flight は 1 件）・E4 の hidden 停止と遅延応答破棄だけを適用する。E3 は対象が単一なので適用しない。**失敗しても既存の一覧を捨てない。**

dirty の規則:
1. 同時に保持する queued refresh は最大 1 件
2. dirty は**各取得の開始前に**消費する
3. その取得の最中にまた立ったら完了後にもう 1 件走る

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe('D2.1 topology 再取得ループ', () => {
  it('single-flight: in-flight 中に何回要求しても同時に 2 本投げない', async () => {
    vi.useFakeTimers()
    hoisted.swallow.value = true // 応答を返さず in-flight を作る
    const { result } = renderHook(() => useCmux())
    act(() => {
      void result.current.requestTopologyRefresh()
      void result.current.requestTopologyRefresh()
      void result.current.requestTopologyRefresh()
    })
    const listCalls = hoisted.sent.filter((s) => (JSON.parse(s) as { method: string }).method === 'surface.list')
    expect(listCalls).toHaveLength(1)
    vi.useRealTimers()
  })

  it('in-flight 中に来た要求は 1 件だけ queue され、完了後に follow-up が 1 回走る', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.gate.open = false // 応答を保留するゲート
    act(() => {
      void result.current.requestTopologyRefresh()
    })
    act(() => {
      void result.current.requestTopologyRefresh()
      void result.current.requestTopologyRefresh()
    })
    await act(async () => {
      hoisted.gate.release() // 1 本目を完了させる
    })
    const listCalls = hoisted.sent.filter((s) => (JSON.parse(s) as { method: string }).method === 'surface.list')
    expect(listCalls).toHaveLength(2) // 3 回要求されても follow-up は 1 回
  })

  it('follow-up の実行中にさらに要求すると、もう 1 回走る（dirty は開始前に消費する）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.gate.open = false
    act(() => {
      void result.current.requestTopologyRefresh()
    })
    act(() => {
      void result.current.requestTopologyRefresh()
    })
    await act(async () => {
      hoisted.gate.release() // 1 本目完了 → follow-up 開始
    })
    act(() => {
      void result.current.requestTopologyRefresh() // follow-up の実行中に要求
    })
    await act(async () => {
      hoisted.gate.release() // follow-up 完了 → さらにもう 1 回
    })
    await act(async () => {
      hoisted.gate.release()
    })
    const listCalls = hoisted.sent.filter((s) => (JSON.parse(s) as { method: string }).method === 'surface.list')
    expect(listCalls).toHaveLength(3)
  })

  it('requestTopologyRefresh は取得した一覧そのものを返す（React state のクロージャに依存しない）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:200', type: 'terminal', title: 'zsh', index: 0, workspace_ref: 'workspace:30', workspace_id: 'W30', workspace_title: 'new' }],
    }
    hoisted.responses['workspace.list'] = { workspaces: [{ ref: 'workspace:30' }] }
    let snapshot: TopologySnapshot | undefined
    await act(async () => {
      snapshot = await result.current.requestTopologyRefresh()
    })
    expect(snapshot?.surfaces.map((s) => s.ref)).toEqual(['surface:200'])
    expect(snapshot?.workspaces.map((w) => w.ref)).toEqual(['workspace:30'])
  })

  it('取得に失敗した refresh は resolve せず reject する（古い一覧を適用済みとして扱わない）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    await act(async () => {
      await expect(result.current.requestTopologyRefresh()).rejects.toThrow()
    })
  })

  it('hidden 中に返った応答は state へ反映しない（D2.1 の E4）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:1', type: 'terminal', title: 'a', index: 0, workspace_ref: 'workspace:1', workspace_id: 'W1', workspace_title: 'x' }],
    }
    hoisted.gate.open = false
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      hoisted.gate.release()
    })
    expect(result.current.surfaces).toHaveLength(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('復帰イベントが重なっても T5 のタイマーは常に 1 本', async () => {
    vi.useFakeTimers()
    hoisted.responses['surface.list'] = { surfaces: [] }
    renderHook(() => useCmux())
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pageshow'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    const before = hoisted.sent.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPOLOGY_POLL_INTERVAL)
    })
    const listCalls = hoisted.sent
      .slice(before)
      .filter((x) => (JSON.parse(x) as { method: string }).method === 'surface.list')
    // タイマーが増殖していれば 1 周期で複数回飛ぶ
    expect(listCalls).toHaveLength(1)
    vi.useRealTimers()
  })

  it('requestTopologyRefresh は「自分の要求を包含する refresh の適用」まで resolve しない', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.gate.open = false
    let first: TopologySnapshot | undefined
    let second: TopologySnapshot | undefined
    act(() => {
      void result.current.requestTopologyRefresh().then((snap) => {
        first = snap
      })
    })
    act(() => {
      // 1 本目の in-flight 中に来た要求。1 本目の完了で resolve してはいけない。
      void result.current.requestTopologyRefresh().then((snap) => {
        second = snap
      })
    })
    await act(async () => {
      hoisted.gate.release()
    })
    expect(first?.generation).toBe(1)
    expect(second).toBeUndefined() // まだ resolve していない
    await act(async () => {
      hoisted.gate.release() // follow-up が適用される
    })
    expect(second?.generation).toBe(2)
  })

  it('先行 refresh が失敗しても queued waiter は宙に浮かない（follow-up の成功で resolve）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.gate.open = false
    let first: string | undefined
    let second: string | undefined
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    act(() => {
      void result.current.requestTopologyRefresh().then(
        () => { first = 'resolved' },
        () => { first = 'rejected' },
      )
    })
    act(() => {
      void result.current.requestTopologyRefresh().then(
        () => { second = 'resolved' },
        () => { second = 'rejected' },
      )
    })
    await act(async () => {
      hoisted.gate.release() // 1 本目が失敗する
    })
    expect(first).toBe('rejected')
    // ここで follow-up は成功させる
    delete hoisted.errors['surface.list']
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.responses['workspace.list'] = { workspaces: [] }
    await act(async () => {
      hoisted.gate.release()
    })
    expect(second).toBe('resolved') // ← 旧設計ではここが永久に undefined になっていた
  })

  it('follow-up も失敗すれば queued waiter は reject される（settle せずに残らない）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    hoisted.gate.open = false
    let second: string | undefined
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    act(() => {
      void result.current.requestTopologyRefresh().then(
        () => { second = 'resolved' },
        () => { second = 'rejected' },
      )
    })
    await act(async () => {
      hoisted.gate.release()
      hoisted.gate.release()
    })
    expect(second).toBe('rejected')
  })

  it('hidden 中はタイマーを張らず、復帰で再開する', async () => {
    vi.useFakeTimers()
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.responses['workspace.list'] = { workspaces: [] }
    renderHook(() => useCmux())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const before = hoisted.sent.length
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(vi.getTimerCount()).toBe(0) // タイマーが張られていない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPOLOGY_POLL_INTERVAL * 3)
    })
    expect(hoisted.sent.length).toBe(before)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hoisted.sent.length).toBeGreaterThan(before) // 復帰で再開する
    vi.useRealTimers()
  })

  it('T1〜T5 の各契機が再取得を起こす', async () => {
    vi.useFakeTimers()
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.responses['workspace.list'] = { workspaces: [] }
    const { result } = renderHook(() => useCmux()) // T1: 接続直後
    const count = () => hoisted.sent.filter((x) => (JSON.parse(x) as { method: string }).method === 'surface.list').length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(count()).toBe(1) // T1
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange')) // T2
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(count()).toBe(2)
    await act(async () => {
      await result.current.requestTopologyRefresh() // T3 相当（mutation からの明示要求）
    })
    expect(count()).toBe(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPOLOGY_POLL_INTERVAL) // T5
    })
    expect(count()).toBe(4)
    vi.useRealTimers()
  })

  it('外部での create/close/move が一覧へ反映される', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:1', type: 'terminal', title: 'a', index: 0, workspace_ref: 'workspace:1', workspace_id: 'W1', workspace_title: 'x' }],
    }
    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    // 別クライアントが surface:2 を作り、surface:1 を move（ref が振り直される）
    hoisted.responses['surface.list'] = {
      surfaces: [
        { ref: 'surface:2', type: 'terminal', title: 'b', index: 0, workspace_ref: 'workspace:1', workspace_id: 'W1', workspace_title: 'x' },
        { ref: 'surface:119', type: 'terminal', title: 'a', index: 1, workspace_ref: 'workspace:26', workspace_id: 'W26', workspace_title: 'y' },
      ],
    }
    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    expect(result.current.surfaces.map((s) => s.ref)).toEqual(['surface:2', 'surface:119'])
    expect(result.current.view.subscriptions.map((s) => s.ref)).not.toContain('surface:1')
  })

  it('closeWorkspace の後にサーフェス一覧も reconcile される', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.responses['workspace.list'] = { workspaces: [] }
    await act(async () => {
      await result.current.closeWorkspace('workspace:26')
    })
    const methods = hoisted.sent.map((x) => (JSON.parse(x) as { method: string }).method)
    expect(methods).toContain('surface.list') // 閉じた WS 配下のタブが残らない
  })

  it('D1.1: workspace.create の T3 が既存の T5 in-flight と衝突しても、作成後の snapshot を見る', async () => {
    const { result } = renderHook(() => useCmux())
    // T5 を in-flight にする（作成前の一覧を返す）
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.gate.open = false
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    // 作成後の一覧に切り替えてから createWorkspace を呼ぶ
    hoisted.responses['workspace.create'] = { workspace_ref: 'workspace:30', surface_ref: 'surface:200' }
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:200', type: 'terminal', title: 'zsh', index: 0, workspace_ref: 'workspace:30', workspace_id: 'W30', workspace_title: 'new' }],
    }
    hoisted.responses['workspace.list'] = { workspaces: [{ ref: 'workspace:30' }] }
    await act(async () => {
      const done = result.current.createWorkspace()
      hoisted.gate.release() // 1 本目（作成前）が完了
      hoisted.gate.release() // follow-up（作成後）が完了
      await done
    })
    // 作成前の snapshot で「ref 不在」と判定してはいけない
    expect(result.current.view.foreground).toBe('surface:200')
  })

  it('follow-up が失敗したら前面を変えない（旧 snapshot で前面化しない）', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:1', type: 'terminal', title: 'a', index: 0, workspace_ref: 'workspace:1', workspace_id: 'W1', workspace_title: 'x' }],
    }
    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    act(() => {
      result.current.selectSurface(result.current.surfaces[0] as Surface)
    })
    hoisted.responses['workspace.create'] = { workspace_ref: 'workspace:30', surface_ref: 'surface:200' }
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    await act(async () => {
      await expect(result.current.createWorkspace()).resolves.toBeUndefined()
    })
    expect(result.current.view.foreground).toBe('surface:1')
  })

  it('片方の list が先に失敗しても、もう片方が settle するまで follow-up を始めない', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    hoisted.responses['workspace.list'] = { workspaces: [] }
    hoisted.gate.openFor = { 'surface.list': true, 'workspace.list': false } // workspace.list だけ保留
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined) // dirty を立てる
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const count = (m: string) => hoisted.sent.filter((x) => (JSON.parse(x) as { method: string }).method === m).length
    // surface.list は失敗済みだが workspace.list がまだ保留。follow-up は始まらない。
    expect(count('workspace.list')).toBe(1)
    await act(async () => {
      hoisted.gate.release('workspace.list')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(count('workspace.list')).toBe(2) // ここで初めて follow-up が走る
  })

  it('hidden 中に溜めた waiter は unmount で reject される（永久未 settle にしない）', async () => {
    const { result, unmount } = renderHook(() => useCmux())
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    let settled: string | undefined
    act(() => {
      void result.current.requestTopologyRefresh().then(
        () => { settled = 'resolved' },
        () => { settled = 'rejected' },
      )
    })
    expect(settled).toBeUndefined()
    await act(async () => {
      unmount()
    })
    expect(settled).toBe('rejected')
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('hidden 中の直接 requestTopologyRefresh は RPC を 0 件に保つ', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.responses['workspace.list'] = { workspaces: [] }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const before = hoisted.sent.length
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    let settled = false
    act(() => {
      void result.current.requestTopologyRefresh().then(
        () => { settled = true },
        () => { settled = true },
      )
    })
    expect(hoisted.sent.length).toBe(before) // RPC を出していない
    expect(settled).toBe(false) // waiter は保持されている
    // 復帰で回収される
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(settled).toBe(true)
  })

  it('in-flight 中に dirty → hidden → 先行応答完了でも、復帰まで follow-up を開始しない', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = { surfaces: [] }
    hoisted.responses['workspace.list'] = { workspaces: [] }
    hoisted.gate.open = false
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined)
    })
    act(() => {
      void result.current.requestTopologyRefresh().catch(() => undefined) // dirty を立てる
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const before = hoisted.sent.length
    await act(async () => {
      hoisted.gate.release() // 先行サイクルが完了する
    })
    expect(hoisted.sent.length).toBe(before) // follow-up が始まっていない
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      hoisted.gate.release()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hoisted.sent.length).toBeGreaterThan(before) // 復帰後に走る
  })

  it('失敗しても既存の一覧を捨てない', async () => {
    const { result } = renderHook(() => useCmux())
    hoisted.responses['surface.list'] = {
      surfaces: [{ ref: 'surface:1', type: 'terminal', title: 'a', workspace_ref: 'workspace:1', workspace_id: 'W1' }],
    }
    await act(async () => {
      await result.current.requestTopologyRefresh()
    })
    expect(result.current.surfaces).toHaveLength(1)
    hoisted.errors['surface.list'] = { code: 'internal_error', message: 'boom' }
    await act(async () => {
      await result.current.requestTopologyRefresh().catch(() => undefined)
    })
    expect(result.current.surfaces).toHaveLength(1) // 一時的な通信不良でタブが全部消えない
  })
})
```

**App レベルの受入テストは新しいファイルに置く。** 既存の 2 つのハーネスはどちらも使えない:
`useCmux.test.ts` は `.ts` なので JSX を parse できず `App` も `render` も持たない。
`App.test.tsx` は `useCmux` を全面 mock しているので RPC 本数を数えられない。
**`useCmux` を mock せず実物のまま `App` を mount する専用の結合テスト**を新規作成する。

`apps/client/src/__tests__/app-integration.test.tsx`（新規）:

```tsx
// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'

// useWebSocket だけを mock し、useCmux は実物を使う。送信された RPC を数えるための harness。
const ws = vi.hoisted(() => ({
  sent: [] as string[],
  onMessage: { fn: (_d: string) => {} },
  responses: {} as Record<string, unknown>,
  // method ごとに応答を保留できるゲート（到着順の競合を作るため）。
  held: {} as Record<string, { id: string; method: string }[]>,
  hold: new Set<string>(),
}))

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: ({ onMessage }: { onMessage: (d: string) => void }) => {
    ws.onMessage.fn = onMessage
    return {
      status: 'connected' as const,
      send: (data: string) => {
        ws.sent.push(data)
        const req = JSON.parse(data) as { id: string; method: string }
        if (ws.hold.has(req.method)) {
          ;(ws.held[req.method] ??= []).push(req)
          return true
        }
        ws.onMessage.fn(JSON.stringify({ id: req.id, ok: true, result: ws.responses[req.method] ?? {} }))
        return true
      },
    }
  },
}))

export function sentMethods(): string[] {
  return ws.sent.map((x) => (JSON.parse(x) as { method: string }).method)
}
export function countOf(method: string): number {
  return sentMethods().filter((m) => m === method).length
}
export function releaseHeld(method: string): void {
  ws.hold.delete(method)
  for (const req of ws.held[method] ?? []) {
    ws.onMessage.fn(JSON.stringify({ id: req.id, ok: true, result: ws.responses[method] ?? {} }))
  }
  ws.held[method] = []
}

beforeEach(() => {
  ws.sent.length = 0
  ws.responses = {}
  ws.held = {}
  ws.hold.clear()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('App 結合 — 初期 topology 取得は 1 経路だけ (D2.1 T1)', () => {
  it('マウントして接続したとき surface.list / workspace.list はそれぞれ 1 本だけ', async () => {
    ws.responses['surface.list'] = { surfaces: [] }
    ws.responses['workspace.list'] = { workspaces: [] }
    ws.responses['notification.list'] = { notifications: [] }
    render(<App />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(countOf('surface.list')).toBe(1)
    expect(countOf('workspace.list')).toBe(1)
  })

  it('直接取得の経路が存在しない（workspace_ref 付きの surface.list が飛ばない）', async () => {
    ws.responses['surface.list'] = { surfaces: [] }
    ws.responses['workspace.list'] = { workspaces: [{ ref: 'workspace:1', id: 'W1' }] }
    render(<App />)
    await act(async () => {
      await Promise.resolve()
    })
    const listReqs = ws.sent
      .map((x) => JSON.parse(x) as { method: string; params: Record<string, unknown> })
      .filter((r) => r.method === 'surface.list')
    expect(listReqs.every((r) => r.params.workspace_ref === undefined)).toBe(true)
  })
})
```

**Task 7 / 11 の App 受入テストはすべてこのファイルに置く**（Push の到着順、bootstrap、
`pinned` の配線、5 表示ケースの描画）。Task 7 の Step 2/4 の実行コマンドにもこのファイルを含める。

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts src/__tests__/app-integration.test.tsx`
Expected: FAIL（`requestTopologyRefresh` が存在しない / 初期取得が 2 経路ある）。

- [ ] **Step 3: 実装する**

**取得（fetch）と適用（apply）を分ける。** 取得は `rpc` を直接呼び、適用は「まだ有効か」を
確認してから `setSurfaces` / `setWorkspaces` / `reconcileWith` を行う。`listSurfaces` の中で
適用まで済ませてしまうと、hidden 中に返った応答を捨てられない（D2.1 の E4 に反する）。

```ts
export interface TopologySnapshot {
  generation: number
  surfaces: Surface[]
  workspaces: Workspace[]
}

  // D2.1 の topology 再取得ループ。single-flight を保ったまま「自分の操作の結果がすぐ出る」
  // を満たす。dirty は各取得の開始前に消費し、取得中に再び立ったら完了後にもう 1 回走る
  // （完了後に下ろすと、follow-up の実行中に来た新しい T3 を落とす）。
  const inFlightRef = useRef(false)
  const dirtyRef = useRef(false)
  // 適用に成功した回数。snapshot に載せて返すだけで、waiter の照合には使わない。
  const generationRef = useRef(0)
  // 要求の通し番号。waiter はこれで束ねる。
  // generation（成功時しか進まない）で waiter を照合すると、先行 refresh が失敗した
  // ときに queued waiter の目標世代へ永久に到達せず、Promise が settle しなくなる。
  const requestSeqRef = useRef(0)
  const waitersRef = useRef<
    { seq: number; resolve: (s: TopologySnapshot) => void; reject: (e: Error) => void }[]
  >([])

  // 取得だけを行う。state には触らない。
  // Promise.all は fail-fast なので使わない — 片方が先に reject するともう片方が
  // in-flight のままサイクルが完了扱いになり、follow-up が同じ method を重ねて投げる
  // （E2 の「topology in-flight は 1 件」が実体として崩れる）。
  // allSettled で **両方が settle するまでサイクルを完了させない**。
  const fetchTopology = useCallback(async (): Promise<{ surfaces: Surface[]; workspaces: Workspace[] }> => {
    const [surfaceResult, workspaceResult] = await Promise.allSettled([
      rpc('surface.list') as Promise<{ surfaces?: Surface[] }>,
      rpc('workspace.list') as Promise<{ workspaces?: Workspace[] }>,
    ])
    if (surfaceResult.status === 'rejected') throw surfaceResult.reason
    if (workspaceResult.status === 'rejected') throw workspaceResult.reason
    return {
      surfaces: surfaceResult.value.surfaces ?? [],
      workspaces: workspaceResult.value.workspaces ?? [],
    }
  }, [rpc])

  const runRefresh = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      for (;;) {
        // E4: hidden 中は RPC を出さない。dirty と waiter は据え置き、復帰時に
        // onVisibility が runRefresh を呼び直して回収する（waiter は宙に浮かない）。
        // タイマー停止だけでは T3/T4 と follow-up が hidden 中に RPC を投げてしまう。
        if (document.visibilityState === 'hidden') {
          dirtyRef.current = true // 復帰後に必ず 1 回走らせる
          break
        }
        dirtyRef.current = false // 開始前に消費する
        // このサイクルが「包含する」要求の範囲を、開始時点の seq で固定する。
        // 実行中に来た要求は seq がこれより大きくなるので、次の follow-up が担当する。
        const servedUpTo = requestSeqRef.current
        let snapshot: { surfaces: Surface[]; workspaces: Workspace[] } | null = null
        let failure: Error | null = null
        try {
          snapshot = await fetchTopology()
        } catch (err) {
          failure = err instanceof Error ? err : new Error('topology refresh failed')
        }

        // 成否にかかわらず、このサイクルが担当した waiter は必ず settle する。
        // 「成功したときだけ進む世代」で照合すると、失敗時に queued waiter が
        // 目標へ永久に到達せず Promise が宙に浮く。
        const waiting = waitersRef.current.filter((w) => w.seq <= servedUpTo)
        waitersRef.current = waitersRef.current.filter((w) => w.seq > servedUpTo)

        if (!mountedRef.current) {
          // unmount 後に continuation が走った。state へは一切適用しない。
          for (const w of waiting) w.reject(new Error('unmounted'))
          break
        } else if (snapshot === null) {
          // 失敗しても既存の一覧は捨てない（一時的な通信不良でタブが全部消えるのを防ぐ）。
          // generation も進めない — 適用されていないものを「適用済み」と扱わないため。
          for (const w of waiting) w.reject(failure ?? new Error('topology refresh failed'))
        } else if (document.visibilityState === 'hidden') {
          // E4: hidden 中に返った応答は state へ反映しない。要求元には失敗として返す。
          for (const w of waiting) w.reject(new Error('topology refresh discarded (hidden)'))
        } else {
          generationRef.current += 1
          setSurfaces(snapshot.surfaces)
          setWorkspaces(snapshot.workspaces)
          reconcileWith(snapshot.surfaces)
          const applied: TopologySnapshot = { generation: generationRef.current, ...snapshot }
          for (const w of waiting) w.resolve(applied)
        }
        if (!dirtyRef.current) break
      }
    } finally {
      inFlightRef.current = false
    }
  }, [fetchTopology, reconcileWith])

  // 「自分の要求を包含する refresh が state に適用された後」に、その適用した一覧ごと resolve する。
  // 現在 in-flight の取得は自分の要求より前に始まっているので、その完了で resolve しない
  // （D1.1 step 3 が作成前のスナップショットを見て「ref 不在」と誤判定するため）。
  // number ではなく一覧そのものを返すのは、呼び出し元の async callback が閉じ込めた React の
  // surfaces state が「呼び出し開始時の render の値」のままで、await 後も更新されないためである。
  const requestTopologyRefresh = useCallback((): Promise<TopologySnapshot> => {
    // 自分の seq を採番してから登録する。実行中のサイクルは開始時の seq までしか
    // 担当しないので、この要求は必然的に「次に始まるサイクル」が担当する。
    const seq = ++requestSeqRef.current
    const promise = new Promise<TopologySnapshot>((resolve, reject) => {
      waitersRef.current.push({ seq, resolve, reject })
    })
    dirtyRef.current = true
    // hidden 中は RPC を出さず、dirty と waiter を保持したまま復帰を待つ
    // （runRefresh の入口でも弾くが、ここで呼ばないほうが意図が明確）。
    if (document.visibilityState !== 'hidden') void runRefresh()
    return promise
  }, [runRefresh])

  // アンマウント時に、hidden 中に溜めた waiter を必ず reject する。
  // hidden 中の要求は RPC を開始しないので Task 2 の pending RPC cleanup の対象外であり、
  // これが無いと visible に戻る前に unmount した Promise が永久に未 settle になる。
  // あわせて mountedRef を落とし、すでに settle 済みで continuation が queue に載っている
  // fetchTopology が unmount 後に setSurfaces / reconcileWith へ到達するのを防ぐ。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const waiters = waitersRef.current
      waitersRef.current = []
      for (const w of waiters) w.reject(new Error('unmounted'))
    }
  }, [])

  // T5: 低頻度ポーリング。E1 の自己再帰スケジュール、E4 の hidden 停止。
  // タイマーは常に 1 本。復帰イベントが 3 つ同時に来ても増殖させない。
  useEffect(() => {
    if (status !== 'connected') return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const arm = (delay: number) => {
      if (stopped) return
      if (timer) clearTimeout(timer) // 常に 1 本に保つ
      timer = setTimeout(() => void tick(), delay)
    }
    const tick = async () => {
      if (stopped) return
      // E4: hidden 中はタイマーを張らない。復帰時に onVisibility が張り直す。
      if (document.visibilityState === 'hidden') return
      await requestTopologyRefresh().catch(() => undefined)
      if (document.visibilityState !== 'hidden') arm(TOPOLOGY_POLL_INTERVAL)
    }
    void tick() // T1: 接続・再接続直後
    // T2: 復帰時。arm が既存タイマーを clear するので、3 イベントが重なっても 1 本のまま。
    const onVisibility = () => {
      if (stopped) return
      if (document.visibilityState === 'hidden') {
        if (timer) clearTimeout(timer)
        timer = undefined
        return
      }
      // 復帰時は即時。hidden 中に溜まった dirty と waiter はここで回収される。
      arm(0)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
  }, [status, requestTopologyRefresh])
```

**bootstrap の境界は配列長ではなく「最初の snapshot を適用したか」で持つ（重要）**

`useCmux` は `topologyReady: boolean` を公開する。**最初の refresh が成功して state へ適用された
瞬間に `true`** になり、以後戻らない。`workspaces.length > 0 && surfaces.length > 0` を代用にしては
ならない — **成功した snapshot が空配列であることは正規状態**（cmux に端末が 1 つも無い）であり、
配列長で待つと bootstrap が永久に完了せず、後から端末が増えた時点で初回 `initializeFrom` が
遅れて走って既存の選択と購読集合を作り直してしまう。

**さらに、bootstrap が済むまで T1 の snapshot を `reconcileWith` に流してはならない。**
空の `ViewState` に対する `reconcile` は生存一覧の先頭を前面化するので、App が URL /
`sessionStorage` の優先順で `initializeFrom` する前に別サーフェスが最初のコミットで前面になり、
`sessionStorage` への前面永続化 effect がその暫定値で旧値を上書きし得る。

```ts
  const bootstrappedRef = useRef(false)
  const [topologyReady, setTopologyReady] = useState(false)

  // runRefresh の適用ブロックの中（setSurfaces / setWorkspaces の直後）
  //   generationRef.current += 1
  //   setSurfaces(snapshot.surfaces)
  //   setWorkspaces(snapshot.workspaces)
  //   // bootstrap 前は reconcile しない。初回の前面決定は App の initializeFrom が行う。
  //   if (bootstrappedRef.current) reconcileWith(snapshot.surfaces)
  //   setTopologyReady(true)

  // App が initializeFrom を呼んだ時点で bootstrap 完了とする。
  const initializeFrom = useCallback((surfaces, preferredRef) => {
    bootstrappedRef.current = true
    dispatch({ type: 'initialize', surfaces, preferredRef, now: Date.now() })
  }, [])
```

受入条件: **成功した空 snapshot でも `topologyReady` が `true` になり、`initializeFrom([], null)` が
走って「端末がありません」が描かれること**、および **preferred surface 以外が中間コミットで
前面にならず、`sessionStorage` の旧値も上書きされないこと**。

**初期取得を 1 経路にする（重要）**

現行 `App.tsx:112-133` の初期 effect は `listWorkspaces()` → `listNotifications()` を呼び、
`App.tsx:148-162` の effect が `listSurfaces(currentWorkspace)` を呼ぶ。**これらを残したまま
T1 を足すと、起動時に「App の直接取得」と「T1 の共通 refresh」が並走する。**
直接取得は `inFlightRef` にも hidden 破棄にも generation にも参加しないので、
E2 を破るうえ、**古い直接応答が新しい T1 snapshot の後から `surfaces` を上書きできる**
（D2.1 が消そうとした ghost/missing tab を起動時に再導入する）。

したがって **Task 7 で `App.tsx` の初期取得を次の形に変える。**

- 初期 effect は **`listNotifications()` だけ**にする（通知バッジの取得は topology とは別系統）
- **surface / workspace の初期取得は T1（接続直後の `requestTopologyRefresh`）だけが行う**
- `App.tsx:148-162` の「`currentWorkspace` が変わったら取り直す」effect は**削除する**
  （UR1 で一覧は全ワークスペースになり、`currentWorkspace` は導出値なので取り直す理由が無い）
- 起動時のリトライは T1 の失敗時に T5 が引き継ぐ（`INIT_RETRY_INTERVAL` の独自リトライは不要）

受入条件: **「App をマウントして接続したとき `surface.list` と `workspace.list` はそれぞれ 1 本だけ」**、
および **「古い直接取得が後着して一覧を上書きしない」**（そもそも直接取得が存在しないこと）。

**T3 の配線**: `createWorkspace` / `createSurface` / `closeSurface` / `closeWorkspace` は
`listSurfaces()` を直接呼ばず、`await requestTopologyRefresh()` を **1 回**呼び、**返ってきた
`snapshot.surfaces` から**目的の ref を引く（React state の `surfaces` を読まない）。
直接 RPC を投げたうえでさらに T3 を通知する二重取得はしない。
refresh が reject したら**前面を変えず、エラーにもしない**（次の T5 で追いつく）。

```ts
  const createWorkspace = useCallback(async () => {
    const created = (await rpc('workspace.create')) as { surface_ref?: string }
    // step 2: 共通 refresh を 1 回。両一覧が同じ generation で更新される。
    const snapshot = await requestTopologyRefresh().catch(() => null)
    if (snapshot === null) return
    // step 3: React state ではなく snapshot から引く。
    const surface = snapshot.surfaces.find((s) => s.ref === created.surface_ref)
    if (surface) selectSurface(surface)
  }, [rpc, requestTopologyRefresh, selectSurface])
```

`Task 6` に書いた `createWorkspace` / `createSurface` / `closeWorkspace` の疑似実装は、
この形（`requestTopologyRefresh` の snapshot を使う）へ**置き換える**。Task 6 の時点では
`listSurfaces()` を直接呼ぶ形で構わないが、**Task 7 の最後に必ず差し替え、テストを更新する**。

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useCmux.test.ts src/__tests__/app-integration.test.tsx`
Expected: PASS。

- [ ] **Step 5: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 6: コミット**

```bash
git add apps/client/src/hooks/useCmux.ts apps/client/src/App.tsx apps/client/src/hooks/__tests__/useCmux.test.ts apps/client/src/__tests__/App.test.tsx apps/client/src/__tests__/app-integration.test.tsx
git commit -m "$(cat <<'EOF'
feat(client): topology 再取得ループを入れる (D2.1)

T1 接続/再接続・T2 復帰・T3 自 PWA の全 mutation・T4 stale 検出・
T5 5 秒の低頻度ポーリングで surface 一覧を取り直し、必ず reconcile を通す。
これが無いと、Mac や別 PWA で作られた端末がタブに出ず、外部で閉じられた
非購読端末が ghost タブとして残る。

dirty は各取得の開始前に消費する。完了後に下ろすと follow-up の実行中に来た
新しい T3 を落とすため。queued refresh は最大 1 件で、single-flight を保つ。

requestTopologyRefresh は「自分の要求を包含する refresh が適用された後」に
resolve する。現在 in-flight の完了で resolve すると、createWorkspace が
作成前のスナップショットを見て「ref 不在」と誤判定する。

失敗しても既存の一覧は捨てない（一時的な通信不良でタブが全部消えるのを防ぐ）。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 8: `hooks/useTerminalFeeds.ts` — サーフェスごとの取得ループ

**Files:**
- Create: `apps/client/src/hooks/useTerminalFeeds.ts`
- Test: `apps/client/src/hooks/__tests__/useTerminalFeeds.test.ts`
- Modify: `apps/client/src/lib/view-state.ts`（`SwitcherAction` に feed 系 5 action と reducer 分岐を追加）
- Modify: `apps/client/src/hooks/useCmux.ts`（5 本の dispatch callback を公開）
- Test: `apps/client/src/lib/__tests__/view-state.test.ts`（reducer の遷移結果）
- Test: `apps/client/src/hooks/__tests__/useCmux.test.ts`（callback が dispatch に届くこと）

**Interfaces:**
- Consumes: Task 4（`TerminalFeed` / `pollPlan` / `createSwitcherReducer`）, Task 6（`readGrid` / `readText` / `view` / `feeds`）, Task 7（`requestTopologyRefresh` / `TopologySnapshot`）, Task 5（`saveSurfaceScreen`）
- Produces:
  - `lib/view-state.ts`: `SwitcherAction` に `feedResult` / `feedHistory` / `feedError` / `disconnected` / `repromote` を追加
  - `useCmux()` の戻り値に **5 本の callback** を追加:
    ```ts
    applyFeedResult: (a: { ref: string; epoch: number; grid: RenderGrid | null; now: number }) => void
    applyFeedHistory: (a: { ref: string; epoch: number; history: string }) => void
    applyFeedError:   (a: { ref: string; epoch: number }) => void
    markDisconnected: () => void
    repromote:        () => void
    ```
  - `hooks/useTerminalFeeds.ts`: `useTerminalFeeds(props: UseTerminalFeedsProps): void`（副作用のみ、戻り値なし）
- Task 11 が `App.tsx` で `useCmux()` の戻り値をそのまま `useTerminalFeeds` へ渡す。

`App.tsx:195-275` の単一 effect を置き換える。既存の要件をすべて引き継ぐ:
- in-flight レスポンスが切替後の状態を上書きしないためのキャンセル（`fe53249` の回帰）→ **epoch の世代照合**（F7）で置き換える
- stale surface エラーの 1 回だけ resync（サーフェスごとに持つ）
- ピン留め中のみ scrollback 取得（前面のみ）
- `visibilitychange` / `pageshow` / `focus` での即時再取得（E4）

**実行規律**

| # | 規律 |
|---|---|
| E1 | `setInterval` を使わない。1 回の取得が完了してから `setTimeout` で次回を予約する。間隔は「完了から次の開始まで」で、鮮度目標は `interval + 取得時間` |
| E2 | サーフェスごとの in-flight は常に 1 件まで |
| E3 | 背面の初回発火を `index * BACKGROUND_STAGGER` だけずらす |
| E4 | `hidden` の間はタイマーを張らず、遅れて返った応答も反映しない。復帰時は前面のみ即時再取得 |
| E5 | 前面のサイクルは `replay` →（ピン留め中のみ）`read_text` の順で、両方合わせて 1 サイクル |

**状態遷移**

| # | 遷移 | 結果 |
|---|---|---|
| F5 | 取得成功で `render_grid` あり（`captured.epoch === feed.epoch`） | `live` / `memory`、`updatedAt = now` |
| F5n | 取得成功で `render_grid` が `null`（停止端末） | `live` / `none`、`updatedAt = now`。**`grid` と `history` の両方を捨てる** |
| F6 | 取得失敗 | `error`。`source` と描画中フレームは保持 |
| F7 | `captured.epoch !== feed.epoch` の応答 | **破棄する** |
| F8 | WS 切断 | 全 feed を `error` に。フレームは保持 |
| F9 | 再接続成功 | 購読中の全 feed を昇格からやり直す（`epoch++`） |

- [ ] **Step 1: 失敗するテストを書く**

`apps/client/src/hooks/__tests__/useTerminalFeeds.test.ts` を新規作成する。

```tsx
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RenderGrid } from '../../lib/render-grid'
import { BACKGROUND_POLL_INTERVAL, BACKGROUND_STAGGER, FOREGROUND_POLL_INTERVAL } from '../../lib/view-state'
import type { SurfaceLike, TerminalFeed, ViewState } from '../../lib/view-state'
import { useTerminalFeeds } from '../useTerminalFeeds'

const gridOf = (text: string): RenderGrid => ({
  columns: 80,
  rows: 1,
  styles: [],
  row_spans: [{ row: 0, column: 0, style_id: 0, cell_width: text.length, text }],
  active_screen: 'primary',
  modes: [],
})

const feedOf = (over: Partial<TerminalFeed> = {}): TerminalFeed => ({
  grid: null,
  history: '',
  updatedAt: null,
  activity: false,
  contentHash: '',
  status: 'loading',
  source: 'none',
  epoch: 1,
  promotedAt: 0,
  ...over,
})

const surfaceOf = (ref: string, type = 'terminal', index = 0): SurfaceLike => ({
  ref,
  type,
  workspace_ref: 'workspace:1',
  index,
})

interface Harness {
  props: Parameters<typeof useTerminalFeeds>[0]
  readGrid: ReturnType<typeof vi.fn>
  readText: ReturnType<typeof vi.fn>
  applyFeedResult: ReturnType<typeof vi.fn>
  applyFeedHistory: ReturnType<typeof vi.fn>
  applyFeedError: ReturnType<typeof vi.fn>
  requestTopologyRefresh: ReturnType<typeof vi.fn>
  markDisconnected: ReturnType<typeof vi.fn>
  repromote: ReturnType<typeof vi.fn>
}

// 購読集合・feeds・visibleRefs を指定して props を組む。
function harness(opts: {
  subscribed: string[]
  visible: string[]
  feeds?: Record<string, TerminalFeed>
  surfaces?: SurfaceLike[]
  pinned?: boolean
  readGrid?: ReturnType<typeof vi.fn>
}): Harness {
  const view: ViewState = {
    subscriptions: opts.subscribed.map((ref, i) => ({ ref, lastForegroundAt: 1000 + i, treeIndex: i })),
    foreground: opts.visible[0] ?? null,
    foregroundWorkspaceRef: 'workspace:1',
  }
  const readGrid = opts.readGrid ?? vi.fn().mockResolvedValue(gridOf('hello'))
  const readText = vi.fn().mockResolvedValue('history text')
  const applyFeedResult = vi.fn()
  const applyFeedHistory = vi.fn()
  const applyFeedError = vi.fn()
  const requestTopologyRefresh = vi.fn().mockResolvedValue({ generation: 1, surfaces: [], workspaces: [] })
  const markDisconnected = vi.fn()
  const repromote = vi.fn()
  const feeds = new Map<string, TerminalFeed>(
    Object.entries(opts.feeds ?? Object.fromEntries(opts.subscribed.map((r) => [r, feedOf()]))),
  )
  return {
    readGrid,
    readText,
    applyFeedResult,
    applyFeedHistory,
    applyFeedError,
    requestTopologyRefresh,
    markDisconnected,
    repromote,
    props: {
      status: 'connected',
      view,
      surfaces: opts.surfaces ?? opts.subscribed.map((r, i) => surfaceOf(r, 'terminal', i)),
      feeds,
      visibleRefs: opts.visible,
      pinned: opts.pinned ?? true,
      historyLines: 2000,
      readGrid,
      readText,
      applyFeedResult,
      applyFeedHistory,
      applyFeedError,
      requestTopologyRefresh,
      markDisconnected,
      repromote,
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTerminalFeeds — 実行規律', () => {
  it('サーフェスごとに正しい ref で readGrid が飛ぶ', async () => {
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_STAGGER * 2)
    })
    expect(h.readGrid.mock.calls.map((c) => c[0]).sort()).toEqual(['surface:1', 'surface:2'])
  })

  it('背面では scrollback を取らない（前面かつピン留め中のみ）', async () => {
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_STAGGER * 2)
    })
    expect(h.readText.mock.calls.map((c) => c[0])).toEqual(['surface:1'])
  })

  it('ピン留めを外している間は scrollback を取らない', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL)
    })
    expect(h.readText).not.toHaveBeenCalled()
  })

  it('非購読と browser には一度も投げない', async () => {
    const h = harness({
      subscribed: ['surface:1'],
      visible: ['surface:1'],
      surfaces: [surfaceOf('surface:1'), surfaceOf('surface:3'), surfaceOf('surface:9', 'browser')],
    })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 3)
    })
    const refs = h.readGrid.mock.calls.map((c) => c[0])
    expect(refs).not.toContain('surface:3')
    expect(refs).not.toContain('surface:9')
  })

  it('E4: hidden のまま mount してもタイマーを 1 本も張らない', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    expect(vi.getTimerCount()).toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('E4: hidden 中に planKey が変わって effect が作り直されてもタイマーを張らない', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // 購読集合を変えて effect を作り直す
    const view2 = { ...h.props.view, subscriptions: [{ ref: 'surface:2', lastForegroundAt: 1, treeIndex: 1 }] }
    rerender({ ...h.props, view: view2, visibleRefs: ['surface:2'] })
    expect(vi.getTimerCount()).toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('E4: hidden になったら全タイマーを clear し、復帰で前面即時・背面 interval+stagger で再開する', async () => {
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'], pinned: false })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_STAGGER * 2)
    })
    h.readGrid.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // タイマーが「張られていない」ことを本数で確認する（RPC が 0 件なだけでは足りない）
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL * 4)
    })
    expect(h.readGrid).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.readGrid.mock.calls.map((c) => c[0])).toEqual(['surface:1']) // 前面は即時
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL + BACKGROUND_STAGGER * 2)
    })
    expect(h.readGrid.mock.calls.map((c) => c[0])).toContain('surface:2') // 背面も再開する
  })

  it('E4: readGrid の待機中に hidden になった応答は反映しない', async () => {
    let resolveGrid: ((g: RenderGrid | null) => void) | undefined
    const readGrid = vi
      .fn()
      .mockImplementationOnce(() => new Promise<RenderGrid | null>((r) => { resolveGrid = r }))
      .mockResolvedValue(gridOf('x'))
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false, readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      resolveGrid?.(gridOf('discarded'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.applyFeedResult).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.applyFeedResult).toHaveBeenCalled() // 復帰で再開する
  })

  it('readGrid の待機中に前面が切り替わったら、旧 ref の read_text と localStorage 保存を行わない', async () => {
    let resolveGrid: ((g: RenderGrid | null) => void) | undefined
    const readGrid = vi
      .fn()
      .mockImplementationOnce(() => new Promise<RenderGrid | null>((r) => { resolveGrid = r }))
      .mockResolvedValue(gridOf('x'))
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'], pinned: true, readGrid })
    const { rerender } = renderHook((props: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(props), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    setItem.mockClear()
    h.readText.mockClear()
    // surface:1 の replay 待機中に surface:2 へ切り替える
    rerender({ ...h.props, visibleRefs: ['surface:2'] })
    await act(async () => {
      resolveGrid?.(gridOf('a'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // surface:1 はもう背面。scrollback も localStorage 保存もしない。
    expect(h.readText.mock.calls.filter((c) => c[0] === 'surface:1')).toHaveLength(0)
    expect(setItem.mock.calls.filter((c) => (c[0] as string).includes('surface:1'))).toHaveLength(0)
    // grid 自体は epoch が一致するので適用してよい
    expect(h.applyFeedResult).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:1' }))
  })

  it('取得待機中に hidden になってから返った rejection は feed も T4 も更新しない', async () => {
    let rejectGrid: ((e: Error) => void) | undefined
    const readGrid = vi
      .fn()
      .mockImplementationOnce(() => new Promise<RenderGrid | null>((_, rej) => { rejectGrid = rej }))
      .mockResolvedValue(gridOf('x'))
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false, readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      rejectGrid?.(Object.assign(new Error('Missing or invalid terminal_id'), { code: 'invalid_params' }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.applyFeedError).not.toHaveBeenCalled()
    expect(h.requestTopologyRefresh).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('E4: read_text の待機中に hidden になったら history も localStorage も更新しない', async () => {
    let resolveText: ((t: string) => void) | undefined
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: true })
    h.readText.mockImplementationOnce(() => new Promise<string>((r) => { resolveText = r }))
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    setItem.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      resolveText?.('late history')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(h.applyFeedHistory).not.toHaveBeenCalled()
    expect(setItem.mock.calls.filter((c) => (c[0] as string).startsWith('cmux-surface-cache:'))).toHaveLength(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('ref ごとのタイマーは常に 1 本（復帰イベントが重なっても増殖しない）', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    h.readGrid.mockClear()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pageshow'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // 3 イベントが重なっても、即時再取得は 1 回だけ
    expect(h.readGrid).toHaveBeenCalledTimes(1)
  })

  it('hidden 中は RPC が 0 件（E4）', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 5)
    })
    expect(h.readGrid).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('同一サーフェスの in-flight が 1 件を超えない（E2）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const readGrid = vi.fn().mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, FOREGROUND_POLL_INTERVAL * 3)) // interval より長い
      inFlight--
      return gridOf('x')
    })
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 10)
    })
    expect(maxInFlight).toBe(1)
  })

  it('E1: 次回は「完了時刻」から interval だけ待つ（開始時刻起点で取り戻さない）', async () => {
    const at: number[] = []
    const readGrid = vi.fn().mockImplementation(async () => {
      at.push(Date.now())
      await new Promise((r) => setTimeout(r, 500)) // 取得に 500ms かかる
      return gridOf('x')
    })
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], pinned: false, readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 3 + 2000)
    })
    // 開始間隔は 500(取得) + 1000(interval) = 1500ms になる（1000ms ではない）
    expect((at[1] as number) - (at[0] as number)).toBe(1500)
  })

  it('E3: 背面の初回発火が index * BACKGROUND_STAGGER ずれる', async () => {
    const at = new Map<string, number>()
    const readGrid = vi.fn().mockImplementation(async (ref: string) => {
      if (!at.has(ref)) at.set(ref, Date.now())
      return gridOf('x')
    })
    const h = harness({
      subscribed: ['surface:0', 'surface:1', 'surface:2'],
      visible: ['surface:0'],
      pinned: false,
      readGrid,
    })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_STAGGER * 4)
    })
    const base = at.get('surface:1') as number
    expect((at.get('surface:2') as number) - base).toBe(BACKGROUND_STAGGER)
  })

  it('前面は 1Hz、背面は 3s の間隔で回る', async () => {
    const counts = new Map<string, number>()
    const readGrid = vi.fn().mockImplementation(async (ref: string) => {
      counts.set(ref, (counts.get(ref) ?? 0) + 1)
      return gridOf('x')
    })
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'], pinned: false, readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL * 2)
    })
    // 6 秒で前面は約 6 回、背面は約 2 回
    expect(counts.get('surface:1') as number).toBeGreaterThan(counts.get('surface:2') as number)
    expect(counts.get('surface:2') as number).toBeLessThanOrEqual(3)
  })
})

describe('useTerminalFeeds — 状態遷移', () => {
  it('F5: 成功で live/memory になり updatedAt が入る', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.applyFeedResult).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'surface:1', epoch: 1, grid: expect.objectContaining({ rows: 1 }) }),
    )
  })

  it('F5n: render_grid が null なら grid: null を渡す（呼び出し側が live/none にする）', async () => {
    const readGrid = vi.fn().mockResolvedValue(null)
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.applyFeedResult).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:1', grid: null }))
    // 停止端末では read_text 自体が失敗するので scrollback は取りに行かない
    expect(h.readText).not.toHaveBeenCalled()
  })

  it('F6: 失敗で applyFeedError が呼ばれる', async () => {
    const readGrid = vi.fn().mockRejectedValue(new Error('timeout'))
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(h.applyFeedError).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:1', epoch: 1 }))
  })

  it('F7: 応答には「開始時点」の epoch を付けて渡す（破棄の判定は reducer が行う）', async () => {
    let resolveFirst: ((g: RenderGrid | null) => void) | undefined
    const readGrid = vi
      .fn()
      .mockImplementationOnce(() => new Promise<RenderGrid | null>((r) => { resolveFirst = r }))
      .mockResolvedValue(gridOf('x'))
    // epoch 1 で購読中
    const h = harness({
      subscribed: ['surface:1'],
      visible: ['surface:1'],
      feeds: { 'surface:1': feedOf({ epoch: 1, promotedAt: 1000 }) },
      readGrid,
    })
    const { rerender } = renderHook((p: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(p), {
      initialProps: h.props,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    // 追い出し → 再昇格で epoch が 2 になる（promotedAt も進む）
    const promoted = new Map(h.props.feeds).set('surface:1', feedOf({ epoch: 2, promotedAt: 5000 }))
    rerender({ ...h.props, feeds: promoted })
    // 昇格「前」に開始した RPC が、昇格「後」に解決する。時刻だけ見れば promotedAt より後。
    await act(async () => {
      resolveFirst?.(gridOf('stale'))
      await vi.advanceTimersByTimeAsync(0)
    })
    // hook は「捕まえた epoch」を付けて渡す。1 であって 2 ではない。
    const staleCall = h.applyFeedResult.mock.calls.find(
      (c) => (c[0] as { grid: RenderGrid | null }).grid?.row_spans?.[0]?.text === 'stale',
    )
    expect((staleCall?.[0] as { epoch: number }).epoch).toBe(1)
  })
})

describe('useTerminalFeeds — 接続状態 (F8/F9)', () => {
  it('F8: 切断で markDisconnected が 1 回だけ呼ばれる', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    const { rerender } = renderHook((p: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(p), {
      initialProps: h.props,
    })
    rerender({ ...h.props, status: 'disconnected' })
    rerender({ ...h.props, status: 'disconnected' }) // 同じ status での再 render では呼ばない
    expect(h.markDisconnected).toHaveBeenCalledTimes(1)
    expect(h.repromote).not.toHaveBeenCalled()
  })

  it('F9: 切断 → 再接続で repromote が 1 回だけ呼ばれる', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    const { rerender } = renderHook((p: Parameters<typeof useTerminalFeeds>[0]) => useTerminalFeeds(p), {
      initialProps: { ...h.props, status: 'disconnected' },
    })
    rerender({ ...h.props, status: 'connected' })
    expect(h.repromote).toHaveBeenCalledTimes(1)
  })

  it('切断中はポーリングを止める', async () => {
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'] })
    renderHook(() => useTerminalFeeds({ ...h.props, status: 'disconnected' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 5)
    })
    expect(h.readGrid).not.toHaveBeenCalled()
  })
})

describe('useTerminalFeeds — stale 検出と永続化', () => {
  it('T4: stale surface エラーはサーフェスごとに 1 回だけ requestTopologyRefresh する', async () => {
    const staleErr = Object.assign(new Error('Missing or invalid terminal_id'), { code: 'invalid_params' })
    const readGrid = vi.fn().mockRejectedValue(staleErr)
    const h = harness({ subscribed: ['surface:1'], visible: ['surface:1'], readGrid })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_INTERVAL * 5)
    })
    expect(h.requestTopologyRefresh).toHaveBeenCalledTimes(1)
  })

  it('C1/C6: localStorage への保存は前面かつ内容変化時のみ。背面は書かない', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem')
    const h = harness({ subscribed: ['surface:1', 'surface:2'], visible: ['surface:1'], pinned: false })
    renderHook(() => useTerminalFeeds(h.props))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL * 2)
    })
    const written = spy.mock.calls.map((c) => c[0] as string).filter((k) => k.startsWith('cmux-surface-cache:'))
    expect(written.every((k) => k === 'cmux-surface-cache:surface:1')).toBe(true)
    // 内容が変化していないので、6 秒間で書き込みは 1 回だけ
    expect(written).toHaveLength(1)
  })
})
```

**あわせて `lib/__tests__/view-state.test.ts` に reducer 側の遷移結果を書く。**
上の hook テストは「action を渡したこと」しか見ないので、`status` / `source` が
実際にどう動くかは reducer で固定する。

```ts
describe('createSwitcherReducer — feed の遷移 (F5〜F9)', () => {
  const reduce = createSwitcherReducer(noCache)
  const surfaces = [term('surface:1'), term('surface:2')]
  const started = () => reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })

  it('F5: warming -> live/memory', () => {
    const s = reduce(started(), { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('a'), now: 2000 })
    expect(s.feeds.get('surface:1')).toMatchObject({ status: 'live', source: 'memory', updatedAt: 2000 })
  })

  it('F5n: 成功だが grid が null なら live/none になり grid と history の両方が捨てられる', () => {
    let s = reduce(started(), { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('a'), now: 2000 })
    s = reduce(s, { type: 'feedHistory', ref: 'surface:1', epoch: 1, history: 'old scrollback' })
    s = reduce(s, { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: null, now: 3000 })
    expect(s.feeds.get('surface:1')).toMatchObject({ status: 'live', source: 'none', grid: null, history: '' })
  })

  it('F6: warming -> error / loading -> error。source と描画中フレームは保持', () => {
    let s = reduce(started(), { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('a'), now: 2000 })
    s = reduce(s, { type: 'feedError', ref: 'surface:1', epoch: 1 })
    expect(s.feeds.get('surface:1')).toMatchObject({ status: 'error', source: 'memory' })
    expect(s.feeds.get('surface:1')?.grid).not.toBeNull()
    const fresh = reduce(started(), { type: 'feedError', ref: 'surface:1', epoch: 1 })
    expect(fresh.feeds.get('surface:1')).toMatchObject({ status: 'error', source: 'none' })
  })

  it('F7: epoch が一致しない action は state を変えない（同一参照を返す）', () => {
    const s0 = started()
    const s1 = reduce(s0, { type: 'feedResult', ref: 'surface:1', epoch: 99, grid: grid('a'), now: 2000 })
    expect(s1).toBe(s0)
  })

  it('F8: 切断で全 feed が error になりフレームは残る', () => {
    let s = reduce(started(), { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('a'), now: 2000 })
    s = reduce(s, { type: 'disconnected' })
    expect(s.feeds.get('surface:1')).toMatchObject({ status: 'error', source: 'memory' })
    expect(s.feeds.get('surface:1')?.grid).not.toBeNull()
  })

  it('F9: 再接続で購読中の全 feed が昇格からやり直される（epoch++、added は空でも走る）', () => {
    let s = reduce(started(), { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('a'), now: 2000 })
    s = reduce(s, { type: 'disconnected' })
    const before = s.feeds.get('surface:1') as TerminalFeed
    s = reduce(s, { type: 'repromote', now: 5000 })
    const after = s.feeds.get('surface:1') as TerminalFeed
    expect(after.epoch).toBe(before.epoch + 1)
    expect(after.status).toBe('warming')
    expect(after.source).toBe('memory') // F1（メモリのフレームを持っている）
    expect(after.promotedAt).toBe(5000)
  })

  it('F5n -> F8 -> F9 は F3 に入る（cache を復活させない）', () => {
    const withCacheReduce = createSwitcherReducer(withCache({ 'surface:1': { grid: grid('x'), updatedAt: 500 } }))
    let s = withCacheReduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    s = withCacheReduce(s, { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: null, now: 2000 }) // F5n
    s = withCacheReduce(s, { type: 'disconnected' })
    s = withCacheReduce(s, { type: 'repromote', now: 3000 })
    expect(s.feeds.get('surface:1')).toMatchObject({ status: 'loading', source: 'none', grid: null })
  })

  it('activity は「適用時点の foreground」で決まる（開始時点ではない）', () => {
    // surface:1 を前面にして 1 回取得 → surface:2 へ切替 → surface:1 の内容が変化
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    s = reduce(s, { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('a'), now: 2000 })
    expect(s.feeds.get('surface:1')?.activity).toBe(false)
    s = reduce(s, { type: 'select', surface: surfaces[1] as SurfaceLike, now: 3000, cap: MAX_LIVE_SUBSCRIPTIONS })
    // surface:1 は既購読なので epoch は 1 のまま（F4）
    expect(s.feeds.get('surface:1')?.epoch).toBe(1)
    s = reduce(s, { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('b'), now: 4000 })
    expect(s.feeds.get('surface:1')?.activity).toBe(true) // 背面で変化した
    // 前面へ戻すと activity は消える
    s = reduce(s, { type: 'select', surface: surfaces[0] as SurfaceLike, now: 5000, cap: MAX_LIVE_SUBSCRIPTIONS })
    s = reduce(s, { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('c'), now: 6000 })
    expect(s.feeds.get('surface:1')?.activity).toBe(false)
  })

  it('カーソルだけが動いた grid は activity と見なさない (R4)', () => {
    const withCursor = (text: string, column: number): RenderGrid => ({
      ...grid(text),
      cursor: { row: 0, column, visible: true },
    })
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    s = reduce(s, { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: withCursor('a', 0), now: 2000 })
    s = reduce(s, { type: 'select', surface: surfaces[1] as SurfaceLike, now: 3000, cap: MAX_LIVE_SUBSCRIPTIONS })
    s = reduce(s, { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: withCursor('a', 5), now: 4000 })
    expect(s.feeds.get('surface:1')?.activity).toBe(false)
  })

  it('F10: 追い出しでは status と source を据え置く', () => {
    let s = reduce(emptyState(), { type: 'initialize', surfaces, preferredRef: 'surface:1', now: 1000 })
    s = reduce(s, { type: 'feedResult', ref: 'surface:1', epoch: 1, grid: grid('a'), now: 2000 })
    s = reduce(s, { type: 'select', surface: surfaces[1] as SurfaceLike, now: 3000, cap: 1 })
    expect(s.view.subscriptions.map((x) => x.ref)).toEqual(['surface:2'])
    expect(s.feeds.get('surface:1')).toMatchObject({ status: 'live', source: 'memory' })
  })
})
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useTerminalFeeds.test.ts src/lib/__tests__/view-state.test.ts`
Expected: FAIL（`useTerminalFeeds` と feed 系 action が存在しない）。

- [ ] **Step 3: `useCmux` に feed 適用の action を足す**

`SwitcherAction` に **5 つの action を追加する**（Task 4 の reducer も対応させる）。
**すべて `epoch` を受け、`feed.epoch` と一致しなければ何もしない**（F7）。
これが「破棄」の唯一の場所である — hook 側は判定せず、常に「開始時点で捕まえた epoch」を
付けて渡すだけにする（責務を 2 箇所に分けると必ずずれる）。

```ts
  | { type: 'feedResult'; ref: string; epoch: number; grid: RenderGrid | null; now: number }
  | { type: 'feedHistory'; ref: string; epoch: number; history: string }
  | { type: 'feedError'; ref: string; epoch: number }
  | { type: 'disconnected' }            // F8
  | { type: 'repromote'; now: number }  // F9
```

**`useCmux` 側の配線**（Task 6 で入れた `dispatch` をそのまま使う。すべて `useCallback`）:

```ts
  const applyFeedResult = useCallback(
    (a: { ref: string; epoch: number; grid: RenderGrid | null; now: number }) =>
      dispatch({ type: 'feedResult', ...a }),
    [],
  )
  const applyFeedHistory = useCallback(
    (a: { ref: string; epoch: number; history: string }) => dispatch({ type: 'feedHistory', ...a }),
    [],
  )
  const applyFeedError = useCallback(
    (a: { ref: string; epoch: number }) => dispatch({ type: 'feedError', ...a }),
    [],
  )
  const markDisconnected = useCallback(() => dispatch({ type: 'disconnected' }), [])
  const repromote = useCallback(() => dispatch({ type: 'repromote', now: Date.now() }), [])
```

**reducer の分岐**（`createSwitcherReducer` の中。`added` の計算より**前**に早期 return する）:

```ts
    // F5 / F5n / F7 / activity
    if (action.type === 'feedResult') {
      const feed = state.feeds.get(action.ref)
      // F7: 昇格前に開始した RPC の遅延応答を破棄する。時刻比較では除外できない
      //（追い出し前に始めた RPC が再昇格の後に返ると promotedAt より後になるため）。
      if (!feed || feed.epoch !== action.epoch) return state

      // activity は「前面を離れてから内容が変化した」。判定は開始時点ではなく
      // 適用時点の foreground で行う（既購読端末どうしの切替では epoch が変わらないので、
      // 開始時点の isVisible を渡すと切替後に返った旧前面の取得を「今も前面」と誤判定する）。
      const isForeground = state.view.foreground === action.ref
      // row_spans だけをハッシュする。cursor は別フィールドなので、これで
      // 「カーソル点滅だけでは変化と見なさない」が満たされる（R4）。
      const contentHash = action.grid === null ? '' : JSON.stringify(action.grid.row_spans)
      const changed = contentHash !== '' && feed.contentHash !== '' && contentHash !== feed.contentHash
      const activity = isForeground ? false : feed.activity || changed

      const next: TerminalFeed =
        action.grid === null
          // F5n: 停止端末。古い画面を出したまま「ライブ」と称しない。grid と history の
          // 両方を捨てる（history だけ残すと古い scrollback が再表示される）。
          ? { ...feed, grid: null, history: '', contentHash: '', status: 'live', source: 'none', updatedAt: action.now, activity }
          // F5
          : { ...feed, grid: action.grid, contentHash, status: 'live', source: 'memory', updatedAt: action.now, activity }
      return { view: state.view, feeds: new Map(state.feeds).set(action.ref, next) }
    }

    if (action.type === 'feedHistory') {
      const feed = state.feeds.get(action.ref)
      if (!feed || feed.epoch !== action.epoch) return state
      return { view: state.view, feeds: new Map(state.feeds).set(action.ref, { ...feed, history: action.history }) }
    }

    // F6: 失敗。source と描画中フレームは保持する。
    if (action.type === 'feedError') {
      const feed = state.feeds.get(action.ref)
      if (!feed || feed.epoch !== action.epoch) return state
      return { view: state.view, feeds: new Map(state.feeds).set(action.ref, { ...feed, status: 'error' }) }
    }

    // F8: WS 切断。全 feed を error にする。フレームも source も保持する。
    if (action.type === 'disconnected') {
      const feeds = new Map<string, TerminalFeed>()
      for (const [ref, feed] of state.feeds) feeds.set(ref, { ...feed, status: 'error' })
      return { view: state.view, feeds }
    }

    // F9: 再接続。購読中の全 feed を F1〜F3 の規則で昇格からやり直す（epoch++）。
    // これは added 規則の明示的な例外である（added は空でも全購読を昇格させる）。
    if (action.type === 'repromote') {
      const feeds = new Map(state.feeds)
      for (const sub of state.view.subscriptions) {
        feeds.set(sub.ref, promote(state.feeds, sub.ref, action.now, readCache))
      }
      return { view: state.view, feeds }
    }
```

> **F9 と `added` 規則の関係**: `repromote` は `subscriptions` を一切変えないので `added` は空だが、
> **購読中の全 feed を昇格させる**。`added` 規則は `select` / `initialize` / `reconcile` の 3 つに
> だけ適用され、`repromote` はそれとは別の明示的な経路である。これを混ぜないよう、
> reducer の中で `added` の計算より前に `feedResult` 系と `disconnected` / `repromote` を
> 早期 return させる。

- [ ] **Step 4: `useTerminalFeeds` を実装する**

サーフェスごとに 1 本の自己再帰タイマーを持つ。`pollPlan` の結果が変わったらタイマーを張り直す。
**`feeds` は毎ポーリング変わるので effect の依存に入れてはならない**（入れると 1 秒ごとに全タイマーが
張り直され、E1 の自己再帰スケジュールが壊れる）。`epoch` の読み取りには ref 経由の最新値を使う。

```ts
import { useEffect, useMemo, useRef } from 'react'

import type { RenderGrid } from '../lib/render-grid'
import { isStaleSurfaceError } from '../lib/rpc-error'
import { visibleLineCount, stripVisibleScreen } from '../lib/scrollback'
import { saveSurfaceScreen } from '../lib/surface-cache'
import { BACKGROUND_STAGGER, pollPlan } from '../lib/view-state'
import type { SurfaceLike, TerminalFeed, ViewState } from '../lib/view-state'
import type { TopologySnapshot } from './useCmux'
import type { ConnectionStatus } from './useWebSocket'

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

  useEffect(() => {
    if (status !== 'connected') return
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    let stopped = false

    // タイマーは ref ごとに常に 1 本。張る前に既存を必ず clear する。
    const arm = (ref: string, intervalMs: number, delay: number) => {
      if (stopped) return
      const existing = timers.get(ref)
      if (existing) clearTimeout(existing)
      timers.set(ref, setTimeout(() => void cycle(ref, intervalMs), delay))
    }

    const cycle = async (ref: string, intervalMs: number) => {
      if (stopped) return
      // E4: hidden 中はタイマーを張らない。ここで予約しないでよいのは、
      // 復帰ハンドラ（下の resume）が **全 plan entry** を張り直すからである
      // （前面は 0ms、背面は interval + stagger）。
      if (document.visibilityState === 'hidden') return
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
        // E4: 取得中に hidden になったら応答を state へ反映しない。
        // ただし finally でタイマーは張り直すので、ここで return しても止まらない。
        if (stopped || document.visibilityState === 'hidden') return
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
          if (stopped || !after.pinned || !after.visibleRefs.includes(ref)) return
          if (document.visibilityState === 'hidden') return
          after.applyFeedHistory({ ref, epoch, history: stripVisibleScreen(text, visibleLineCount(grid)) })
          if (text !== lastScrollbackRef.current.get(ref)) {
            lastScrollbackRef.current.set(ref, text)
            saveSurfaceScreen(ref, { scrollback: text, updatedAt: now })
          }
        }
      } catch (err) {
        // 待機中に hidden になってから返った rejection も反映しない
        // （hidden 中に applyFeedError と T4 の topology refresh が走ってしまう）。
        if (stopped || document.visibilityState === 'hidden') return
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
        if (document.visibilityState !== 'hidden') arm(ref, intervalMs, intervalMs)
      }
    }

    // E3: 背面の初回発火を index * BACKGROUND_STAGGER だけずらす（burst の平準化）。
    // hidden のまま mount した場合や、hidden 中に status / planKey が変わって effect が
    // 作り直された場合は **1 本も張らない**（E4 の「hidden 中はタイマーを張らない」）。
    // 復帰は下の onVisibility が担当する。
    if (document.visibilityState !== 'hidden') {
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
      if (document.visibilityState === 'hidden') {
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: planKey が plan の同一性を代表する
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
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/hooks/__tests__/useTerminalFeeds.test.ts src/lib/__tests__/view-state.test.ts src/hooks/__tests__/useCmux.test.ts`
Expected: PASS。

**`useCmux` 側の結合テスト**（`hooks/__tests__/useCmux.test.ts` に追記。
Task 6 の「D3.1 selectSurface の原子性」describe と同じ `trackingHook` / `renderCounts` を使う。
`applyFeedResult` はこの Task で公開されるので、ここで初めて書ける）:

```ts
describe('retained memory の再昇格（Task 8 で applyFeedResult が公開されてから書ける）', () => {
  it('retained memory: 追い出し後の再昇格で、最初のコミットが warming/memory になる', () => {
    const { result } = renderHook(() => trackingHook())
    // 公開 selectSurface は cap = MAX_LIVE_SUBSCRIPTIONS 固定なので、確実に追い出すには
    // 上限 + 1 件を順に選ぶ必要がある（2 件では追い出されず F4 のままになる）。
    const surfaces = Array.from({ length: MAX_LIVE_SUBSCRIPTIONS + 1 }, (_, i) => ({
      ref: `surface:${i}`,
      type: 'terminal',
      workspace_ref: 'workspace:1',
      index: i,
    }))
    act(() => {
      result.current.initializeFrom(surfaces, 'surface:0')
    })
    act(() => {
      result.current.applyFeedResult({ ref: 'surface:0', epoch: 1, grid: { columns: 80, rows: 1, styles: [], row_spans: [] }, now: 2000 })
    })
    expect(result.current.feeds.get('surface:0')).toMatchObject({ status: 'live', source: 'memory' })
    // surface:1 〜 surface:8 を順に選ぶと、最古の surface:0 が購読集合から外れる
    for (let i = 1; i <= MAX_LIVE_SUBSCRIPTIONS; i++) {
      act(() => {
        result.current.selectSurface(surfaces[i] as Surface)
      })
    }
    expect(result.current.view.subscriptions.map((x) => x.ref)).not.toContain('surface:0')
    // feed は D3.2 で保持され、status/source は F10 で据え置き
    expect(result.current.feeds.get('surface:0')).toMatchObject({ status: 'live', source: 'memory' })
    const epochBefore = result.current.feeds.get('surface:0')?.epoch as number

    renderCounts.length = 0
    act(() => {
      result.current.selectSurface(surfaces[0] as Surface)
    })
    const first = renderCounts.find((r) => r.view === 'surface:0')
    // 再昇格なので F1: 最初のコミットで warming/memory になっていること（live のままは不可）
    expect(first?.feedStatus).toBe('warming')
    expect(result.current.feeds.get('surface:0')?.source).toBe('memory')
    expect(result.current.feeds.get('surface:0')?.epoch).toBe(epochBefore + 1)
  })
})
```

- [ ] **Step 6: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。`useTerminalFeeds` はこの時点ではまだどこからも呼ばれない
（`App.tsx` からの配線は Task 11）。shim の旧ポーリングと二重に走ることはない。

- [ ] **Step 7: コミット**

```bash
git add apps/client/src/hooks/useTerminalFeeds.ts apps/client/src/hooks/__tests__/useTerminalFeeds.test.ts apps/client/src/lib/view-state.ts apps/client/src/lib/__tests__/view-state.test.ts apps/client/src/hooks/useCmux.ts apps/client/src/hooks/__tests__/useCmux.test.ts
git commit -m "$(cat <<'EOF'
feat(client): サーフェスごとの取得ループを useTerminalFeeds に切り出す (D4/D3.1)

App.tsx の単一 effect を置き換える。pollPlan に従って前面は最大 1Hz、背面は
最大 1/3Hz で回し、E1〜E5 の規律（自己再帰スケジュール / サーフェスごと 1 in-flight /
背面 400ms stagger / hidden 停止 / 前面は replay + read_text で 1 サイクル）を守る。

切替時の上書き防止は cancelled フラグではなく epoch の世代照合で行う（F7）。
追い出し前に開始した RPC が再昇格の後に返ると、時刻比較では除外できないため。

F5n: 成功しても render_grid が null なら停止端末として live/none にし、grid と
history の両方を捨てる。古い画面を出したまま「ライブ」と称しないため。

localStorage への保存は前面かつ内容変化時のみ（C1/C6）。背面の grid を 3 秒ごとに
同期書き込みしない。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 9: `TabBar` — 全サーフェスのタブ行

**Files:**
- Modify: `apps/client/src/components/TabBar.tsx`
- Modify: `apps/client/src/App.tsx`（**同じタスクで呼び出し側も新 props へ移行する**）
- Test: `apps/client/src/components/__tests__/TabBar.test.tsx`（新規。現在テストが無い）

> **`App.tsx` を同じタスクに含めるのは、`TabBar` の必須 props を変えると呼び出し側が
> 型エラーになるからである。** コンポーネント側に互換 props を残す方式は取らない
> （Task 11 で二度手間になる）。この時点の `App.tsx` は shim の `currentSurface` を
> `foreground` に、`focusSurface` を `selectSurface` に渡すだけの最小限の配線でよい。
> 5 表示ケースの作り替えは Task 11 で行う。

**Interfaces:**
- Consumes: Task 6 の `Surface`（`workspace_ref` / `workspace_title` / `type`）, Task 4 の `TerminalFeed`
- Produces:
  ```ts
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
  ```

**タブ 1 個の内訳**: `[ ◗WS色ドット4px │ 短縮タイトル │ 購読ドット5px │ × ]`

| 状態 | 表現 |
|---|---|
| 前面 | 背景 `--color-bg` + 下線 2px `--color-accent`（現行どおり） |
| ライブ購読中（背面） | 5px の塗りつぶしドット `--color-accent` |
| 非購読（browser を含む） | ドットなし。タイトルを `--color-text-muted` へ |
| 購読中で activity | ドットを 6px に拡大 |
| 取得に失敗（`status === 'error'`） | ドットを `--color-warning` に。タイトルは `--color-text-subtle` |

- [ ] **Step 1: 失敗するテストを書く**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { TerminalFeed } from '../../lib/view-state'
import { TabBar } from '../TabBar'

const surfaces = [
  { index: 0, ref: 'surface:1', selected: false, title: '[1] zsh', type: 'terminal', workspace_ref: 'workspace:1', workspace_title: 'influencer-platform', workspace_id: 'W1', pane_ref: 'pane:1' },
  { index: 1, ref: 'surface:2', selected: false, title: '[2] zsh', type: 'terminal', workspace_ref: 'workspace:26', workspace_title: 'freelance-jp-app', workspace_id: 'W26', pane_ref: 'pane:9' },
  { index: 2, ref: 'surface:9', selected: false, title: 'docs', type: 'browser', workspace_ref: 'workspace:26', workspace_title: 'freelance-jp-app', workspace_id: 'W26', pane_ref: 'pane:9', url: 'https://example.com' },
]

const base = {
  surfaces,
  foreground: 'surface:1',
  subscribedRefs: new Set(['surface:1']),
  feeds: new Map(),
  workspaceColor: () => '#888',
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onCreate: vi.fn(),
}

describe('TabBar', () => {
  it('全ワークスペースのサーフェスを描画する（UR1）', () => {
    render(<TabBar {...base} />)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('aria-label に workspace 名と購読状態を含める（同名タブを区別できる）', () => {
    render(<TabBar {...base} />)
    expect(screen.getByRole('tab', { name: 'influencer-platform / zsh、ライブ購読中' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'freelance-jp-app / zsh、未購読' })).toBeTruthy()
  })

  it('browser タブは「購読対象外」と読み上げる', () => {
    render(<TabBar {...base} />)
    expect(screen.getByRole('tab', { name: 'freelance-jp-app / docs、browser、購読対象外' })).toBeTruthy()
  })

  it('購読中/非購読でドットを出し分ける（UR2 の回帰ガード）', () => {
    const { container } = render(<TabBar {...base} />)
    expect(container.querySelectorAll('[data-testid="live-dot"]')).toHaveLength(1)
  })

  it('browser にはドットを出さない', () => {
    const withBrowserSubscribed = { ...base, subscribedRefs: new Set(['surface:1', 'surface:9']) }
    const { container } = render(<TabBar {...withBrowserSubscribed} />)
    const dots = [...container.querySelectorAll('[data-testid="live-dot"]')]
    expect(dots.every((d) => d.closest('[role="tab"]')?.getAttribute('data-ref') !== 'surface:9')).toBe(true)
  })

  it('ワークスペースの変わり目に区切り線を引く', () => {
    const { container } = render(<TabBar {...base} />)
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect((tabs[1] as HTMLElement).style.borderLeft).toContain('--color-tab-group-border')
    expect((tabs[0] as HTMLElement).style.borderLeft).toBe('')
  })

  it('タップで onSelect に Surface を渡す（ref ではない）', async () => {
    const onSelect = vi.fn()
    render(<TabBar {...base} onSelect={onSelect} />)
    await userEvent.click(screen.getByRole('tab', { name: /freelance-jp-app \/ zsh/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:2' }))
  })

  it('× で onClose、+ で onCreate', async () => {
    const onClose = vi.fn()
    const onCreate = vi.fn()
    render(<TabBar {...base} onClose={onClose} onCreate={onCreate} />)
    await userEvent.click(screen.getAllByLabelText('Close tab')[0] as HTMLElement)
    expect(onClose).toHaveBeenCalledWith('surface:1')
    await userEvent.click(screen.getByLabelText('New tab'))
    expect(onCreate).toHaveBeenCalled()
  })

  it('前面が変わるとアクティブタブが scrollIntoView される', () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const { rerender } = render(<TabBar {...base} />)
    spy.mockClear()
    rerender(<TabBar {...base} foreground="surface:2" />)
    expect(spy).toHaveBeenCalled()
  })

  it('status が error のタブはドットが警告色になる', () => {
    const feeds = new Map<string, TerminalFeed>([
      ['surface:1', { status: 'error', source: 'memory', grid: null, history: '', updatedAt: null, activity: false, contentHash: '', epoch: 1, promotedAt: 0 }],
    ])
    const { container } = render(<TabBar {...base} feeds={feeds} />)
    const dot = container.querySelector('[data-testid="live-dot"]') as HTMLElement
    expect(dot.style.backgroundColor).toContain('--color-warning')
  })

  it('activity のあるタブはドットが 6px に拡大する', () => {
    const feeds = new Map<string, TerminalFeed>([
      ['surface:1', { status: 'live', source: 'memory', grid: null, history: '', updatedAt: null, activity: true, contentHash: '', epoch: 1, promotedAt: 0 }],
    ])
    const { container } = render(<TabBar {...base} feeds={feeds} />)
    const dot = container.querySelector('[data-testid="live-dot"]') as HTMLElement
    expect(dot.style.width).toBe('6px')
  })
})
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/TabBar.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 実装する**

`role="tablist"` / `role="tab"` を付け、`data-ref` を持たせる。区切りは前の要素と `workspace_ref` が違うときに `borderLeft: '2px solid var(--color-tab-group-border)'`。`aria-label` は次の関数で組む:

```tsx
function tabLabel(surface: Surface, subscribed: boolean): string {
  const name = `${surface.workspace_title} / ${shortTitle(surface.title)}`
  if (surface.type === 'browser') return `${name}、browser、購読対象外`
  return `${name}、${subscribed ? 'ライブ購読中' : '未購読'}`
}
```

`scrollIntoView` は 1 箇所で拾う:

```tsx
  const activeRef = useRef<HTMLDivElement | null>(null)
  // 前面が変わるすべての経路（タブタップ / ドロワー / 初期復元 / 退避 / 新規作成 / 通知ジャンプ）
  // を経路ごとに実装せず、「前面 ref の変化」1 箇所で拾う。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [foreground])
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/TabBar.test.tsx`
Expected: PASS。

- [ ] **Step 5: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 6: コミット**

```bash
git add apps/client/src/components/TabBar.tsx apps/client/src/App.tsx apps/client/src/components/__tests__/TabBar.test.tsx
git commit -m "$(cat <<'EOF'
feat(client): タブ行をワークスペース横断にし購読状態を可視化する (UR1/UR2)

全ワークスペースのサーフェスを 1 行に集約し、WS 色ドット・購読ドット・
WS 境界の区切り線を出す。購読状態を色だけで伝えないよう aria-label を付け、
同名タブを区別できるようワークスペース名を accessible name に含める。
browser は「未購読」ではなく「購読対象外」と伝える（ライブな iframe を
停止した端末と誤認させないため）。

前面変化時の scrollIntoView は経路ごとに実装せず「前面 ref の変化」1 箇所で拾う。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 10: `Drawer` と `Header`

**Files:**
- Modify: `apps/client/src/components/Drawer.tsx`（ワークスペース行を展開折りたたみに、配下にサーフェス行）
- Modify: `apps/client/src/components/Header.tsx`（`ワークスペース名 · 端末名` の 1 行 2 要素 + `freshness` の受け渡し）
- Modify: `apps/client/src/components/ConnectionIndicator.tsx`（`lastUpdated: number | null` → `freshness: string | null`）
- Modify: `apps/client/src/App.tsx`（**同じタスクで呼び出し側も新 props へ移行する**。Task 9 と同じ理由）
- Test: `apps/client/src/components/__tests__/Drawer.test.tsx`
- Test: `apps/client/src/components/__tests__/ConnectionIndicator.test.tsx`（新規。`freshness` をそのまま出すこと、`null` なら何も出さないこと）

**Interfaces:**
- Consumes: Task 6 の `Surface` と `selectSurface`, Task 9 の購読ドット表現
- Produces:
  ```ts
  interface DrawerProps {
    // 既存: open / workspaces / onCloseWorkspace / onNewWorkspace / onClose ...
    surfaces: Surface[]
    foreground: string | null
    subscribedRefs: ReadonlySet<string>
    onSelectSurface: (surface: Surface) => void
    // 現行の onSelect（ワークスペース選択）は削除する。行タップは展開/折りたたみのみ。
  }

  interface HeaderProps {
    // workspaceName を 2 分割する（§5.1 の「1 行 2 要素」）
    workspaceTitle: string | null
    surfaceTitle: string | null
    // D3.1 の鮮度ラベル。ConnectionIndicator へそのまま渡す。
    freshness: string | null
    onMenuToggle: () => void
    showMenuButton?: boolean
    status: ConnectionStatus
    onOpenSettings: () => void
  }

  interface ConnectionIndicatorProps {
    status: ConnectionStatus
    // 既存の lastUpdated（切断時のみ「オフライン · 最終 HH:MM」）を置き換える。
    // D3.1 の 5 ケースは connected 中も「更新: HH:MM:SS」「オフライン時点の内容 · 最終 HH:MM」
    // を出す必要があり、lastUpdated: number だけでは表現できないため、
    // 整形済みの文字列を受け取る形にする。
    freshness: string | null
  }
  ```

> **`ConnectionIndicator` の props を変えるのはこのタスクである。** 現行の
> `lastUpdated?: number | null` は「切断中にいつの内容か」を出すだけで、D3.1 が要求する
> connected 中の `更新:` / `オフライン時点の内容` を表せない。`describeFeed` が返す
> `freshness` 文字列をそのまま受け取る形へ変え、整形は `describeFeed`（Task 4）に一本化する。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
describe('Drawer', () => {
  it('ワークスペース行のタップは展開/折りたたみだけで、サーフェスの前面化を起こさない', async () => {
    const onSelectSurface = vi.fn()
    render(<Drawer {...base} onSelectSurface={onSelectSurface} />)
    await userEvent.click(screen.getByText('freelance-jp-app'))
    expect(screen.getByText('[2] zsh')).toBeTruthy() // 展開された
    expect(onSelectSurface).not.toHaveBeenCalled() // 行タップだけでは前面化しない
    await userEvent.click(screen.getByText('freelance-jp-app'))
    expect(screen.queryByText('[2] zsh')).toBeNull() // 折りたたまれた
    expect(onSelectSurface).not.toHaveBeenCalled()
  })

  it('サーフェス行タップで onSelectSurface に Surface を渡す', async () => {
    const onSelectSurface = vi.fn()
    render(<Drawer {...base} onSelectSurface={onSelectSurface} />)
    await userEvent.click(screen.getByText('[1] zsh'))
    expect(onSelectSurface).toHaveBeenCalledWith(expect.objectContaining({ ref: 'surface:1' }))
  })

  it('既定で展開されるのは前面サーフェスがあるワークスペースだけ', () => {
    render(<Drawer {...base} foreground="surface:1" />)
    expect(screen.getByText('[1] zsh')).toBeTruthy()
    expect(screen.queryByText('[2] zsh')).toBeNull()
  })

  it('購読中のサーフェス行には行頭にドットを出す（タブ行と表現を揃える）', () => {
    const { container } = render(<Drawer {...base} subscribedRefs={new Set(['surface:1'])} />)
    expect(container.querySelectorAll('[data-testid="live-dot"]').length).toBeGreaterThan(0)
  })

  it('ワークスペースを閉じる AlertDialog は現行どおり残る', async () => {
    render(<Drawer {...base} />)
    await userEvent.click(screen.getAllByLabelText(/close workspace/i)[0] as HTMLElement)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })
})
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/Drawer.test.tsx src/components/__tests__/ConnectionIndicator.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 実装する**

- `Drawer`: ワークスペース行を `<button aria-expanded>` にし、`expanded: Set<string>` をローカル state で持つ（**永続化しない**）。初期値は `foreground` を含むワークスペース 1 件。配下に `surfaces.filter(s => s.workspace_ref === ws.ref)` を並べ、行頭に Task 9 と同じドットを出す。既存の閉じる `×` + AlertDialog（`Drawer.tsx:293-352`）はそのまま残す。
- `Header`: `44px` の中で 1 行に 2 要素を `·` で区切る。ワークスペース名は `--color-text-muted`、端末名は `--color-text`。横幅が足りないときはワークスペース名側から `text-overflow: ellipsis` で省略する（**2 行にしない**）。`freshness` はそのまま `ConnectionIndicator` へ渡す。
- `ConnectionIndicator`: `lastUpdated` を捨てて `freshness: string | null` を受け取り、
  **非 null ならそのまま薄く表示する**（`--color-text-subtle`）。時刻の整形は `describeFeed`（Task 4）が
  済ませているので、このコンポーネントは `formatClock` を持たない。

  **ただし `freshness` の表示も `shownStatus` の 2 秒猶予に合わせる。** F8 は切断の瞬間に全 feed を
  `error` にするので、素直に即時表示すると **2 秒間だけ「緑の Connected」の横に「接続なし · 最終 …」が
  並ぶ**。猶予中は**直前の freshness を出し続け**、`shownStatus` が `disconnected` へ切り替わるのと
  同時に新しい freshness へ差し替える。

  受入条件（`ConnectionIndicator.test.tsx`）: **「切断直後 1999ms は `Connected` と旧 freshness」**、
  **「2000ms 後に `Disconnected` と『接続なし』が同時に出る」**、
  **「`freshness` が `null` なら何も出さない」**。

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run src/components/__tests__/Drawer.test.tsx src/components/__tests__/ConnectionIndicator.test.tsx`
Expected: PASS。

- [ ] **Step 5: 型と lint、全体テスト**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 6: コミット**

```bash
git add apps/client/src/components/Drawer.tsx apps/client/src/components/Header.tsx apps/client/src/components/ConnectionIndicator.tsx apps/client/src/App.tsx apps/client/src/components/__tests__/Drawer.test.tsx apps/client/src/components/__tests__/ConnectionIndicator.test.tsx
git commit -m "$(cat <<'EOF'
feat(client): ドロワーを展開式にし、ヘッダーを WS 名 · 端末名の 1 行 2 要素にする

ワークスペース行のタップは展開/折りたたみだけにし、workspace.select は投げない（D1）。
配下にサーフェス行を出し、購読中には行頭にタブ行と同じドットを出す（UR2 の一貫性）。
既定の展開は前面サーフェスがあるワークスペースのみで、展開状態は永続化しない。

Header は 44px の中に 2 行を積まず、1 行に 2 要素を置く。幅が足りなければ
ワークスペース名から省略する（縦の余白を増やさない）。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 11: `App.tsx` — 単数スカラーの撤去と 5 表示ケース

**Files:**
- Modify: `apps/client/src/App.tsx`（`termGrid` / `termHistory` / `lastUpdated` / `pollRef` の削除、`useTerminalFeeds` への委譲）
- Test: `apps/client/src/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: Task 6〜10 のすべて
- Produces: なし（最上位）

**5 表示ケース**（`(status, source)` の組で決まる）:

| # | `(status, source)` | 表示 | 鮮度の提示 |
|---|---|---|---|
| 1 | `live` / `memory` | 直近フレームを同期的に描画。RPC を待たない | 出さない |
| 2 | `warming` / `memory` | 最終フレームを描画し、成功後に差し替える | 「更新: HH:MM:SS」 |
| 3 | `warming` / `cache` | キャッシュを描画し、成功後に差し替える | 「オフライン時点の内容 · 最終 HH:MM」 |
| 4 | `source === 'none'` | `loading` は「読み込み中」、`live` は「表示できる内容がありません（端末が停止しています）」 | — |
| 5 | `error` | 描けるものがあれば残す | `updatedAt` があれば「接続なし · 最終 HH:MM」、無ければ「接続なし」だけ |

- [ ] **Step 1: 失敗するテストを書く**

表示ケースの選択は純粋関数に切り出してテストする。`App.tsx` の内部関数ではなく
`lib/view-state.ts` に置き、`lib/__tests__/view-state.test.ts` で固定する。

```ts
// lib/__tests__/view-state.test.ts に追記
import { describeFeed } from '../view-state'

describe('describeFeed — D3.1 の 5 表示ケース', () => {
  const at = 1_700_000_000_000 // 固定時刻

  // describeFeed は feed が無いとき null を返す。strict null check を通すため、
  // 各テストは必ずこのヘルパー経由で narrowing する。
  function must(feed: TerminalFeed): NonNullable<ReturnType<typeof describeFeed>> {
    const d = describeFeed(feed)
    if (d === null) throw new Error('describeFeed returned null')
    return d
  }

  it('1. live/memory は鮮度ラベルを出さない', () => {
    const d = must(feedOf({ status: 'live', source: 'memory', grid: gridOf('x'), updatedAt: at }))
    expect(d).toEqual({ kind: 'grid', freshness: null })
  })

  it('2. warming/memory は「更新: HH:MM:SS」を出す', () => {
    const d = must(feedOf({ status: 'warming', source: 'memory', grid: gridOf('x'), updatedAt: at }))
    expect(d.kind).toBe('grid')
    expect(d.freshness).toMatch(/^更新: \d{2}:\d{2}:\d{2}$/)
  })

  it('3. warming/cache は「オフライン時点の内容」を出す', () => {
    const d = must(feedOf({ status: 'warming', source: 'cache', grid: gridOf('x'), updatedAt: at }))
    expect(d.kind).toBe('grid')
    expect(d.freshness).toMatch(/^オフライン時点の内容 · 最終 \d{2}:\d{2}$/)
  })

  it('4. loading/none は「読み込み中」を出し、空白にしない', () => {
    const d = must(feedOf({ status: 'loading', source: 'none' }))
    expect(d).toEqual({ kind: 'message', message: '読み込み中', freshness: null })
  })

  it('4. live/none は「端末が停止しています」を出す（F5n）', () => {
    const d = must(feedOf({ status: 'live', source: 'none', updatedAt: at }))
    expect(d).toEqual({
      kind: 'message',
      message: '表示できる内容がありません（端末が停止しています）',
      freshness: null,
    })
  })

  it('5. error で描けるものがあれば残し、「接続なし · 最終 HH:MM」を出す', () => {
    const d = must(feedOf({ status: 'error', source: 'memory', grid: gridOf('x'), updatedAt: at }))
    expect(d.kind).toBe('grid')
    expect(d.freshness).toMatch(/^接続なし · 最終 \d{2}:\d{2}$/)
  })

  it('5. error で updatedAt が無ければ「接続なし」だけを出す', () => {
    const d = must(feedOf({ status: 'error', source: 'none', updatedAt: null }))
    expect(d).toEqual({ kind: 'message', message: '接続なし', freshness: '接続なし' })
  })

  it('5. error/none でも updatedAt があれば「接続なし · 最終 HH:MM」を出す（F5n の後で切断した場合）', () => {
    const d = must(feedOf({ status: 'error', source: 'none', updatedAt: at }))
    expect(d.kind).toBe('message')
    expect(d.freshness).toMatch(/^接続なし · 最終 \d{2}:\d{2}$/)
  })

  it('feed が無い（前面が browser など）ときは null を返す', () => {
    expect(describeFeed(undefined)).toBeNull()
  })
})
```

**5 ケースは selector の単体テストだけでは足りない。** spec §8 は「`useTerminalFeeds` と
`Terminal` の両方でテストする」と定めているので、**描画まで確認する結合テストも書く。**

```tsx
// src/__tests__/App.test.tsx
describe('App — 5 表示ケースの描画 (D3.1)', () => {
  it('1. live/memory: グリッドを描き、鮮度ラベルを出さない', async () => {
    renderAppWithFeed({ status: 'live', source: 'memory', grid: gridOf('live-content'), updatedAt: Date.now() })
    expect(await screen.findByText(/live-content/)).toBeTruthy()
    expect(screen.queryByText(/更新:/)).toBeNull()
    expect(screen.queryByText(/オフライン時点/)).toBeNull()
    expect(screen.queryByText(/接続なし/)).toBeNull()
  })

  it('2. warming/memory: 前回のフレームを描き「更新: HH:MM:SS」を出す', async () => {
    renderAppWithFeed({ status: 'warming', source: 'memory', grid: gridOf('prev-frame'), updatedAt: Date.now() })
    expect(await screen.findByText(/prev-frame/)).toBeTruthy()
    expect(screen.getByText(/^更新: \d{2}:\d{2}:\d{2}$/)).toBeTruthy()
  })

  it('3. warming/cache: キャッシュを描き「オフライン時点の内容」を出す', async () => {
    renderAppWithFeed({ status: 'warming', source: 'cache', grid: gridOf('cached-frame'), updatedAt: Date.now() })
    expect(await screen.findByText(/cached-frame/)).toBeTruthy()
    expect(screen.getByText(/オフライン時点の内容 · 最終 \d{2}:\d{2}/)).toBeTruthy()
  })

  it('4. loading/none: 「読み込み中」を出し、Terminal を描かない', async () => {
    renderAppWithFeed({ status: 'loading', source: 'none', grid: null, updatedAt: null })
    expect(await screen.findByText('読み込み中')).toBeTruthy()
    expect(screen.queryByTestId('wterm-root')).toBeNull()
  })

  it('4. live/none: 「端末が停止しています」を出す（F5n）', async () => {
    renderAppWithFeed({ status: 'live', source: 'none', grid: null, updatedAt: Date.now() })
    expect(await screen.findByText(/端末が停止しています/)).toBeTruthy()
  })

  it('5. error（描けるフレームあり）: フレームを残して「接続なし · 最終 HH:MM」', async () => {
    renderAppWithFeed({ status: 'error', source: 'memory', grid: gridOf('last-frame'), updatedAt: Date.now() })
    expect(await screen.findByText(/last-frame/)).toBeTruthy()
    expect(screen.getByText(/接続なし · 最終 \d{2}:\d{2}/)).toBeTruthy()
  })

  it('5. error（フレームなし・updatedAt なし）: 「接続なし」だけを出す', async () => {
    renderAppWithFeed({ status: 'error', source: 'none', grid: null, updatedAt: null })
    expect(await screen.findByText('接続なし')).toBeTruthy()
    expect(screen.queryByText(/最終/)).toBeNull()
  })
})
```

`App.tsx` 側のその他の結合テスト:

```tsx
// src/__tests__/App.test.tsx に追記
describe('App — 切替時の表示 (UR3)', () => {
  it('切替時に前の端末の画面が残らず、初見でも空白にしない', async () => {
    // surface:1 に内容が出ている状態から、初見の surface:2 へ切り替える
    render(<App />)
    await screen.findByText(/surface-1-content/)
    await userEvent.click(screen.getByRole('tab', { name: /surface:2/ }))
    // 旧端末の内容は消え、「読み込み中」が出る（空白でも旧内容でもない）
    expect(screen.queryByText(/surface-1-content/)).toBeNull()
    expect(screen.getByText('読み込み中')).toBeTruthy()
  })

  it('タブの + は前面サーフェスのワークスペースに workspace_id 指定で作る', async () => {
    render(<App />)
    await userEvent.click(screen.getByLabelText('New tab'))
    const create = sentRequests().find((r) => r.method === 'surface.create')
    expect(create?.params.workspace_id).toBe('W26') // 前面 surface のワークスペース UUID
    expect(create?.params.workspace_ref).toBeUndefined()
  })

  it('P8 の誤配置は端末を残したまま「別のワークスペースに作成されました」を出す', async () => {
    setResponse('surface.create', { surface_ref: 'surface:118', workspace_id: 'W1' }) // 要求は W26
    render(<App />)
    await userEvent.click(screen.getByLabelText('New tab'))
    expect(await screen.findByText(/別のワークスペースに作成されました/)).toBeTruthy()
    // 自動 rollback（surface.close）はしない
    expect(sentRequests().some((r) => r.method === 'surface.close')).toBe(false)
  })
})

describe('App — browser 分岐は現行維持 (D5)', () => {
  it('browser サーフェスを前面化すると BrowserView を描き InputBar を無効化する', async () => {
    render(<App />)
    await userEvent.click(screen.getByRole('tab', { name: /docs、browser、購読対象外/ }))
    expect(screen.getByTitle('browser-surface')).toBeTruthy() // BrowserView の iframe
    expect(screen.getByPlaceholderText(/コマンド/)).toBeDisabled()
  })

  it('browser には terminal.replay を一度も投げない', async () => {
    render(<App />)
    await userEvent.click(screen.getByRole('tab', { name: /docs、browser、購読対象外/ }))
    const replays = sentRequests().filter((r) => r.method === 'terminal.replay')
    expect(replays.every((r) => r.params.surface_id !== 'surface:9')).toBe(true)
  })
})

describe('App — Push 通知ジャンプ (D1 の 3 番目の経路)', () => {
  // Push が渡すのは workspace_id（UUID）。push/payload.ts:12 が /?workspace=<UUID> を作り、
  // sw.ts:55 が postMessage({ type:'navigate', workspaceId:<UUID> }) を送る。
  const WS26_UUID = 'C459840B-0000-0000-0000-000000000026'

  it('?workspace=<UUID> は Workspace.id で解決して該当 WS のサーフェスを前面化する', async () => {
    window.history.replaceState({}, '', `/?workspace=${WS26_UUID}`)
    render(<App />)
    expect(await screen.findByRole('tab', { name: /freelance-jp-app \/ zsh、ライブ購読中/ })).toBeTruthy()
    expect(sentRequests().some((r) => r.method === 'workspace.select')).toBe(false)
  })

  it('ref を渡しても解決しない（UUID で引いているガード）', async () => {
    window.history.replaceState({}, '', '/?workspace=workspace:26')
    render(<App />)
    // 前面は初期選択のまま変わらない
    expect(await screen.findByRole('tab', { name: /influencer-platform \/ zsh/, selected: true })).toBeTruthy()
  })

  it('マウント後の SW メッセージは selectSurface を通り、既存の購読集合を保持する', async () => {
    render(<App />)
    // 先に 3 件を購読させる
    await userEvent.click(screen.getByRole('tab', { name: /freelance-jp-app \/ zsh/ }))
    await userEvent.click(screen.getByRole('tab', { name: /influencer-platform \/ zsh/ }))
    const beforeDots = document.querySelectorAll('[data-testid="live-dot"]').length
    expect(beforeDots).toBeGreaterThan(1)
    await act(async () => {
      dispatchServiceWorkerMessage({ type: 'navigate', workspaceId: WS26_UUID })
    })
    // initializeFrom を使うと購読が 1 件に作り直されてドットが減る
    expect(document.querySelectorAll('[data-testid="live-dot"]').length).toBeGreaterThanOrEqual(beforeDots)
  })

  it('通知先に購読中のサーフェスがあればそれを、無ければ先頭を選ぶ', async () => {
    render(<App />)
    await act(async () => {
      dispatchServiceWorkerMessage({ type: 'navigate', workspaceId: WS26_UUID })
    })
    expect(screen.getByRole('tab', { name: /freelance-jp-app/, selected: true })).toBeTruthy()
  })
})
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd apps/client && pnpm vitest run src/__tests__/App.test.tsx`
Expected: FAIL。

- [ ] **Step 3: 実装する**

- **Task 6 で入れた shim を削除する**: `currentSurface` / `focusSurface`。あわせて本設計で使われなくなった `panes` / `currentPane` / `listPanes` / `navigatePane` / `navigateSurface` も削除する（`App.tsx` から参照が消えたことを確認してから）。**`navigateWorkspace` は Task 6 で削除済みなのでここには無い。**
- `termGrid` / `termHistory` / `lastUpdated` / `pollRef` / `staleResyncRef` / `lastScrollbackRef` を削除し、`useTerminalFeeds` に委譲する。
- 前面フィードだけを `Terminal` に渡す: `const feed = feeds.get(view.foreground ?? '')`。
- 表示は `describeFeed(feed)`（Task 4）の返り値で分岐する。`kind: 'grid'` なら `Terminal` に `feed.grid` / `feed.history` を渡し、`kind: 'message'` なら `Terminal` を描かずメッセージを出す。`freshness` は `ConnectionIndicator` の隣に薄く出す。
- browser 分岐（`App.tsx:196-199, 430-454`）は**そのまま維持する**。
- **空状態の描画**: `view.foreground === null` のとき（cmux に端末が 1 つも無い）は
  `Terminal` も `BrowserView` も描かず、**「端末がありません」**を出す（spec §4 D3 の 5 番目）。
  タブ行は `+` だけになる。この状態でも `pnpm check` / テストが通ること。
- **`pinned` を ref から state へ移す。** 現行 `App.tsx:98-101` の `pinnedRef` は
  `onPinnedChange` が ref を書き換えるだけで**再 render を起こさない**。そのまま
  `pinned={pinnedRef.current}` を渡すと、スクロールで unpin しても `useTerminalFeeds` の
  `latest.current.pinned` が更新されず、`read_text` と localStorage 更新が止まらない。

  ```ts
  const [pinned, setPinned] = useState(true)
  // Terminal からのピン留め通知。state にするので再 render が起き、
  // useTerminalFeeds の latest.current にも伝わる。
  const onPinnedChange = useCallback((next: boolean) => setPinned(next), [])
  // サーフェス切替でピン留めへ戻す。Terminal は resetKey で内部 ref を true にするだけで
  // 親の callback を呼ばないため、親側で明示的に戻す必要がある。
  useEffect(() => setPinned(true), [view.foreground])
  ```

  受入条件（App の結合テスト）: **「unpin すると次の周期から `read_text` が止まる」**、
  **「unpin 中に返った `read_text` の遅延応答を捨てる」**、
  **「別サーフェスへ切り替えると pin が `true` に戻る」**。
  Task 8 の静的な `pinned: false` 単体テストではこの配線不良を検出できない。
- **タブの `+`**: `createSurface(foregroundSurface.workspace_id)` を呼ぶ（`workspace_ref` ではない）。戻り値の `misplaced` が `true` なら「別のワークスペースに作成されました」を出す。**自動 rollback（`surface.close`）はしない** — ユーザーが意図して作った端末を黙って消す方が損失が大きく、誤配置は Mac 側の `surface.move` で直せる。
- **タブの `×`**: `closeSurface(ref)` は現行のまま。意味を変えない。
- **ディープリンクは「初回 bootstrap」と「マウント後の通知」を分ける。**
  - **初回 bootstrap**: URL の `?workspace=<UUID>` → `sessionStorage`（`cmux:foreground`）の順で
    **1 個の `preferredRef` に解決**してから `initializeFrom(surfaces, preferredRef)` を呼ぶ。
  - **URL の UUID は「解決できるまで pending として保持する」。** `workspace.list` と
    `surface.list` は別 RPC なので、**workspace だけ先に state へ来る時系列が普通に起こる**。
    現行 `App.tsx:341-358` は `workspaces.length > 0` で走り、解決の成否に関係なく
    直後に query を消すので、そのまま置き換えると一覧の到着順だけで Push 遷移が消える。

    ```ts
    // URL から読んだ UUID を state に保持する。読み取りだけを initializer で行い、
    // URL の書き換え（外部状態の変更）は StrictMode で二重実行され得る render 中ではなく
    // commit 後の effect で行う。
    const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(
      () => new URLSearchParams(window.location.search).get('workspace'),
    )
    const didStripQuery = useRef(false)
    useEffect(() => {
      if (didStripQuery.current) return
      didStripQuery.current = true
      stripWorkspaceQuery()   // 値は state が持っているので、URL の見た目だけ整える
    }, [])

    // bootstrap の境界は「最初の topology snapshot が適用済みか」。配列長で待たない
    // （成功した空 snapshot は正規状態であり、配列長で待つと永久に完了しない）。
    const bootstrappedRef = useRef(false)
    useEffect(() => {
      if (bootstrappedRef.current || !topologyReady) return
      bootstrappedRef.current = true
      const preferredRef = resolvePreferred(pendingWorkspaceId, workspaces, surfaces)
      setPendingWorkspaceId(null)
      initializeFrom(surfaces, preferredRef)   // surfaces が [] でも呼ぶ
    }, [topologyReady, workspaces, surfaces, pendingWorkspaceId, initializeFrom])
    ```

    `resolvePreferred` は **UUID → `Workspace.id` → 配下の「購読中があればそれ、無ければ先頭」**、
    解決できなければ **`sessionStorage`（`cmux:foreground`）が生存していればそれ**、
    どちらも無ければ `null`（`initialize` が `active` → 先頭 の順で決める）。
    **対象ワークスペースが存在しないと確定した場合も同じ fallback を使う。**

    受入条件（`app-integration.test.tsx`）: **`workspace.list` を先に resolve し
    `surface.list` を遅らせても、最終的に通知先のサーフェスが前面になること**、
    **成功した空 snapshot でも bootstrap が完了して「端末がありません」が描かれること**、
    **bootstrap 前に別サーフェスが前面にならず、`sessionStorage` の旧値も上書きされないこと**。
  - **マウント後の SW `postMessage`**: 対象 `Surface` を決めて **`selectSurface(surface)`** を呼ぶ。
    **`initializeFrom` を使ってはならない** — `initialize` は購読集合を「選んだ 1 件だけ」に
    作り直すので、それまでのバックグラウンド購読が全部落ちる。
  - どちらも **`Workspace.id`（UUID）で workspace を引く**。Push payload は `workspace_id` を渡す
    （`push/payload.ts:12` / `sw.ts:55`）。`workspace_ref` では引けない。
  - ワークスペース配下の対象は「**購読中があればそれ、無ければ先頭**」（spec §4 D1 の表）。
- `sessionStorage`（`cmux:foreground`）に前面 ref を保存する（`view.foreground` の変化を 1 箇所で拾う）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd apps/client && pnpm vitest run`
Expected: PASS（クライアント全件）。

- [ ] **Step 5: 全体の型・lint・テストを通す**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 6: shim が残っていないことを確認する**

Run: `grep -rn "currentSurface\|focusSurface\|selectWorkspace\|listPanes" apps/client/src --include=*.ts --include=*.tsx`
Expected: ヒットなし（テストの回帰ガードを除く）。

- [ ] **Step 7: コミット**

```bash
git add apps/client/src/App.tsx apps/client/src/hooks/useCmux.ts apps/client/src/__tests__/App.test.tsx
git commit -m "$(cat <<'EOF'
feat(client): App から単数スカラーを撤去し 5 表示ケースを実装する (D3.1)

termGrid / termHistory / lastUpdated / pollRef を useTerminalFeeds へ委譲し、
前面フィードだけを Terminal に渡す。表示は (status, source) の組で決まる 5 ケースに
統一する。空白のまま前の端末の画面を残さない（別の端末の内容だと誤認させるため）。

browser 分岐（BrowserView + InputBar 無効化）は現行のまま維持する。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## Task 12: CLAUDE.md の訂正とプローブスクリプト（D11 / UR6）

**Files:**
- Modify: `CLAUDE.md`
- Create: `scripts/cmux-probe.mjs`

**Interfaces:**
- Consumes: なし
- Produces: なし

**UR6 は「実装と同じコミット群の中で修正する」と定めているので、後回しにしない。**

- [ ] **Step 1: `CLAUDE.md` の誤った記述を消す**

`hooks/useCmux.ts` の項から次を**削除**する。

> **ワークスペース切替は `workspace.select` で cmux 側も追従させる** — cmux は選択中ワークスペース以外のターミナルを `read_text` できない（`internal_error`）ため、追従なしでは別ワークスペースのライブ表示が不可能。

代わりに次を書く。

> **ワークスペース切替は cmux 側の選択に一切触れない**（`workspace.select` を呼ばない）。非選択ワークスペースでも **`surface_id` 指定なら `read_text` / `terminal.replay` / `send_text` はすべて成功する**（実機プローブ済み。旧版の「非選択 WS は読めない」という記述は誤りだった）。`surface.create` は `workspace_ref` を**無視する**が **`workspace_id`（UUID）は効く**ので、対象ワークスペースへ直接作成できる。ただし**無効な `workspace_id` を渡してもエラーにならず選択中ワークスペースに作られる**ため、レスポンスの `workspace_id` を必ず検証すること。サーバーが `surface.create` に注入する既定は **`focus: false`**（`focus: true` は cmux の選択を奪う）。表示状態は `lib/view-state.ts` の `SwitcherState`（`ViewState` + `Map<surfaceRef, TerminalFeed>`）を 1 つの reducer で動かし、前面変更の入口は `selectSurface` / `initializeFrom` / `reconcileWith` の 3 つだけである。

- [ ] **Step 2: `scripts/cmux-probe.mjs` を追加する**

既定は **read-only** で次を出力する。

- `system.capabilities` の `protocol` / `version` / `access_mode` / メソッド数とハッシュ
- 選択 / 非選択ワークスペースそれぞれのサーフェスに対する `terminal.replay` と `surface.read_text` の成否
- **negative control**: `surface_ref` 指定が別サーフェスの内容を返すこと（フォールバックの検出）
- 短縮 ref と UUID の両方での結果
- ローカルフォーカスが前後で変わっていないこと
- `--load` で §3.5 と同じ負荷測定（クライアント数を引数で指定）

書き込み系（`send_text` / `create` / `move` / `focus:true` の検証）は **`--write` を明示したときだけ**実行し、**専用の使い捨てサーフェスに対してのみ**行い、必ずクローズしてワークスペース選択を元へ戻す。

実装は `/private/tmp/claude-501/multi-terminal-switch-handoff/probe13.mjs`（`focus:true`/`focus:false` の A/B と `workspace.create` のレスポンス確認）と `probe1..12.mjs` を統合したものにする。UDS への接続とフレーミングは `apps/server/src/push/line-framer.ts` と同じく `node:string_decoder` の `StringDecoder` を使う。

- [ ] **Step 3: CLAUDE.md にプローブの場所と実行方法を書く**

```
cmux の挙動が変わったときに気づけるよう、`node scripts/cmux-probe.mjs` を流して
CLAUDE.md の記述と食い違わないかを確認する（書き込み系の検証は `--write`、
性能測定は `--load <クライアント数>`）。
```

- [ ] **Step 4: 全体を通す**

Run: `pnpm check && pnpm test`
Expected: エラーなし。

- [ ] **Step 5: コミット**

```bash
git add CLAUDE.md scripts/cmux-probe.mjs
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md の誤った cmux 制約を訂正し、プローブスクリプトを追加する (D11/UR6)

「cmux は選択中ワークスペース以外のターミナルを read_text できない」は現行 cmux では
成立しない。非選択 WS でも surface_id 指定なら read_text / terminal.replay / send_text は
すべて成功する。surface.create は workspace_ref を無視するが workspace_id は効き、
無効な workspace_id はエラーにならず選択中 WS に作られる（レスポンス検証が必要）。

cmux の更新でこの前提が崩れたときに気づけるよう、再現可能なプローブを scripts/ に置く。
既定は read-only で、書き込み系は --write のときだけ使い捨てサーフェスに対して行う。

Claude-Session: https://claude.ai/code/session_01WNHHFenLzMSWFXCYGtWxsp
EOF
)"
```

---

## 完了条件

- [ ] `pnpm check` と `pnpm test` が両方グリーン
- [ ] `workspace.select` と `surface.focus` がコードベースから消えている（`grep -r "workspace.select\|surface.focus" apps/` が実装ファイルにヒットしない）
- [ ] `CLAUDE.md` の誤った記述が訂正されている
- [ ] spec §10 の R9（未レビューの合成 reducer と `generation` 契約）が Task 3/4/7 のテストで固定されている

## 明示的に変更しないもの

- `components/Terminal.tsx` の描画ロジック、`lib/render-grid.ts`、`--term-*`、ビューポートのダーク固定
- `components/__tests__/Terminal.test.tsx` の `resetKey` でピン留めがリセットされる既存の期待値（**維持する**。タブを行き来してもスクロール位置は復元せず、毎回最下部に戻る。端末ごとのピン留め保持は範囲外）
- Web Push（`push/` / `sw.ts` / `lib/push.ts`）。ディープリンクの粒度はワークスペースのまま
- `lib/selection.ts`（`resolveSelectedRef` は `listWorkspaces` の既存経路で使われ続ける。`initialize` からは使わない）
- `lib/render-grid.ts` / `lib/scrollback.ts` / `lib/scroll-intent.ts` / `lib/terminal-*.ts`（サーフェス非依存）
- サーバーの透過中継の仕組み、UDS のシャーディング（今回は入れない）
