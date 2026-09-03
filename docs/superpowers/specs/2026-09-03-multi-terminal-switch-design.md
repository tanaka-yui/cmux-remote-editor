# 複数端末の同時接続と切り替え — 設計

- 日付: 2026-09-03
- 対象: `apps/client`（主）/ `apps/server`（小）
- 状態: レビュー中（point=spec / round 1 再発行）

## 1. 背景と要望

ユーザーの言葉:

> 今端末が1つしか接続できないが、複数端末に接続して端末ごとに切り替えられるような機能をいれたい。画面設計も含めて提案して対応したい

このビューアは iPhone / PWA から、Mac 上で動く cmux の端末を閲覧・操作するためのものである。
現在は「見ている 1 つの端末」しかライブ更新されず、別の端末に移ると前の端末は完全に止まる。
とくにワークスペースを跨ぐ移動は、状態を全部捨てたうえで Mac 側の表示まで巻き添えで切り替える。

### 1.1 ユーザーが承認した方針（2026-09-03、parent 経由で確認済み）

**高速スイッチャ方式（A 案）を採用する。** 分割ビューは今回の範囲外。

承認された画面イメージ:

```
Header:  ☰ / 現在の端末名 (ws-a/vim) / 接続ドット / ⚙
タブ行:  [vim●][log●][db ][zsh]        ← ● はライブ購読中の印
本体:    選択端末を全画面表示（切替は即時）
最下部:  既存 InputBar（⌨ トグル・A−/A＋）
```

このモックから導かれる要件を、以降 **UR（User Requirement）** として明示する。

| # | 要件 |
|---|---|
| UR1 | タブ行はワークスペースを跨いだ**全端末**を 1 行に集約する（`db` / `zsh` のように購読していない端末もタブに並ぶ） |
| UR2 | **どの端末がいまライブ購読されているかがタブ上で一目で分かること。購読中/非購読の視覚的区別は必須** |
| UR3 | 切替は即時（再取得を待たずに最新が出る） |
| UR4 | `workspace.select` による cmux 追従は廃止する。設定トグルも作らない |
| UR5 | 分割ビューは範囲外。ただし基盤（複数購読マネージャ + 端末ごとの状態保持）は後から分割を足せる形にする |
| UR6 | CLAUDE.md と `useCmux.ts:101-103` の誤った記述を、**実装と同じコミット群の中で**修正する |
| UR7 | 同時ライブ購読数の上限、UDS 接続の割り当て方針、上限超過時の挙動を spec に明記する |

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
| 7 | `listSurfaces()` を引数なしで呼ぶと全ワークスペースの surface が返るが、他 WS のタブ混入を嫌って避けている | `App.tsx:118-120` のコメント |

UI は 2 階層になっている。ワークスペース = 左ドロワーの縦リスト（1 選択）、
サーフェス = 上部タブバーの横リスト（1 選択、カレントワークスペース内のみ）。
ペインはタブ間の 2px 区切り線としてのみ痕跡が残る（`TabBar.tsx:33-34`）。

## 3. 実機プローブで判明した新事実

cmux の UNIX ソケットへ直接 JSON-RPC を投げて確認した（再現方法は付録 A）。

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

### D1. `workspace.select` による追従をやめる（UR4）

追従は P1 の制約を回避するためだけに入っていた。制約が存在しない以上、追従は
「PWA で見ただけで Mac の表示が動く」という副作用しか生まない。
これは既存の設計原則「タブ切替はローカル cmux のフォーカスを奪わない」
（`docs/superpowers/specs/2026-06-12-app-tab-focus-priority-design.md`）をワークスペースへ拡張したものである。
設定トグルは作らない（UR4）。例外は D6 のみ。

これに伴い `currentWorkspace`（`useCmux.ts:27`）は**保持する state ではなく、前面端末の
`workspace_ref` からの導出値**になる。「アプリが選択中のワークスペース」という概念自体が消える。
`selectWorkspace` は公開 API から外す。唯一の呼び出し元だった 3 経路はこう置き換える。

| 旧経路 | 新しい振る舞い |
|---|---|
| ドロワーのワークスペース行タップ（`App.tsx:380-382`） | 展開/折りたたみのみ。RPC は投げない |
| `createWorkspace` 直後の追従（`useCmux.ts:120-126`） | 作成は明示操作なので `workspace.select` を残す（D6 と同じ理由）。作られた端末を前面化する |
| Push 通知タップの `?workspace=<id>`（`App.tsx:345`） | そのワークスペース配下の端末を前面化する。既に購読中の端末があればそれを、無ければ先頭。`workspace.select` は投げない |

ディープリンクの粒度はワークスペースのままとし、**Web Push 側には手を入れない**。
`buildPayload` が `data` に載せているのは `workspace_id` だけで（`apps/server/src/push/payload.ts:8-13`）、
`CmuxNotification` は `surface_id` を持っているものの payload にも Service Worker の
`postMessage`（`sw.ts:55`）にも渡っていない。端末単位のディープリンクにするには
payload・SW・URL クエリ・App の 4 箇所を揃って変える必要があり、本件の主目的とは独立した変更になる。

### D2. タブ行は全端末、購読は自動（UR1 / UR2）

ユーザー承認モックに従い、**タブ行にはワークスペースを跨いだ全端末が並ぶ**。
「接続中セットだけをタブに出す」案は採らない。

**購読はユーザーが管理しない。** ライブ購読の集合は「前面 + 直近に前面だった端末」の
自動的な LRU ウィンドウであり、タブを切り替えるだけで自然に更新される。
ユーザーが行うのは「タブを選ぶ」ことだけで、接続/切断という操作は存在しない。

購読状態はタブ上で必ず区別する（UR2）。表現は既存の CSS トークンのみで作り、新色は足さない。

| 状態 | 表現 |
|---|---|
| 前面 | 背景 `--color-bg` + 下線 2px `--color-accent`（現行どおり） |
| ライブ購読中（背面） | タイトル右に 5px の塗りつぶしドット `--color-accent` |
| 非購読 | ドットなし。タイトルを `--color-text-muted` へ落とす |
| 購読中で、前面を離れてから出力が変化 | ドットを 6px に拡大し、`--color-accent` のまま点灯（activity） |
| 取得に失敗 | ドットを `--color-warning` に。タイトルは `--color-text-subtle` |

タブ左端のワークスペース識別色ドット（Drawer の `DEFAULT_PALETTE` を再利用）は購読ドットとは別で、
「どのプロジェクトの端末か」を示す。両者は左右に分かれるので取り違えない。

この設計の副産物として、**タブの `×` は現行どおり「端末を閉じる」の意味を保つ**。
タブ行の意味が「全端末」のままなので、既存ユーザーの筋肉記憶を壊さない。

### D3. フォアグラウンド 1Hz / バックグラウンド 3s（UR3）

- **フォアグラウンド**（表示中の 1 個）: 現行どおり 1 秒間隔で `terminal.replay`、
  最下部ピン留め中のみ `surface.read_text(scrollback)` も取得
  （`2026-07-27-modeless-scrollback-design.md` の方針を維持）。
- **バックグラウンド購読**: 3 秒間隔で `terminal.replay` のみ。scrollback は取らない。
- **非購読**: 何も取らない。

切替時は保持済みの直近フレームを即座に描画し、次の 1Hz ポーリングで追いつく。
これが UR3 の「切替は即時」を満たす。非購読タブへ切り替えた場合のみ、
キャッシュ（`surface-cache`）の最終フレームを出しつつ初回取得を待つ（最大 1 往復 ≒ 71ms + RTT）。

### D4. 購読上限 8 と LRU、UDS 割り当て方針（UR7）

```
MAX_LIVE_SUBSCRIPTIONS = 8    // 前面 1 + 背面 7
BACKGROUND_POLL_INTERVAL = 3000 ms
FOREGROUND_POLL_INTERVAL = 1000 ms   （既存 POLL_INTERVAL のまま）
```

**上限超過時の挙動**: 前面化された端末を購読集合へ入れ、集合が 8 を超えたら
「最後に前面だった時刻」が最も古いものの購読を解除する。解除されるのは購読だけで、
cmux 側の端末は閉じないし、タブ行からも消えない（ドットが消えるだけ）。

**UDS 接続の割り当て**: 現行どおり **ブラウザ WS 1 本につき cmux UDS 1 本**とし、
サーバー側の多重化（シャーディング）は入れない。予算は次のとおり。

```
フォアグラウンド : (71 + 29) ms / 1000 ms      = 10%
バックグラウンド : 7 本 × 71 ms / 3000 ms      = 17%
1 クライアント合計                              = 約 27%
```

単一 UDS は直列化するため、1 接続の容量は約 14 replay/秒である。上の 27% はその内側に収まる。
クライアントが複数台つながると cmux 側の総負荷はその台数倍になる（WS ごとに UDS が増えるため）。
**2 台で約 54%、3 台で約 81%** となり、3 台が実用上の目安になる。
これを超える運用が現実になったら、初めて次の手を打つ:

1. `BACKGROUND_POLL_INTERVAL` を伸ばす（5s にすれば背面は 10% に下がる）
2. サーバーの UDS をシャーディングする（4 本で約 2 倍のスループット。P で実測済み）

いずれも本設計の外側で独立に導入できるため、今回は入れない。

### D5. サーバー: 平坦化したサーフェスにワークスペース属性を付ける

`FlatSurface`（`ws.ts:36-45`）には `workspace_ref` が無い。UR1 のクロスワークスペース表示には必須なので、
`workspace_ref` / `workspace_title` / `workspace_selected` を追加する。
`flattenSurfaces` は `workspaceRef` 省略時に全ワークスペースを返す実装が既にあるため（`ws.ts:48-69`）、
変更は各行への属性付与だけで済む。透過中継の仕組みには手を入れない。

クライアントは `listSurfaces()` を**引数なし**で呼ぶようになる（`App.tsx:118-120` のコメントが
避けていた「他ワークスペースのタブ混入」は、UR1 では混入ではなく仕様である）。

### D6. 新規端末の作成だけは `workspace.select` を伴う（D1 の唯一の例外）

P6 のとおり `surface.create` は `workspace_ref` を無視して選択中ワークスペースに作る。
したがって「このワークスペースに端末を追加」は、対象を選択してから作る以外に方法がない。
`+` は **ユーザーが明示的に起こした操作**なので、Mac 側の表示がそこへ移るのは
驚きではなく妥当な結果とみなす。作成後に元のワークスペースへ戻すことはしない。

### D7. オフラインキャッシュにも上限を入れる

現在 `lib/surface-cache.ts` は 1 サーフェスあたり 200,000 文字（`MAX_CACHED_CHARS`）を保存し、
**古いキーを消さない**。全端末がタブに並ぶ本設計では localStorage のクォータ（一般に約 5MB）を
確実に超え、書き込み失敗は無言で握り潰される（`surface-cache.ts:47-51`）。

`MAX_CACHED_SURFACES = 12` を設け、`updatedAt` の古い順に追い出す。
`QuotaExceededError` を捕捉したら最古を 1 件捨てて 1 回だけ再試行する。
今回の変更が悪化させる既存の欠陥なので、範囲内として直す。

### D8. 分割ビューは範囲外だが、基盤は分割を前提に切る（UR5）

端末ごとの状態は `Map<surfaceRef, TerminalFeed>` に持ち、`Terminal` へは
「1 個のフィード」を props で渡す形にする。`Terminal` 自体はどの端末を描いているかを知らない。
分割ビューを足すときは、`Terminal` を n 個並べて別々のフィードを渡し、
`pollPlan` の「前面」を集合に広げるだけで済む（`pollPlan` の返り値が既に per-surface の配列であるため）。

### D9. CLAUDE.md とコードコメントの訂正（UR6）

実装と同じコミット群の中で、次を修正する。後回しにしない。

- `CLAUDE.md` の `hooks/useCmux.ts` の項: 「ワークスペース切替は `workspace.select` で cmux 側も追従させる —
  cmux は選択中ワークスペース以外のターミナルを `read_text` できない（`internal_error`）」を削除し、
  **非選択ワークスペースでも `surface_id` 指定なら `read_text` / `terminal.replay` / `send_text` が動く**ことと、
  **`surface.create` だけは `workspace_ref` を無視して選択中ワークスペースに作る**という例外を書く。
- `hooks/useCmux.ts:101-103` の同趣旨のコメントを削除（そのコードごと消えるため、残骸を残さない）。
- 併せて、この事実がいつどう確認されたか（本 spec の P1〜P6）を辿れるようにする。

## 5. 画面設計

### 5.1 モバイル（iPhone / PWA、主用途）

```
┌──────────────────────────────────────┐
│ ☰   freelance-jp-app · zsh    ● ⚙  │  Header 44
├──────────────────────────────────────┤
│ ●[1]Claude ●[2]zsh  [95]Claude  [7]vim  +│  TabBar 38（全端末・横スクロール）
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
変わるのはタブ行に並ぶ集合（カレント WS のサーフェス → 全 WS の全端末）と、ヘッダーのタイトルだけである。

**ヘッダー**: いまはカレントワークスペース名のみ。タブがワークスペースを跨ぐため、
`ワークスペース名 · 端末名` の 2 段（`·` 区切り、ワークスペース名は `--color-text-muted`）にする。
どのプロジェクトの端末を見ているかが常に分かる。

**タブ 1 個の内訳**（左から）:

```
[ ◗ 色ドット4px │ 短縮タイトル │ 購読ドット5px │ × ]
   ↑ワークスペース識別色        ↑UR2 の購読中/非購読の区別
```

ワークスペースの変わり目には既存の `--color-tab-group-border` で区切り線を引く
（現在ペインの変わり目に引いているものを、ワークスペースの変わり目にも使う）。
タブ順はワークスペース順 → ペイン順 → サーフェス順で、`system.tree` の並びをそのまま使う。

末尾の `+` は現行どおり新規端末の作成（D6）。タブの `×` も現行どおり端末を閉じる。

### 5.2 ドロワー（端末一覧・ジャンプ用）

端末が 30 個ある環境ではタブ行の横スクロールだけでは目的の端末に届かない。
ドロワーはそのための一覧として残す。

```
┌ cmux Remote ────────── × ┐
│                          │
│ ▾ ● influencer-platform  │
│     ● [1] Claude Code    │ ← ● 購読中 / 太字＝前面
│       [7] zsh            │
│ ▸ ● freelance-jp-app  2  │ ← 2 = 未読通知
│ ▸ ● yui-cc-plugins       │
│                          │
│ ＋ 新しいワークスペース   │
└──────────────────────────┘
```

- ワークスペース行は現行の見た目（識別色ドット / タイトル / 通知バッジ / 未読カウント / フォルダ名）を維持し、
  **タップで展開/折りたたみ**に変える。`workspace.select` は投げない（D1）。
- 端末行タップ = その端末を前面化（タブ行も該当タブへスクロールする）。
- 購読中の端末には行頭に同じ塗りつぶしドットを出し、タブ行と表現を揃える（UR2 の一貫性）。
- 既定の展開は「前面端末があるワークスペース」のみ。展開状態は `useState` のローカル保持で、永続化しない。
- ワークスペースを閉じる操作（現行の `×` + AlertDialog、`Drawer.tsx:293-352`）はそのまま残す。

### 5.3 操作モデルと遷移

| 操作 | 結果 | cmux 本体への影響 |
|---|---|---|
| タブをタップ | 前面が切り替わる。購読中なら直近フレームを即描画、非購読ならキャッシュを出して初回取得。購読集合へ加わり、あふれた 1 件の購読が外れる | なし |
| ドロワーの端末行タップ | 同上。加えてタブ行を該当タブへスクロール | なし |
| タブの `×` | 端末を閉じる（現行と同じ） | 端末が閉じる |
| タブの `+` | 前面端末のワークスペースに新しい端末を作成し前面化 | **選択ワークスペースが移動する**（D6） |
| ワークスペース行をタップ | 展開/折りたたみのみ | **なし**（D1、従来は表示が奪われた） |
| PWA をバックグラウンドへ | 全ポーリング停止 | なし |
| 復帰 | 前面のみ即時再取得、背面は次周期から | なし |

### 5.4 状態表示

接続状態（`ConnectionIndicator`）は現行のまま。
オフライン時の鮮度表示（「オフライン · 最終 HH:MM」）は**前面端末のもの**を出す。

## 6. アーキテクチャ

このリポジトリの慣習（ロジックは `lib/` の純粋関数へ、コンポーネントは薄く）に従う。

### 新規モジュール

**`apps/client/src/lib/subscriptions.ts`（純粋）**

購読ウィンドウの操作を全部ここに閉じ込める。UI も RPC も知らない。

```ts
export interface Subscription { ref: string; lastForegroundAt: number }

// 前面化。購読集合へ入れ、cap を超えたら lastForegroundAt が最古のものを外す。
export function promote(prev: Subscription[], ref: string, now: number, cap: number): Subscription[]
// surface 一覧から消えた ref を掃除する（別ウィンドウで閉じられた端末）。
export function reconcile(prev: Subscription[], liveRefs: readonly string[]): Subscription[]
// ポーリング対象と間隔を決める。前面は 1Hz、その他の購読は 3s、非購読は含めない。
export function pollPlan(
  subs: Subscription[],
  foreground: string | null,
): { ref: string; intervalMs: number }[]
```

**`apps/client/src/hooks/useTerminalFeeds.ts`**

`Map<surfaceRef, TerminalFeed>` を持ち、`pollPlan` に従って端末ごとの取得を回す。
`App.tsx:195-275` の単一 effect を置き換える。既存の要件はすべて引き継ぐ:

- in-flight レスポンスが切替後の状態を上書きしないためのキャンセル（`fe53249` の回帰）
- stale surface エラーの 1 回だけ resync（`staleResyncRef` を surface ごとに持つ）
- ピン留め中のみ scrollback 取得（前面のみ）
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
| `hooks/useCmux.ts` | `selectWorkspace` を公開 API から削除し `currentWorkspace` を前面端末からの導出値にする（D1）。`listSurfaces()` を全ワークスペース取得に切り替える。購読集合の保持と `promote` の公開 |
| `App.tsx` | 単数スカラー（`termGrid`/`termHistory`/`lastUpdated`）を `useTerminalFeeds` に委譲。前面フィードだけを `Terminal` に渡す |
| `components/TabBar.tsx` | 全端末を描画。ワークスペース色ドット、購読ドット、ワークスペース境界の区切り線。`×` の意味は据え置き |
| `components/Drawer.tsx` | ワークスペース行を展開可能にし、配下に端末行を出す。購読ドットを揃える |
| `components/Header.tsx` | `ワークスペース名 · 端末名` の 2 段表示 |
| `lib/surface-cache.ts` | `MAX_CACHED_SURFACES` の LRU 追い出しと `QuotaExceededError` の 1 回再試行（D7） |
| `apps/server/src/ws.ts` | `FlatSurface` に `workspace_ref` / `workspace_title` / `workspace_selected` を追加（D5） |
| `CLAUDE.md` | 誤った制約の記述を訂正（D9 / UR6） |

`lib/selection.ts` は**変更しない**。前面の解決は今までどおり単数で正しく、
複数性は `subscriptions.ts` が持つ。既存の 5 ケースの回帰を壊さない。

`lib/render-grid.ts` / `lib/scrollback.ts` / `lib/scroll-intent.ts` / `lib/terminal-*.ts` は
サーフェス非依存なので変更しない。

## 7. エラー処理

| 事象 | 扱い |
|---|---|
| 背面端末の取得失敗 | そのフィードに `error` を立てタブのドットを警告色に。前面の表示には影響させない |
| 背面端末が stale（別ウィンドウで閉じられた） | 1 回だけ `listSurfaces` で再取得し、`reconcile` で購読集合から外す |
| 前面端末が stale | 現行どおり resync して生きた端末へ退避 |
| WS 切断 | 全ポーリング停止。各フィードは直近値を保持したまま表示（オフライン鮮度表示） |
| localStorage クォータ超過 | 最古のキャッシュを 1 件捨てて 1 回だけ再試行。なお失敗したら黙って諦める（現行と同じ） |

## 8. テスト方針

既存の 3 層構成（`lib/` 純粋関数 → hooks/components 配線 → サーバーのワイヤ形式）に従う。

**新規**

- `lib/__tests__/subscriptions.test.ts` — `promote`（新規/既存/上限超過の LRU 追い出し）、`reconcile`（消えた ref の掃除）、`pollPlan`（前面 1Hz / 背面 3s / 非購読は含めない / 前面なし）
- `hooks/__tests__/useTerminalFeeds.test.ts` — 端末ごとに正しい `surface_id` で `terminal.replay` が飛ぶこと、切替時に in-flight が新前面を上書きしないこと、背面では scrollback を取らないこと、非購読は 1 度も取得されないこと。`vi.useFakeTimers()` を使う
- `components/__tests__/TabBar.test.tsx` — 現在テストが無い。全端末の描画、購読中/非購読のドットの出し分け（UR2 の回帰ガード）、ワークスペース境界の区切り、切替、`×`

**拡張**

- `lib/__tests__/surface-cache.test.ts` — `MAX_CACHED_SURFACES` の追い出しと `QuotaExceededError` の再試行
- `hooks/__tests__/useCmux.test.ts` — ワークスペースを跨いだ前面化で `workspace.select` が**一度も飛ばない**こと（D1 の回帰ガード）。`createWorkspace` では従来どおり飛ぶこと（D6）。既存の「`surface_id` を使い `surface_ref` を使わない」ガード（`useCmux.test.ts:44-57`）を複数端末版に拡張
- `components/__tests__/Drawer.test.tsx` — ワークスペース行の展開、端末行タップでの前面化
- `apps/server/src/__tests__/ws.test.ts` — `flattenSurfaces` がワークスペース属性を付けること、フィルタ省略時に全ワークスペースを返すこと

**変更しないと明示的に決めたもの**

- `components/__tests__/Terminal.test.tsx` — `resetKey` でピン留めがリセットされる既存の期待値は**そのまま維持する**。
  タブを行き来してもスクロール位置は復元せず、毎回最下部に戻る。
  端末ごとのピン留め保持は範囲外（§9）なので、このテストに変更は入らない。
  実装時にここが落ちたら、それは設計から外れた副作用である。

検証コマンドは `pnpm check`（tsc + biome）と `pnpm test`。

## 9. 非目標

- 分割ビュー / 同時複数表示（UR5・D8。基盤だけ用意する）
- 端末ごとのピン留め・スクロール位置の保持
- サーバーの UDS 多重化（予算上不要。D4 に手段と実測値だけ記録）
- ペインを操作する UI（現行どおりタブの区切り線としてのみ表現）
- 複数の cmux インスタンスへの接続（「複数端末」はサーフェスの意味であり、cmux は 1 つ）
- Web Push のディープリンクを端末単位にすること（D1 の表を参照）

## 10. リスクと未解決

| # | 内容 | 対応 |
|---|---|---|
| R1 | 端末が 30 個ある環境ではタブ行が長大になる | ドロワーの一覧（5.2）がジャンプ手段。検索やフィルタは必要になってから |
| R2 | P1〜P6 は 1 つの cmux バージョンでの実測。将来 cmux 側が変わると前提が崩れる | 症状（非選択 WS の端末が固まる）と切り分け手順を CLAUDE.md に記録する（D9） |
| R3 | 複数クライアント同時接続で cmux 側の負荷が台数倍になる | D4 に目安（3 台）と 2 つの緩和策を明記。今回は実装しない |
| R4 | activity 判定は grid の比較で行うため、カーソル点滅だけでも変化と見なす可能性 | 比較対象から `cursor` を除いた `lines` のみをハッシュする |
| R5 | 通知タップはワークスペース単位のままなので、端末が多い WS では通知元の端末に一発で着地しない | 範囲外（D1 の表）。必要なら payload / SW / URL / App の 4 箇所を揃えて端末単位にする |
| R6 | タブ行の並びが `system.tree` 順のため、ユーザーが並べ替えられない | 範囲外。cmux 側の並びと一致していることの方が混乱が少ないと判断した |

## 付録 A. プローブの再現方法

cmux の UNIX ソケット（`~/.local/state/cmux/last-socket-path` が指す先）へ 1 行 1 JSON で
`{"id":"1","method":"terminal.replay","params":{"surface_id":"<UUID or surface:N>"}}` を書き、
改行区切りの応答を読む。`system.tree` でワークスペースとサーフェスの一覧、`selected` フラグが取れる。
非選択ワークスペースのサーフェス ID を対象に `terminal.replay` / `surface.read_text` / `surface.send_text` を
投げることで P1〜P5 が再現できる。P6 は `surface.create` に `workspace_ref` を渡し、
`system.tree` で実際の作成先を確認する。

P5 の検証は、自分で作った使い捨てサーフェスに対してのみ行い、検証後にクローズすること
（他人の作業端末に文字列を送り込まないため）。ワークスペースの選択を一時的に動かす場合は、
必ず元のワークスペースへ戻すこと。
