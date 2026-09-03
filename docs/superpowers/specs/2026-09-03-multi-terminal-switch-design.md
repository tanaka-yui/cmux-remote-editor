# 複数端末の同時接続と切り替え — 設計

- 日付: 2026-09-03
- 対象: `apps/client`（主）/ `apps/server`（小）
- 状態: レビュー待ち

## 1. 背景と要望

ユーザーの言葉:

> 今端末が1つしか接続できないが、複数端末に接続して端末ごとに切り替えられるような機能をいれたい。画面設計も含めて提案して対応したい

このビューアは iPhone / PWA から、Mac 上で動く cmux の端末を閲覧・操作するためのものである。
現在は「見ている 1 つの端末」しかライブ更新されず、別の端末に移ると前の端末は完全に止まる。
とくにワークスペースを跨ぐ移動は、状態を全部捨てたうえで Mac 側の表示まで巻き添えで切り替える。

## 2. 現状（コードの事実）

「1 つしか接続できない」のは WebSocket や RPC の接続数の制約ではない。
RPC は id で多重化されており並行実行できる（`useCmux.ts:33,76`）。サーバーも素通しする（`ws.ts:137-148`）。
原因は **状態とポーリングが「アクティブな端末は常に 1 つ」を前提に組まれている**ことにある。

| # | 実装 | 位置 |
|---|---|---|
| 1 | 表示中端末を表す state が単数スカラー `currentSurface: string \| null` | `hooks/useCmux.ts:31` |
| 2 | 端末の内容を持つ state も 1 個分だけ（`termGrid` / `termHistory` / `lastUpdated`） | `App.tsx:83-85` |
| 3 | ポーリングは単一 interval（`pollRef`）で `currentSurface` のみ対象。切替時に `cancelled=true` + `clearInterval` で前の端末を明示的に殺す | `App.tsx:195-275` |
| 4 | ワークスペース切替が `surfaces` / `currentSurface` / `panes` / `currentPane` を全消去し、`workspace.select` で cmux 側の表示も奪う | `useCmux.ts:104-114` |
| 5 | 選択解決 `resolveSelectedRef` が `string \| null` を返す単数解決 | `lib/selection.ts:5-15` |
| 6 | 描画される `Terminal` は常に最大 1 個 | `App.tsx:429-449` |

UI は 2 階層になっている。ワークスペース = 左ドロワーの縦リスト（1 選択）、
サーフェス = 上部タブバーの横リスト（1 選択、カレントワークスペース内のみ）。
ペインはタブ間の 2px 区切り線としてのみ痕跡が残る（`TabBar.tsx:33-34`）。

## 3. 実機プローブで判明した新事実

cmux の UNIX ソケットへ直接 JSON-RPC を投げて確認した（記録: 本 spec の付録 A）。

**CLAUDE.md と `useCmux.ts:101-103` の記述は現行 cmux では成立しない。**

> cmux は選択中ワークスペース以外のターミナルを読めない（`surface.read_text` が `internal_error` を返す）

| # | 検証 | 結果 |
|---|---|---|
| P1 | `surface.read_text` + `surface_id`、非選択ワークスペース | **成功**。plain も `scrollback` も対象サーフェス自身の内容を返す |
| P2 | `surface.read_text` + `surface_ref` | フォーカス中サーフェスへフォールバック（別内容）。既存実装が `surface_id` を使うのは正しい |
| P3 | `terminal.replay` + `surface_id`、非選択ワークスペース | **成功**。geometry も対象固有 |
| P4 | ライブ性（全端末の `render_grid` を 4 秒あけて 2 回取得し差分） | 選択 WS 4/4、**非選択 WS 28/28 が変化** = 止まっていない |
| P5 | `surface.send_text` + `surface_id`、非選択ワークスペース | **成功** |
| P6 | `surface.create` の `workspace_ref` | **無視される**。常に選択中ワークスペースに作られる |

性能（同一 Mac、端末サーフェス 32 個在席時）:

- 単発: `terminal.replay` **~71ms** / `surface.read_text(scrollback, 2000行)` **~29ms** / `system.tree` **~4ms**
- 単一 UDS 接続は**事実上直列化**する（8 本並列 replay = 494〜555ms ≒ 逐次 622ms）
- UDS を 4 本に分散すると 284〜334ms（約 2 倍）

つまり **ワークスペースを跨いだ複数端末の同時ライブ表示・操作は技術的に可能**であり、
`workspace.select` による追従は読み書きの前提条件では**ない**。

## 4. 設計判断

### D1. `workspace.select` による追従をやめる

追従は P1 の制約を回避するためだけに入っていた。制約が存在しない以上、追従は
「PWA で見ただけで Mac の表示が動く」という副作用しか生まない。
これは既存の設計原則「タブ切替はローカル cmux のフォーカスを奪わない」
（`docs/superpowers/specs/2026-06-12-app-tab-focus-priority-design.md`）をワークスペースへ拡張したものである。

例外は D6 のみ。

これに伴い `currentWorkspace`（`useCmux.ts:27`）は**保持する state ではなく、前面端末の
`workspace_ref` からの導出値**になる。「アプリが選択中のワークスペース」という概念自体が消え、
ドロワーのワークスペース行は展開/折りたたみのトグルになる。
`selectWorkspace` は公開 API から外す。唯一の呼び出し元だった以下 3 経路はこう置き換える。

| 旧経路 | 新しい振る舞い |
|---|---|
| ドロワーのワークスペース行タップ（`App.tsx:380-382`） | 展開/折りたたみのみ。RPC は投げない |
| `createWorkspace` 直後の追従（`useCmux.ts:120-126`） | 作成は明示操作なので `workspace.select` を残す（D6 と同じ理由）。作成された端末を接続 + 前面化する |
| Push 通知タップの `?workspace=<id>`（`App.tsx:345`） | そのワークスペース配下の端末を**接続 + 前面化**する。既に接続中の端末があればそれを、無ければ先頭を選ぶ。`workspace.select` は投げない |

ディープリンクの粒度はワークスペースのままとし、**Web Push 側には手を入れない**。
`buildPayload` が `data` に載せているのは `workspace_id` だけで（`apps/server/src/push/payload.ts:8-13`）、
`CmuxNotification` は `surface_id` を持っているものの payload にも Service Worker の
`postMessage`（`sw.ts:55`）にも渡っていない。端末単位のディープリンクにするには
payload・SW・URL クエリ・App の 4 箇所を揃って変える必要があり、本件の主目的とは独立した変更になる。
「通知をタップしたら、その端末が直接開く」は自然な次の一歩だが、今回の範囲外とする。

### D2. 「接続中の端末」を第一級の概念にする

ユーザーの言う「接続」を、そのまま UI の概念にする。

- **接続中セット** = いま生かしている端末の順序付き集合。ワークスペースを跨いでよい。
- タブバーはカレントワークスペースのサーフェス一覧ではなく、**この接続中セット**を表示する。
- 摩擦を作らない: ドロワーで端末をタップしたら、選択と同時に自動で接続中セットへ入る。
  ユーザーが集合を明示管理する必要はない（上限超過は D4 の LRU が処理する）。

### D3. フォアグラウンド 1Hz / バックグラウンド 3s

- **フォアグラウンド**（表示中の 1 個）: 現行どおり 1 秒間隔で `terminal.replay`、
  最下部ピン留め中のみ `surface.read_text(scrollback)` も取得（`2026-07-27-modeless-scrollback-design.md` の方針を維持）。
- **バックグラウンド**（接続中だが非表示）: 3 秒間隔で `terminal.replay` のみ。scrollback は取らない。

切替時は保持済みの直近フレームを即座に描画し、次の 1Hz ポーリングで追いつく。
これが「切り替えた瞬間に最新が出る」= 体感上の常時接続を作る。

予算計算（上限 8、単一 UDS の 71ms/replay を前提）:

```
フォアグラウンド : (71 + 29) ms / 1000 ms = 10%
バックグラウンド : 7 本 × 71 ms / 3000 ms = 17%
合計             : 約 27%   （直列化する 1 接続の容量に対して十分な余裕）
```

サーバーの UDS 多重化（4 本で約 2 倍）は**今回は入れない**。この予算では不要であり、
必要になったときの手段として記録だけ残す。

### D4. 接続上限 8 と LRU 追い出し

`MAX_CONNECTED_SURFACES = 8`。超過時は「最後に前面にいた時刻」が最も古いものを外す。
外れるのは購読だけで、cmux 側の端末は閉じない。

同じ理由でオフラインキャッシュにも上限を入れる。現在 `lib/surface-cache.ts` は
1 サーフェスあたり 200,000 文字（`MAX_CACHED_CHARS`）を保存し、**古いキーを消さない**。
多端末化すると localStorage のクォータ（一般に約 5MB）を確実に超え、
書き込み失敗は無言で握り潰される（`surface-cache.ts:47-51`）。
`MAX_CACHED_SURFACES = 12` を設け、`updatedAt` の古い順に追い出す。
`QuotaExceededError` を捕捉したら最古を 1 件捨てて 1 回だけ再試行する。

これは今回の変更が悪化させる既存の欠陥なので、範囲内として直す。

### D5. サーバー: 平坦化したサーフェスにワークスペース属性を付ける

`FlatSurface`（`ws.ts:36-45`）には `workspace_ref` が無い。クロスワークスペース表示には必須なので、
`workspace_ref` / `workspace_title` / `workspace_selected` を追加する。
`flattenSurfaces` は `workspaceRef` 省略時に全ワークスペースを返す実装が既にあるため（`ws.ts:48-69`）、
変更は各行への属性付与だけで済む。透過中継の仕組みには手を入れない。

### D6. 新規端末の作成だけは `workspace.select` を伴う（D1 の唯一の例外）

P6 のとおり `surface.create` は `workspace_ref` を無視して選択中ワークスペースに作る。
したがって「このワークスペースに端末を追加」は、対象を選択してから作る以外に方法がない。
`+` は **ユーザーが明示的に起こした操作**なので、Mac 側の表示がそこへ移るのは
驚きではなく妥当な結果とみなす。作成後に元のワークスペースへ戻すことはしない。

### D7. 分割ビューは今回の範囲外

1 画面に複数端末を並べる案は、iPhone では 1 端末あたりの表示が狭くなりすぎる。
ユーザーの言葉も「切り替えられる」であって同時表示を求めていない。
ただし本設計の基盤（複数購読 + 端末ごとの状態保持）は分割ビューの前提そのものなので、
後から `Terminal` を n 個描画するだけで足せる。

## 5. 画面設計

### 5.1 モバイル（iPhone / PWA、主用途）

```
┌──────────────────────────────────────┐
│ ☰   freelance-jp-app · zsh    ● ⚙  │  Header 44
├──────────────────────────────────────┤
│ ●[1]Claude  ○[2]zsh·  ○[95]Claude +│  TabBar 38（接続中セット・横スクロール）
├──────────────────────────────────────┤
│                                      │
│                                      │
│            Terminal（1 面）           │  flex:1
│                                      │
│                                      │
├──────────────────────────────────────┤
│ [                        ] [送信]    │  InputBar
│ ⌨   A−  A＋                          │
└──────────────────────────────────────┘
```

現行の骨格（Header 44 / TabBar 38 / Terminal flex / InputBar）は変えない。**縦の余白を一切増やさない**。
変わるのはタブバーの中身の意味と、ヘッダーのタイトルだけである。

**ヘッダー**: いまは カレントワークスペース名のみ。接続中セットがワークスペースを跨ぐため、
`ワークスペース名 · 端末名` の 2 段（`·` 区切り、ワークスペース名は muted 色）にする。
どのプロジェクトの端末を見ているかが常に分かる。

**タブ**: 1 タブ = 接続中の 1 端末。左からワークスペース識別色のドット、短縮タイトル。
ワークスペース色は Drawer の `DEFAULT_PALETTE` を再利用するので、
色を見るだけで「別プロジェクトの端末」と分かる。

タブの状態表示（既存トークンのみ使用、新色を足さない）:

| 状態 | 表現 |
|---|---|
| 前面 | 背景 `--color-bg` + 下線 2px `--color-accent`（現行どおり） |
| 接続中・変化なし | 通常 |
| 接続中・前面を離れてから出力が変化 | タイトル右に 5px の `--color-accent` ドット |
| 取得に失敗 | ドットを `--color-warning` にし、タイトルを `--color-text-subtle` へ落とす |

末尾の `+` は現行どおり新規端末の作成（D6）。
タブの `×` は現行の「端末を閉じる」ではなく **「接続を外す」**に変わる。
端末そのものを閉じる操作はドロワー側に置く（誤操作で Mac 側の作業端末を消さないため）。

### 5.2 ドロワー（端末ピッカー）

```
┌ cmux Remote ────────── × ┐
│                          │
│ 接続中                   │
│  ● [1] Claude Code       │ ← 前面（アクセント下地）
│  ● [2] zsh            ⊗  │
│  ● [95] Claude Code   ⊗  │
│                          │
│ ワークスペース            │
│ ▾ ● influencer-platform  │
│     [1] Claude Code   ✓  │
│     [7] zsh           +  │
│ ▸ ● freelance-jp-app  2  │
│ ▸ ● yui-cc-plugins       │
│                          │
│ ＋ 新しいワークスペース   │
└──────────────────────────┘
```

ドロワーは「ワークスペースを選ぶ場所」から **「端末を選ぶ場所」** に変わる。

- 上段「接続中」: 接続中セットをそのまま縦に並べる。タップで前面化、`⊗` で接続解除。
  タブバーと同じ集合を別レイアウトで見せるので、タブが増えて横スクロールしても迷子にならない。
- 下段「ワークスペース」: 現行の行（識別色ドット / タイトル / 通知バッジ / 未読カウント / フォルダ名）を維持し、
  **タップで展開/折りたたみ**するようにする。展開すると配下の端末が並ぶ。
  行タップが `workspace.select` を呼ばなくなる点だけが振る舞いの変更である（D1）。
- 端末行タップ = 接続 + 前面化。すでに接続中なら `✓`、未接続なら `+` を右端に出す。
- 端末そのものを閉じる操作は、端末行の長押し（またはデスクトップでは行ホバー時の `×`）から
  AlertDialog 確認つきで行う。現行のワークスペース閉じる確認（`Drawer.tsx:293-352`）と同じ作法。

デスクトップ（>= 768px）は現行どおりピン留め `<nav>`（220px）、モバイルは radix Dialog のオーバーレイ。
展開状態は `useState` のローカル保持で十分（永続化しない）。既定は「前面の端末があるワークスペース」だけ展開。

### 5.3 操作モデルと遷移

| 操作 | 結果 | cmux 本体への影響 |
|---|---|---|
| タブをタップ | 前面が切り替わる。直近フレームを即描画し 1Hz へ昇格 | なし |
| ドロワーで端末をタップ | 接続 + 前面化（上限超過なら LRU で 1 件外れる） | なし |
| タブの `×` | 接続解除のみ | なし |
| タブの `+` | 前面端末のワークスペースに新しい端末を作成し、接続 + 前面化 | **選択ワークスペースが移動する**（D6） |
| ドロワーで端末を長押し → 確認 | 端末を閉じる（`surface.close`）。接続中なら自動的に外れる | 端末が閉じる |
| ワークスペース行をタップ | 展開/折りたたみのみ | **なし**（D1、従来は表示が奪われた） |
| PWA をバックグラウンドへ | 全ポーリング停止 | なし |
| 復帰 | 前面のみ即時再取得、バックグラウンドは次周期から | なし |

### 5.4 状態表示

接続状態（`ConnectionIndicator`）は現行のまま。
オフライン時は現行どおり「オフライン · 最終 HH:MM」を出すが、鮮度は**前面端末のもの**を表示する。

## 6. アーキテクチャ

このリポジトリの慣習（ロジックは `lib/` の純粋関数へ、コンポーネントは薄く）に従う。

### 新規モジュール

**`apps/client/src/lib/connections.ts`（純粋）**

接続中セットの操作を全部ここに閉じ込める。

```ts
export interface Connection { ref: string; lastForegroundAt: number }

// 接続 + 前面化。上限超過時は lastForegroundAt が最古のものを落とす。
export function connect(prev: Connection[], ref: string, now: number, cap: number): Connection[]
// 明示的な接続解除。
export function disconnect(prev: Connection[], ref: string): Connection[]
// surface 一覧から消えた ref を掃除する（別ウィンドウで閉じられた端末）。
export function reconcile(prev: Connection[], liveRefs: readonly string[]): Connection[]
// ポーリング対象と間隔を決める。
export function pollPlan(conns: Connection[], foreground: string | null): { ref: string; intervalMs: number }[]
```

**`apps/client/src/hooks/useTerminalFeeds.ts`**

`Map<surfaceRef, TerminalFeed>` を持ち、`pollPlan` に従って端末ごとの取得を回す。
`App.tsx:195-275` の単一 effect を置き換える。既存の要件はすべて引き継ぐ:

- in-flight レスポンスが切替後の状態を上書きしないためのキャンセル（`fe53249` の回帰）
- stale surface エラーの 1 回だけ resync（`staleResyncRef` を surface ごとに持つ）
- ピン留め中のみ scrollback 取得
- `visibilitychange` / `pageshow` / `focus` での即時再取得

```ts
export interface TerminalFeed {
  grid: RenderGrid | null
  history: string
  updatedAt: number | null
  activity: boolean   // 前面を離れてから内容が変化した
  error: boolean
}
```

### 変更するモジュール

| ファイル | 変更 |
|---|---|
| `hooks/useCmux.ts` | `selectWorkspace` を公開 API から削除し `currentWorkspace` を前面端末からの導出値にする（D1）。`listSurfaces()` を全ワークスペース取得に切り替える。`connections` の保持と `connect`/`disconnect` の公開 |
| `App.tsx` | 単数スカラー（`termGrid`/`termHistory`/`lastUpdated`）を `useTerminalFeeds` に委譲。前面フィードだけを `Terminal` に渡す |
| `components/TabBar.tsx` | 接続中セットを描画。ワークスペース色ドット、activity ドット、`×`=接続解除 |
| `components/Drawer.tsx` | 「接続中」セクション追加。ワークスペース行を展開可能にし、配下に端末行を出す |
| `components/Header.tsx` | `ワークスペース名 · 端末名` の 2 段表示 |
| `lib/surface-cache.ts` | `MAX_CACHED_SURFACES` の LRU 追い出しと `QuotaExceededError` の 1 回再試行（D4） |
| `apps/server/src/ws.ts` | `FlatSurface` に `workspace_ref` / `workspace_title` / `workspace_selected` を追加（D5） |

`lib/selection.ts` は**変更しない**。前面の解決は今までどおり単数で正しく、
複数性は `connections.ts` が持つ。既存の 5 ケースの回帰を壊さない。

`lib/render-grid.ts` / `lib/scrollback.ts` / `lib/scroll-intent.ts` / `lib/terminal-*.ts` は
サーフェス非依存なので変更しない。

## 7. エラー処理

| 事象 | 扱い |
|---|---|
| バックグラウンド端末の取得失敗 | そのフィードに `error` を立てタブに警告ドット。前面の表示には影響させない |
| バックグラウンド端末が stale（別ウィンドウで閉じられた） | 1 回だけ `listSurfaces` で再取得し、`reconcile` で接続中セットから外す |
| 前面端末が stale | 現行どおり resync して生きた端末へ退避 |
| WS 切断 | 全ポーリング停止。各フィードは直近値を保持したまま表示（オフライン鮮度表示） |
| localStorage クォータ超過 | 最古のキャッシュを 1 件捨てて 1 回だけ再試行。なお失敗したら黙って諦める（現行と同じ） |

## 8. テスト方針

既存の 3 層構成（`lib/` 純粋関数 → hooks/components 配線 → サーバーのワイヤ形式）に従う。

**新規**

- `lib/__tests__/connections.test.ts` — `connect`（新規/既存/上限超過の LRU）、`disconnect`、`reconcile`（消えた ref の掃除）、`pollPlan`（前面 1Hz / 背面 3s、前面なしのケース）
- `hooks/__tests__/useTerminalFeeds.test.ts` — 端末ごとに正しい `surface_id` で `terminal.replay` が飛ぶこと、切替時に in-flight が新前面を上書きしないこと、背面では scrollback を取らないこと。`vi.useFakeTimers()` を使う
- `components/__tests__/TabBar.test.tsx` — 現在テストが無い。接続中セットの描画、切替、接続解除、activity ドット

**拡張**

- `lib/__tests__/surface-cache.test.ts` — `MAX_CACHED_SURFACES` の追い出しと `QuotaExceededError` の再試行
- `hooks/__tests__/useCmux.test.ts` — ワークスペースを跨いだ接続で `workspace.select` が**一度も飛ばない**こと（D1 の回帰ガード）。`createWorkspace` では従来どおり飛ぶこと（D6）。既存の「`surface_id` を使い `surface_ref` を使わない」ガード（`useCmux.test.ts:44-57`）を複数端末版に拡張
- `components/__tests__/Drawer.test.tsx` — ワークスペース行の展開、端末行タップでの接続、閉じる確認
- `apps/server/src/__tests__/ws.test.ts` — `flattenSurfaces` がワークスペース属性を付けること、フィルタ省略時に全ワークスペースを返すこと

**変更しないと明示的に決めたもの**

- `components/__tests__/Terminal.test.tsx` — `resetKey` でピン留めがリセットされる既存の期待値は**そのまま維持する**。
  接続中セット内で端末を行き来してもスクロール位置は復元せず、毎回最下部に戻る。
  端末ごとのピン留め保持は範囲外（§9）なので、このテストに変更は入らない。
  実装時にここが落ちたら、それは設計から外れた副作用である。

検証コマンドは `pnpm check`（tsc + biome）と `pnpm test`。

## 9. 非目標

- 分割ビュー / 同時複数表示（D7）
- 端末ごとのピン留め・スクロール位置の保持
- サーバーの UDS 多重化（予算上不要。P の測定値だけ記録に残す）
- ペインを操作する UI（現行どおりタブの区切り線としてのみ表現）
- 複数の cmux インスタンスへの接続（「複数端末」はサーフェスの意味であり、cmux は 1 つ）

## 10. リスクと未解決

| # | 内容 | 対応 |
|---|---|---|
| R1 | D1 は既存の振る舞いを変える。「PWA で見たら Mac も切り替わる」に依存していたユーザーがいる可能性 | 追従は制約回避のための実装詳細であって意図された機能ではない。設定トグルは足さない（YAGNI）。レビューで異論が出たら再考する |
| R2 | P1〜P6 は 1 つの cmux バージョンでの実測。将来 cmux 側が変わると前提が崩れる | 前提が崩れたときの症状（非選択 WS の端末が固まる）と切り分け手順を CLAUDE.md に記録する |
| R3 | 端末が 30 個ある環境では、ドロワーの一覧が長くなる | 既定でカレントワークスペースのみ展開する。それ以上の整理（検索など）は必要になってから |
| R4 | activity ドットは grid のハッシュ比較で判定するため、カーソル点滅だけでも変化と見なす可能性 | 比較対象から `cursor` を除いた `lines` のみをハッシュする |
| R5 | 通知タップはワークスペース単位のままなので、端末が多いワークスペースでは「通知を出した端末」に一発で着地しない | 範囲外（D1 の表を参照）。必要になったら payload / SW / URL / App の 4 箇所を揃えて端末単位にする |

## 付録 A. プローブの再現方法

cmux の UNIX ソケット（`~/.local/state/cmux/last-socket-path` が指す先）へ 1 行 1 JSON で
`{"id":"1","method":"terminal.replay","params":{"surface_id":"<UUID or surface:N>"}}` を書き、
改行区切りの応答を読む。`system.tree` でワークスペースとサーフェスの一覧、`selected` フラグが取れる。
非選択ワークスペースのサーフェス ID を対象に `terminal.replay` / `surface.read_text` / `surface.send_text` を
投げることで P1〜P5 が再現できる。P6 は `surface.create` に `workspace_ref` を渡し、
`system.tree` で実際の作成先を確認する。
