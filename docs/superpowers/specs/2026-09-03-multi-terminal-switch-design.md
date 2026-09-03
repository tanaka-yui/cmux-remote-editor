# 複数端末の同時接続と切り替え — 設計

- 日付: 2026-09-03
- 対象: `apps/client`（主）/ `apps/server`（小）
- 状態: **レビュー 5 ラウンド完了（上限）。round 5 の指摘を反映済みだが、その反映自体は未レビュー**
  （詳細は §10 の「レビューの到達点」）

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

| # | 要件 |
|---|---|
| UR1 | タブ行はワークスペースを跨いだ**全サーフェス**を 1 行に集約する（購読していない端末もタブに並ぶ） |
| UR2 | **どの端末がいまライブ購読されているかがタブ上で一目で分かること。購読中/非購読の視覚的区別は必須** |
| UR3 | 切替は即時。受入条件は §4 D3.1 の 5 ケース（`(FeedStatus, FeedSource)` の組ごとの表示契約）で定義する |
| UR4 | `workspace.select` による cmux 追従は廃止する。設定トグルも作らない |
| UR5 | 分割ビューは範囲外。ただし基盤は後から分割を足せる形にする |
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
| 3 | ポーリングは単一 `setInterval`（`pollRef`）で `currentSurface` のみ対象。切替時に `cancelled=true` + `clearInterval` で前の端末を明示的に殺す | `App.tsx:195-275` |
| 4 | ワークスペース切替が `surfaces` / `currentSurface` / `panes` / `currentPane` を全消去し、`workspace.select` で cmux 側の表示も奪う | `useCmux.ts:104-114` |
| 5 | 選択解決 `resolveSelectedRef` が `string \| null` を返す単数解決 | `lib/selection.ts:5-15` |
| 6 | 描画されるのは `BrowserView` か `Terminal` のどちらか 1 個 | `App.tsx:429-449` |
| 7 | browser サーフェスは `terminal.replay` を止めて `BrowserView` を描き、InputBar を無効化する | `App.tsx:196-199, 430-454` |
| 8 | `createSurface` は作成前後の surface 一覧を差分して新 ref を特定している | `useCmux.ts:179-195` |

## 3. 実機プローブで判明した事実

cmux の UNIX ソケットへ直接 JSON-RPC を投げて確認した。生の出力は付録 A に、
再現用スクリプトはリポジトリに残す（§8 の成果物）。

**接続先の同定**（`system.capabilities`）: `protocol: "cmux-socket"` / `version: 2` /
`access_mode: "allowAll"` / メソッド数 303。cmux には `system.version` も `system.info` も無いため、
バージョンの代わりにこの 3 値とメソッド一覧のハッシュを記録する。

### 3.1 クロスワークスペースの読み書き

**CLAUDE.md と `useCmux.ts:101-103` の記述は現行 cmux では成立しない。**

> cmux は選択中ワークスペース以外のターミナルを読めない（`surface.read_text` が `internal_error` を返す）

| # | 検証 | 結果 |
|---|---|---|
| P1 | `surface.read_text` + `surface_id`、非選択ワークスペース | **成功**。plain も `scrollback` も対象サーフェス自身の内容を返す |
| P2 | `surface.read_text` / `terminal.replay` + `surface_ref` | フォーカス中サーフェスへフォールバック（別内容・別 geometry）。既存実装が `surface_id` を使うのは正しい |
| P3 | `terminal.replay` + `surface_id`、非選択ワークスペース | **成功**。geometry も対象固有 |
| P4 | ライブ性（全端末の `render_grid` を 4 秒あけて 2 回取得し差分） | 選択 WS 4/4、**非選択 WS 28/28 が変化** = 止まっていない |
| P5 | `surface.send_text` + `surface_id`、非選択ワークスペース | **成功**（使い捨てサーフェスで検証、検証後クローズ） |

### 3.2 作成先の指定（round 1 レビューの指摘により再調査し、**前回の結論を訂正**）

round 1 の spec は「`surface.create` は `workspace_ref` を無視するので、対象ワークスペースを
選択してから作る以外に方法がない」と結論していた。これは **`workspace_ref` しか試していない
負のプローブに基づく誤りだった**。`surface_ref` ではなく `surface_id` が正解だった前例と同じ罠である。

| # | 検証 | 結果 |
|---|---|---|
| P6 | `surface.create` + `workspace_ref`（短縮 ref） | **無視される**。選択中ワークスペースに作られる |
| P7 | `surface.create` + **`workspace_id`（UUID）** | **効く。非選択ワークスペースに直接作成できる** |
| P8 | `surface.create` + `workspace_id` に無効な文字列 | **エラーにならず**、選択中ワークスペースに作られる（黙って無視される） |
| P9 | `surface.create` のレスポンス | `surface_id` / `surface_ref` / `workspace_id` / `workspace_ref` / `pane_id` / `pane_ref` / `window_*` / `type` を返す |
| P10 | `surface.move` + `surface_id` + `workspace_id` | **成功**。既存サーフェスを別ワークスペースへ移せる |

P7 により **`workspace.select` は完全に不要になった**（D1 の例外が消える）。
P9 により `createSurface` の「作成前後の差分で新 ref を特定する」実装（`useCmux.ts:179-195`）は不要になる。
P8 は「無効な id が黙って別の場所に作る」ため、レスポンスの `workspace_id` を検証する必要がある。

### 3.3 `surface_ref` の安定性

| # | 検証 | 結果 |
|---|---|---|
| P11 | 他ワークスペースにサーフェスを作成・削除したときの既存 32 サーフェスの ref | **32/32 変化なし**。作成でも削除でも既存の ref は動かない |
| P12 | `surface.move` されたサーフェス自身の ref | **変わる**（`surface:118` → `surface:119`）。移動先の位置で振り直される |

したがって `surface_ref` をキーに使う既存設計（`currentSurface`、`surface-cache` のキー、タブの key）は
**そのまま維持してよい**。ただし移動されたサーフェスだけは ref が変わるので、
一覧から消えた ref として `reconcile`（§6）が処理する。恒久的な同一性は UUID (`surface.id`) 側にある。

### 3.4 イベント購読の可否

`system.capabilities` には `events.v1` と `mobile.events.subscribe` / `mobile.events.unsubscribe` が
載っているが、**この UDS ソケットでは `method_not_found` を返す**。
`mobile.host.status` によれば `mobile.*` のイベント配信は別ポートの host service（`configured_port: 58465`、
現在 `is_running: false`）が担当する。よって **push 型の購読は使えず、ポーリング設計を維持する**。

`mobile.workspace.list` は UDS でも動作し、ワークスペース → 端末を 1 発で返す
（`has_unread` / `last_activity_at` / `is_ready` などの付加情報つき）。ただし **browser サーフェスを
含まず、pane 情報も `ref` も持たない**ため、既存の browser 対応（§2 の 7）を壊す。採用しない。

### 3.5 性能の実測

単発（32 端末が在席する状態、同一 Mac）:
`terminal.replay` **~71ms** / `surface.read_text(scrollback, 2000行)` **~29ms** / `system.tree` **~4ms**。

単一 UDS 接続は**事実上直列化**する（8 本並列 replay = 494〜555ms ≒ 逐次 622ms）。
UDS を 4 本に分散すると 284〜334ms（約 2 倍）。

**本設計の負荷そのものを 15 秒間かけて実測した**（前面 1 本を 1Hz で `replay` + `read_text(2000行)`、
背面 7 本を 3 秒間隔で `replay`、背面は 400ms ずつずらす）:

| クライアント数 | 前面サイクル p50 | 前面 p95 | 前面 max | 背面 replay p50 | 背面 p95 |
|---|---|---|---|---|---|
| 1 | 142ms | 182ms | 182ms | 57ms | 103ms |
| 2 | 182〜190ms | 203〜237ms | 237ms | 78〜80ms | 132〜142ms |
| 3 | 261〜285ms | **1074〜1102ms** | 1102ms | 124〜159ms | 410〜561ms |

**2 クライアントまでは 1Hz を余裕をもって維持できる。3 クライアントで前面の p95 が 1 秒を超え、
1Hz の周期を維持できなくなる。** round 1 の spec が書いた「3 台が実用上の目安」は誤りで、
正しくは **2 台までが安全域、3 台からは劣化する**。

## 4. 設計判断

### D1. `workspace.select` を一切呼ばない（UR4）

追従は §3.1 の制約を回避するためだけに入っていた。制約が存在しない以上、追従は
「PWA で見ただけで Mac の表示が動く」という副作用しか生まない。
これは既存の設計原則「タブ切替はローカル cmux のフォーカスを奪わない」
（`docs/superpowers/specs/2026-06-12-app-tab-focus-priority-design.md`）をワークスペースへ拡張したものである。
設定トグルは作らない（UR4）。

round 1 の spec は「新規端末の作成だけは例外」としていたが、P7 により**例外は無くなった**。
`workspace.select` の呼び出しは実装から完全に消える。これにより
「select と create の間に他クライアントが選択を変え、別ワークスペースに端末を作ってしまう」
という競合（round 1 レビューの指摘）も原理的に発生しない。

`currentWorkspace`（`useCmux.ts:27`）は**保持する state ではなく、前面サーフェスの
`workspace_ref` からの導出値**になる。`selectWorkspace` は公開 API から外す。
唯一の呼び出し元だった 3 経路はこう置き換える。

| 旧経路 | 新しい振る舞い |
|---|---|
| ドロワーのワークスペース行タップ（`App.tsx:380-382`） | 展開/折りたたみのみ。RPC は投げない |
| `createWorkspace` 直後の追従（`useCmux.ts:120-126`） | `workspace.create` の**レスポンスに含まれる既定端末**（`surface_ref` / `surface_id`）を前面化するだけ。**`surface.create` も `workspace.select` も呼ばない** |
| Push 通知タップの `?workspace=<id>`（`App.tsx:345`） | そのワークスペース配下のサーフェスを前面化する。既に購読中があればそれを、無ければ先頭。`workspace.select` は投げない |

ディープリンクの粒度はワークスペースのままとし、**Web Push 側には手を入れない**。
`buildPayload` が `data` に載せているのは `workspace_id` だけで（`push/payload.ts:8-13`）、
`CmuxNotification` は `surface_id` を持っているものの payload にも Service Worker の
`postMessage`（`sw.ts:55`）にも渡っていない。4 箇所を揃って変える独立した変更になるため範囲外とする。

### D1.1 `createWorkspace` は追加の端末を作らない

`workspace.create {}` は**新しいワークスペースと既定のターミナルを 1 つ作り**、
`{ window_ref, window_id, group_ref, group_id, workspace_ref, workspace_id, surface_ref, surface_id }`
を返す（付録 A で再確認済み。新ワークスペースの surface 数は 1、`selected` は `false`）。

したがって `workspace.create` のあとに `surface.create` を呼ぶと**端末が 2 つできる**。
手順は次の 3 つだけである。**順序に意味がある。**

1. `workspace.create {}` を呼ぶ
2. **サーフェス一覧とワークスペース一覧を再取得する**（D2.1 の T3）
3. **その refresh が適用されたことを await してから**、一覧の中でレスポンスの `surface_ref` に
   一致する `SurfaceLike` を引いて **`selectSurface(surface)`** する
   （`focus` を直接呼ばない。D3.1 の合成 reducer を通す）

**step 2 は D2.1 の共通 refresh 経路を 1 回呼ぶだけである。** 直接 RPC を投げたうえでさらに
T3 を通知する、という二重取得はしない（§6 に所有者を書き、hook テストで refresh 要求数を固定する）。
**step 3 が待つのは「この T3 を包含する refresh の適用」である**（D2.1 の `generation` 契約）。
既存の T5 が in-flight のときにその完了で進むと、作成前のスナップショットを見て
「ref 不在」と誤判定するためである。

**2 を 1 の直後に置くのは `focus` の入力を作るためである。** `focus` は type 判定のため
`SurfaceLike` 全体を要求する（D2）が、`workspace.create` のレスポンスに `type` は含まれない
（上のキー一覧のとおり）。レスポンスから `SurfaceLike` を合成すると、`type` を `'terminal'` と
決め打ちすることになり、cmux 側の既定が変わったときに黙って壊れる。一覧を引き直すのが安全である。

再取得は **2 RPC** 増える。現行経路ではサーフェス一覧（`surface.list`。サーバーが `system.tree` へ
変換する）とワークスペース一覧（`workspace.list`）が別の RPC だからである。1 つの `system.tree`
スナップショットから両方を導出する変更は**今回は入れない** — D7 で `FlatSurface` にワークスペース
属性は載るが、サーフェスを 1 つも持たないワークスペースが一覧から落ちるためである。
`system.tree` は実測 ~4ms（§3.5）で、新規ワークスペースには表示すべき内容がまだ無いので体感差は無い。

再取得した一覧に該当 `surface_ref` が無い場合（他クライアントが即座に閉じたなど）は
**前面を変えず**、`reconcile` の通常の規則に任せる。エラーとして扱わない。

`surface.create` と `workspace.select` のどちらも呼ばないことをテストで固定する。

### D2. 表示状態を 1 つの純粋な状態機械にする

round 1 レビューの最重要指摘は「前面と購読集合が別々に更新されると、
前面が購読集合の外を指す状態が作れてしまう」であった。これを構造で防ぐ。

**状態は 1 つの値である。**

```ts
export interface ViewState {
  // 購読中サーフェスの ref。順序は「最後に前面だった時刻の新しい順」。
  subscriptions: { ref: string; lastForegroundAt: number }[]
  // 前面サーフェスの ref。
  foreground: string | null
  // 前面サーフェスが属するワークスペースの ref。foreground と必ず同時に更新する。
  // これを持たないと、前面が消えたときの退避順 2「消えた前面と同じワークスペースの先頭」
  // （D3）が計算できない — 消えた ref は新しい生存一覧に無いため、そこから引けない。
  // Header の `ワークスペース名 · 端末名` 表示と D1 の `currentWorkspace` 導出もこれを使う。
  foregroundWorkspaceRef: string | null
}
```

`foregroundWorkspaceRef` は `foreground` の従属値であり、**独立に更新してはならない**。
`foreground === null` のときは必ず `null` である（I6）。

**不変条件（すべての遷移関数の事後条件としてテストする）**

| # | 不変条件 |
|---|---|
| I1 | `foreground` は `null` であるか、**生存する任意のサーフェスの ref**（terminal でも browser でもよい） |
| I2 | `foreground` が **terminal** のときに限り、それは必ず `subscriptions` に含まれる |
| I3 | `subscriptions` に含まれるのは**生存する terminal だけ**（browser は入らない） |
| I4 | `subscriptions` の ref に重複はない |
| I5 | `subscriptions.length <= cap`。**`cap` を受けるのは `focus` だけ**だが、他の遷移も上限を保存する: `reconcile` は削除後に既存購読があればそこから退避し、空のときだけ terminal を 1 件足す。`initialize` も最大 1 件しか作らない。`pollPlan` は集合を変えない。`cap >= 1` なのでどちらも上限内に収まる（I5 は「直近の `focus` に渡した `cap`」に対する事後条件である）。production では常に `MAX_LIVE_SUBSCRIPTIONS` |
| I6 | `foregroundWorkspaceRef` は `foreground` が指すサーフェスのワークスペースと一致する。`foreground === null` なら `null` |

旧版の「`foreground` は必ず `subscriptions` に含まれる」と「browser は `subscriptions` に
入らない」は、browser を前面化した瞬間に両立しなかった。I1 と I2 に分けることで、
browser 前面は「購読集合に入らないまま前面である」状態として正しく表現できる。

**遷移はこの 4 つだけで、すべて `ViewState → ViewState` の純粋関数である。**

```ts
// タブ/ドロワーからサーフェスを選ぶ。terminal なら購読集合へ入れ、あふれたら
// lastForegroundAt 最古を外す（foreground 自身は追い出さない。I2 を破らないため）。
// browser なら foreground だけ更新し、購読集合には触れない（I3）。
// 対象の type が必要なので ref ではなく SurfaceLike を受け取る。
// cap の事前条件は 1 <= cap <= MAX_LIVE_SUBSCRIPTIONS。I5 は cap を上限として検査する。
export function focus(state: ViewState, surface: SurfaceLike, now: number, cap: number): ViewState
// 生存一覧に合わせて掃除する。消えた ref を subscriptions から外し、
// foreground が消えていたら §4 D3 の退避順で選び直す。
// 退避順 2 に必要な「消えた前面のワークスペース」は state.foregroundWorkspaceRef から取る
// （消えた ref は surfaces に無いので、新しい一覧からは引けない）。
export function reconcile(state: ViewState, surfaces: readonly SurfaceLike[], now: number): ViewState
// 初期化。preferredRef は「ディープリンク → sessionStorage の前回前面」の順で
// 呼び出し側が 1 個に解決して渡す。どちらも無ければ null。
// initialize 内部では preferredRef -> s.active -> 先頭 の順で決める（D3）。
// 初期購読集合は「前面が terminal ならそれ 1 件だけ、browser または null なら空」。
// 先頭から cap 件まとめて購読することはしない（理由は D6）。
export function initialize(surfaces: readonly SurfaceLike[], preferredRef: string | null, now: number): ViewState
// ポーリング計画。表示中(visibleRefs)は 1Hz、その他の購読は 3s、非購読と browser は含めない。
// visibleRefs を集合で受けるのは、分割ビュー(UR5)で「表示中」が複数になっても
// この API の形を変えずに済ませるため。今回は常に foreground 1 件だけを渡す。
export function pollPlan(
  state: ViewState,
  surfaces: readonly SurfaceLike[],
  visibleRefs: readonly string[],
): { ref: string; intervalMs: number }[]
```

### D2.1 トポロジ（サーフェス一覧）の再取得契約

`reconcile` は「新しい一覧を渡されたとき」にしか働かない。渡す契機を決めていないと、
Mac や別 PWA で作られた端末がタブに出ない、外部で閉じられた非購読端末が ghost タブとして
残る、`surface.move` による ref 変更を検出できない、といったことが起きる。
`mobile.events.subscribe` が使えない（§3.4）以上、再取得は自前で回す。

| # | 再取得の契機 |
|---|---|
| T1 | WS の接続・再接続直後 |
| T2 | `visibilitychange` / `pageshow` / `focus` での復帰時 |
| T3 | 自 PWA が行ったすべてのトポロジ変更の直後（`surface.create` / `surface.close` / `workspace.create` / **`workspace.close`**） |
| T4 | stale surface エラーを検出したとき（現行動作） |
| T5 | 上記に加えて **`TOPOLOGY_POLL_INTERVAL = 5000ms` の低頻度ポーリング** |

T5 を入れるのは、UR1 が「現在存在する全サーフェス」を謳う以上、外部変更の反映を
偶発的な契機に頼れないためである。`system.tree` は実測 **~4ms** と安く（§3.5）、
5 秒間隔なら占有率は 0.1% 未満で §3.5 の測定結果を実質的に変えない。

**適用する規律は E1・E2 と、E4 のうち「`hidden` 中は停止し、遅れて返った応答は反映しない」だけ**である。
E3（背面 feed を index で stagger する）は対象が単一の topology loop には無意味なので適用しない。
E4 の「復帰時は前面のみ即時再取得」は feed の規則であり、topology の復帰時再取得は上の T2 が担う
（この 2 つは別物で、字義どおり E4 を適用すると T2 と衝突する）。
加えて **失敗しても既存の一覧を捨てない**（一時的な通信不良でタブが全部消えるのを防ぐ）、
取得した一覧は必ず `reconcile` を通し `ViewState` の更新と同一の遷移で反映する。

**即時再取得（T1〜T4）が in-flight 中に来たときは、捨てずに合流する。** 規則は次の 3 行で閉じる。

1. **同時に保持する queued refresh は最大 1 件**（dirty フラグ 1 個）。in-flight 中に T1〜T4 が
   何回発火しても、立つのは 1 件だけである
2. **dirty は各取得の「開始前」に消費する**（下ろしてから RPC を投げる）
3. その取得の最中にまた T1〜T4 が来れば dirty が再び立ち、完了後にもう 1 件走る

**呼び出し元へ返す Promise は「その要求を包含する refresh が state に適用された後」に、
その適用した一覧ごと resolve する。**

```ts
interface TopologySnapshot { generation: number; surfaces: Surface[]; workspaces: Workspace[] }
requestTopologyRefresh(): Promise<TopologySnapshot>
```

**generation（数値）だけを返してはならない。** 呼び出し元の async callback が閉じ込めた
React の `surfaces` state は「呼び出し開始時の render の値」のままで、refresh 内の `setSurfaces`
による再 render では更新されない。`await` の後に state を読むと**常に作成前のスナップショット**を
見る（D1.1 step 3 が「ref 不在」と誤判定する）。取得した一覧そのものを返すのが唯一の確実な方法である。

**waiter の照合には「適用に成功した generation」を使ってはならない。** generation は成功時しか
進まないので、先行 refresh が失敗すると queued waiter が到達不能な世代を待ち続ける。
要求ごとに単調増加する **seq** を採番し、各サイクルは開始時点の seq までを担当して、
**成否にかかわらず担当分を必ず settle する**（成功なら resolve、失敗・hidden 破棄なら reject）。

現在 in-flight の取得は自分の要求より前に始まっているので、その完了で resolve してはならない。

3 が要るのは、dirty を完了後に下ろすと **follow-up の実行中に来た新しい T3 を落とす**ためである。
2 の順序なら連続 mutation の間は refresh が直列に続き得るが、それが正しい
（「自分の操作の結果がすぐ出る」が T3 の目的であり、mutation が続く限り追随すべきである）。
合流が無いと mutation 直後の T3 が最大 5 秒待つことになり、T3 の契約を満たせない。

現行の `closeWorkspace` は `listWorkspaces()` しか呼んでいない（`useCmux.ts:207-211`）ため、
閉じたワークスペース配下のサーフェスがタブに残る。T3 でサーフェス一覧も更新する。

### D3.1 切替時の表示契約（UR3 の受入条件）

「再取得を待たずに最新が出る」は購読中の端末にしか成立しない。非購読の端末まで含めて
「最新」を必須にすると購読を止める設計自体が成り立たないので、UR3 を**観測可能な 5 ケース**に分解する。
これが受入条件であり、そのままテスト名になる。

**表示ケースは `(status, source)` の組で一意に決まる。** 購読集合の在否では決まらない。
`focus` は選んだ terminal を**即座に**購読集合へ入れるため、「非購読だから古い」という判定は
切替の瞬間に成立しなくなる。そこで**昇格してから 1 回でも取得に成功したか**（`status`）と、
**いま描いているフレームがどこ由来か**（`source`）を分けて持つ。

```ts
export type FeedStatus =
  | 'live'     // 今回の昇格後に 1 回以上取得成功した
  | 'warming'  // 昇格したが、まだ 1 回も成功していない（前回以前のフレームを見せている）
  | 'loading'  // 表示できるフレームが 1 つも無い（初見）
  | 'error'    // 直近の取得に失敗した / WS が切れている

export type FeedSource =
  | 'memory'   // このセッションで取得したフレーム（D3.2 の保持分を含む）
  | 'cache'    // localStorage から復元したスナップショット
  | 'none'     // 描けるフレームが無い
```

`status` を 4 値のままにして `source` を分けたのは、`warming` の 2 ケース
（メモリの前回フレーム / キャッシュのみ）が**鮮度ラベルだけ違う同じ状態**だからである。
キャッシュを feed へ復元してしまうと `status` だけでは由来を区別できない。

| # | `(status, source)` | 表示 | 鮮度の提示 |
|---|---|---|---|
| 1 | `live` / `memory` | メモリ上の直近フレームを**同期的に**描画。RPC を待たない | 出さない（鮮度目標は D4 E1 のとおり「interval + 取得時間」。失敗すれば 5 へ移る） |
| 2 | `warming` / `memory` | その最終フレームを同期的に描画し、成功後に差し替える | 「更新: HH:MM:SS」を薄く出す |
| 3 | `warming` / `cache` | キャッシュを描画し、成功後に差し替える | 「オフライン時点の内容 · 最終 HH:MM」 |
| 4 | `source === 'none'`（`loading` / `live` のどちらでも） | **空白にしない。** `loading` は「読み込み中」、`live` は**「表示できる内容がありません（端末が停止しています）」**（F5n の停止端末） | — |
| 5 | `error` / `memory` または `cache` または `none` | 描けるものがあればそれを残す。無ければ 4 と同じ枠に「接続なし」 | `updatedAt` があれば「接続なし · 最終 HH:MM」、**無ければ「接続なし」だけ**を出す（`error`/`none` は `updatedAt === null` になり得る） |

**空白のまま前の端末の画面を残してはならない**（別の端末の内容を今の端末だと誤認させるため）。
切替時にフィードが無ければ、まず旧端末の描画を捨ててから読み込み表示にする。

この 5 ケースは `useTerminalFeeds` と `Terminal` の両方でテストする。
本文・UR3・テストの数え方はすべて「5 ケース」で統一する。

#### 状態遷移（これが実装契約である）

`TerminalFeed` は `epoch: number` を持つ。**昇格するたびに単調増加**し、
RPC は**開始時点の epoch を捕まえて**発行する。応答の適用可否は
`captured.epoch === feed.epoch` で判定する。時刻（`promotedAt` 以降か）では判定できない
— 追い出し前に開始した RPC が再昇格の**後**に返れば、時刻だけ見ると条件を満たしてしまうためである。

| # | 遷移 | 条件 | 結果 |
|---|---|---|---|
| F1 | 昇格（購読外 → 購読内） | 保持 feed があり **`feed.source === 'memory'`** | `epoch++` / `promotedAt = now` / `warming` / `memory` |
| F2 | 昇格 | **`feed.source === 'cache'`**、または feed が無く localStorage キャッシュがある。**キャッシュの復元も同じ遷移の中で行う** | `epoch++` / `promotedAt = now` / `warming` / **`cache`** |
| F3 | 昇格 | 保持 feed が無く、キャッシュも無い（または `feed.source === 'none'`） | `epoch++` / `promotedAt = now` / `loading` / `none` |
| F4 | 前面化のみ（すでに購読中） | — | **何も変えない**。`live` を `warming` へ戻さない |
| F5 | 取得成功で `render_grid` **あり**（`captured.epoch === feed.epoch`） | — | `live` / `memory`、`updatedAt = now` |
| F5n | 取得成功で `render_grid` が **`null`**（同上） | 停止端末。`readGrid` は端末未起動時に成功応答から `null` を作る既知の契約である（`useCmux.ts:243-252`） | `live` / **`none`**、`updatedAt = now`。**描画中のフレームは捨てる**（ケース 4 の「停止しています」を出す） |
| F6 | 取得失敗（同上） | タイムアウト・`internal_error`・stale など | `error`。`source` と描画中フレームは保持 |
| F7 | 応答到着（`captured.epoch !== feed.epoch`） | 追い出し後の再昇格などで epoch が進んでいる | **破棄する**。`status` も `grid` も変えない |
| F8 | WS 切断 | — | 全 feed を `error` にする。フレームは保持（`source` も保持） |
| F9 | 再接続成功 | — | 購読中の全 feed を F1〜F3 と同じ規則で**昇格からやり直す**（`epoch++`） |
| F10 | 購読解除（追い出し） | — | `status` と `source` を据え置く。フレームは D3.2 に従って保持し、次の昇格で **`source` に応じて F1 か F2 に入る** |

**F1〜F3 の分岐は物理的な格納場所ではなく論理的な `source` で排他にする。** F2 で復元した
フレームは feed のメモリ上に載るが、`source` は `'cache'` のままである。ここを
「メモリに描けるフレームがあるか」で分けると、追い出し（F10）→ 再昇格の往復で
`cache` が `memory` に化け、**取得に成功する前に「オフライン時点の内容」ラベルが消える**。
`source` が `'memory'` に変わるのは F5（取得成功）のときだけである。

**F5n で描画中のフレームを捨てるのは、停止した端末に古い画面を出したまま「ライブ」と称しないため**である。
**`grid` と `history` の両方を捨てる**（`history` だけ残すと古い scrollback が再表示される）。

`localStorage` のスナップショットは消さない（C2 は変化時にしか書かない）が、
**同一セッションのうちは再利用しない。** F5n を経た feed は `source === 'none'` になり、
追い出し（F10）→ 再昇格でも切断（F8）→ 再接続（F9）でも **F3 に入る**。
「この端末は停止している」と一度分かった後にキャッシュの古い画面を復活させる方が誤解を招くためである。
スナップショットが使われるのは**次にページを読み込んだとき**（feed の `Map` が空なので F2 に入る）だけである。
これは F2 の条件「`feed.source === 'cache'`、または **feed が無く** cache がある」がそのまま表している。

#### 原子性は「1 つの合成状態を 1 つの reducer で動かす」ことで担保する

F1〜F3 は**前面の初回描画より前に**適用しなければならない。そうしないと、保持していた feed の
旧 `live` / `cache` 状態が 1 コミットだけ見えて「前の端末の画面が一瞬残る」ことが起きる。

これを React の batching の解釈に委ねない。**2 つの setter を別々に呼ぶ形も採らない。**
`setFeeds` の updater は**変更前の `ViewState` を見られない**ので、
「この terminal は本当に購読外から購読内へ変わったのか、もともと購読中だったのか」を
判定できない。feed は購読解除後も D3.2 で保持されるため、feed の有無からも区別できない。
無条件に昇格させると、**すでに `live` の背面を前面化しただけで `epoch++` して `warming` に戻り、
F4 を必ず破る**。browser を選んだときに何もしない、という条件も表現できない。

そこで**`ViewState` と feed の `Map` を 1 つの合成状態にまとめ、1 つの reducer で動かす**。

```ts
export interface SwitcherState {
  view: ViewState
  feeds: Map<string, TerminalFeed>
}

export type SwitcherAction =
  | { type: 'select';     surface: SurfaceLike; now: number; cap: number }
  | { type: 'initialize'; surfaces: readonly SurfaceLike[]; preferredRef: string | null; now: number }
  | { type: 'reconcile';  surfaces: readonly SurfaceLike[]; now: number }

// readCache を注入して純粋な reducer を作る（テストは fake を渡す）。
export function createSwitcherReducer(
  readCache: (ref: string) => CachedSnapshot | null,
): (state: SwitcherState, action: SwitcherAction) => SwitcherState
```

**reducer の規則はこの 1 行に集約される。**

> **F1〜F3 を適用するのは、その action で `subscriptions` に「新しく加わった」ref だけである。**

各 action は次の順で処理する。

1. `focus` / `initialize` / `reconcile`（これまでどおりの純粋関数）で `nextView` を作る
2. `added = nextView.subscriptions の ref 集合 − prevView.subscriptions の ref 集合` を取る
3. `added` の各 ref に F1〜F3 を適用する。`added` に含まれるのは I3 より必ず terminal である
4. `added` が空なら feed は 1 バイトも変わらない
5. D3.2 の `MAX_RETAINED_FEEDS` の LRU 退避を最後に適用する（購読中は退避対象外）

この規則だけで、round 4 まで個別に書いていた条件がすべて自動的に満たされる。

| 状況 | `added` | 結果 |
|---|---|---|
| すでに購読中の背面 terminal を前面化 | 空 | feed 不変 = **F4** |
| browser を前面化 | 空（browser は I3 より購読集合に入らない） | feed 不変 = **D5** |
| 非購読 terminal を前面化 | 1 件 | F1〜F3 |
| `initialize` が最初の terminal を購読へ入れる | 1 件 | F1〜F3（feed が無いので実際には F2 か F3） |
| `reconcile` が空の購読集合へ退避先 terminal を足す | 1 件 | F1〜F3 |
| `reconcile` が購読だけ削る | 空 | feed 不変（F10 は据え置き） |

**`focus` / `initialize` / `reconcile` / `promote` は `lib/view-state.ts` の内部関数のままにし、
hook からは公開しない。** 公開するのは `dispatch` と、それを包んだ
`selectSurface(surface)` / `initializeFrom(surfaces, preferredRef)` / `reconcileWith(surfaces)` の 3 つだけである。
タブタップ・ドロワー・初期復元・退避・新規作成・通知ジャンプの 6 経路はすべてこの 3 つのいずれかを呼び、
**`focus` を直接呼ぶ経路は作らない**（D1.1 step 3 も `selectSurface` を呼ぶ）。

```ts
// F1〜F3 のみ。reducer の内部から added の各 ref に対して呼ばれる。
function promote(
  feeds: ReadonlyMap<string, TerminalFeed>,
  ref: string,
  now: number,
  readCache: (ref: string) => CachedSnapshot | null,
): Map<string, TerminalFeed>
```

**受入条件**（§8 の結合テスト）:

1. `retained memory` / `cache` / `none` の 3 入力それぞれで、**foreground が変わった最初のコミットが
   `warming/memory` / `warming/cache` / `loading/none` であり、その前に中間コミットが無いこと**
2. **すでに `live/memory` の購読中 terminal を前面化しても `feeds` と `epoch` が不変であること**（F4）
3. **browser を前面化しても `feeds` が不変であること**（D5）
4. **`initialize` が作る最初の terminal** に F2/F3 が適用されること
5. **`subscriptions` が空の状態からの `reconcile` の退避先 terminal** に F1〜F3 が適用されること

### D3.2 メモリ上のフィードは購読より長く保持する

購読集合（上限 8）は**ポーリング対象**を決めるだけで、**フィードの保持期間ではない**。
`Map<surfaceRef, TerminalFeed>` は「このセッションで一度でも前面にした端末」を保持し、
購読から外れても最終フレームを捨てない。これにより D3.1 の 2 行目が成立する。

保持上限は `MAX_RETAINED_FEEDS = 24`（LRU）。`render_grid` 1 個は実測で数十 KB なので、
24 個でも数 MB のメモリに収まる。localStorage には書かないのでクォータには影響しない。

**`subscriptions` にある feed は LRU の退避対象から除外する**（事後条件）。
`MAX_RETAINED_FEEDS = 24` は購読上限 8 より十分大きいので通常は衝突しないが、
不等式に依存せず「購読中の端末のフレームが退避で消えることはない」を保証する。

### D3. 前面の決定順と退避順

**初期化時の前面（`initialize`）** — 上から順に最初に成立したものを採る。

1. Push ディープリンク（`?workspace=` / SW メッセージ）が指すワークスペースのサーフェス
2. 直前セッションの前面（`sessionStorage` に保持、後述）が生存していればそれ
   （1 と 2 は呼び出し側で 1 個の `preferredRef` に解決してから `initialize` へ渡す）
3. **`active === true` のサーフェス**（`system.tree` の `result.active.surface_ref` 由来。D7）
4. 一覧の先頭
5. 一覧が空なら `foreground = null`（空画面。「端末がありません」を出す）

3 の判定に `FlatSurface.selected` を使ってはならない。`selected` は**ペイン内の選択**を表すため、
全ワークスペースを平坦化すると `selected === true` が複数存在する（`ws.test.ts:76,80` が
まさにその形のフィクスチャを持ち、`useCmux.ts:187-189` のコメントも「マルチペインで複数 true に
なり得る」と明記している）。全 WS を混ぜた一覧に対して「最初の `selected`」を採ると、
cmux が実際に見ているサーフェスとは無関係なものを選びうる。

`system.tree` の `result.active.surface_ref` が唯一の正解なので、**サーバーがこれを
`surface.list` の応答に載せる**（D7）。クライアントはその 1 件だけを「アクティブ」として扱う。

**前面が消えたときの退避順（`reconcile`）**

1. `subscriptions` に残っている中で `lastForegroundAt` が最も新しいもの
2. それも無ければ、生存一覧の中で **`state.foregroundWorkspaceRef` と同じワークスペース**の先頭
   （消えた ref から辿るのではなく、`ViewState` に持っていた値を使う）
3. それも無ければ**生存一覧の先頭（＝別ワークスペースへ移る）**
4. 生存一覧が空なら `null`

4 の「空画面」は **cmux 全体にサーフェスが 1 つも無い**ときだけである。
前面のワークスペースが空になっただけなら 3 で別ワークスペースへ移る。
旧版はここが「別ワークスペースへ飛ばさない」と読める書き方になっていた。

`surface.move` で移動したサーフェスは **ref が振り直される**（P12）ため、`reconcile` からは
「消えて別の ref が増えた」ように見える。この場合も上の退避順をそのまま適用する
（移動前のワークスペースの先頭へ移る）。移動先を追いかける特別扱いはしない — 移動は
Mac 側の操作であり、PWA の前面が勝手に別ワークスペースへ飛ぶ方が驚きが大きい。

**タブの並びは `system.tree` の順（ワークスペース順 → ペイン順 → サーフェス順）で固定**し、
前面化や購読で**並べ替えない**。並べ替えるとタップ位置が動いて誤タップを誘発する。
`lastForegroundAt` は LRU の判定にのみ使い、表示順には影響しない。

**購読集合はセッション限定**とし、`localStorage` には保存しない。
前面の ref だけを `sessionStorage`（`cmux:foreground`）に持ち、リロード後の復帰に使う。
購読を永続化すると、閉じた端末や別マシンの状態を復元しようとして I3 を破りやすい。
そもそも初期購読集合は前面 1 件だけ（D6）なので、復元して温める対象も無い。

### D4. ポーリングの実行規律（round 1 レビュー P1-3 への対応）

`setInterval` は前回の完了を待たないため、遅延時に同一サーフェスへの要求が重なる。
実測（§3.5）で 3 クライアント時に前面 p95 が 1 秒を超えることが分かっており、
`setInterval` のままでは要求が積み上がる。次の規律を設計要件とする。

| # | 規律 |
|---|---|
| E1 | `setInterval` を使わない。**1 回の取得が完了してから `setTimeout` で次回を予約する**（自己再帰スケジュール）。したがって**間隔は「取得完了から次の取得開始まで」**であり、成功の間隔は `interval + 取得時間` になる。**鮮度目標もこの式で書く**: 前面は 1000ms + p50 142ms ≒ **1.14 秒**、背面は 3000ms + 実測分 ≒ **3.06 秒以上**（§3.5）。「1 秒ちょうど」「3 秒以内」は保証しない。overrun（1 サイクルが interval を超える）時も同じ式で、**取りこぼした tick は捨て**、開始時刻を起点に遅れを取り戻そうとしない（連打で過負荷を増幅させないため）。開始時刻基準で残り時間だけ待つ方式は採らない — 負荷面で §3.5 の測定より楽観的になり、安全域 2 クライアントという結論の前提が変わるため |
| E2 | **サーフェスごとの in-flight は常に 1 件まで**。前の応答が返るまで次を出さない |
| E3 | 背面の初回発火を **`index * BACKGROUND_STAGGER` だけずらす**（burst の平準化）。実測はこの分散込みの数値である |
| E4 | `document.visibilityState === 'hidden'` の間は**タイマーを張らず、遅れて返った応答も state に反映しない**。復帰時は前面のみ即時再取得し、背面は次の周期から |
| E5 | 前面のサイクルは `replay` → （ピン留め中のみ）`read_text` の順で、両方合わせて 1 サイクルとする。実測 p50 142ms |

### D5. browser サーフェスの扱い（round 1 レビュー P1-4 への対応）

タブ行は「全**サーフェス**」であり、browser サーフェスもタブに並ぶ（UR1）。
一方で **browser サーフェスは購読集合に入らず、`terminal.replay` を一度も投げない**。

| 状況 | 振る舞い |
|---|---|
| browser サーフェスがタブに並ぶ | 並ぶ。ワークスペース色ドットも出す |
| browser サーフェスの購読ドット | **常に出さない**（購読の概念が無いため）。`--color-text-muted` の非購読表示のまま |
| browser サーフェスを前面化 | 現行どおり `BrowserView` を描画し、InputBar を無効化する（`App.tsx:430-454` の挙動を維持） |
| browser サーフェスが背面 | 何もしない。RPC を投げない |
| `pollPlan` の返り値 | browser の ref を**含めない**（I3） |

これは現行の振る舞い（`App.tsx:196-199`）の維持であり、変更ではない。
回帰テストで固定する。

### D6. 購読上限 8 と UDS 割り当て（UR7）

```
MAX_LIVE_SUBSCRIPTIONS = 8    // 前面 1 + 背面 7
FOREGROUND_POLL_INTERVAL = 1000 ms   （既存 POLL_INTERVAL のまま）
BACKGROUND_POLL_INTERVAL = 3000 ms
BACKGROUND_STAGGER = 400 ms   // §3.5 の測定で用いた値に揃える
TOPOLOGY_POLL_INTERVAL = 5000 ms
```

**初期購読集合は 1 件である。** `initialize` は前面が terminal ならそれだけを購読集合に入れ、
browser または `null` なら空にする。**起動直後に先頭から 8 件をまとめて購読しない。**
理由は 2 つある。(a) リロードのたびに 8 本の RPC が同時に立ち上がり、§3.5 の測定条件
（前面 1 + 背面 7 が定常状態で回っている）とは違う瞬間負荷になる。(b) UR2 の購読ドットは
「ユーザーが選んだ端末がライブである」ことを示すものであり、起動直後に本人が選んでいない
7 個へドットが点くのは表示として嘘になる。購読はユーザーが `focus` した端末から順に増える。

**`cap` の事前条件は `1 <= cap <= MAX_LIVE_SUBSCRIPTIONS`** とし、I5 は `cap` を上限として
検査する（`focus` が任意の `cap` を受けるのに I5 が定数を見ていると、両者がずれる）。
`cap` を引数で受けるのは **`focus` だけ**である。他の 3 つも上限を保存する: `reconcile` は
削除後に既存購読が残っていればそこから退避先を選び、**購読集合が空になったときだけ** terminal を
1 件足す。`initialize` も最大 1 件しか作らない。`pollPlan` は集合を変えない。
つまり `cap >= 1` である限り、どちらの追加も上限内に収まるので `cap` を渡す必要が無い
（`ViewState` に持たせるのも、状態を 1 つ増やすだけで得が無いのでやめる）。
production の呼び出しは常に `MAX_LIVE_SUBSCRIPTIONS` を渡す。`cap` を引数にしているのは
テストで小さい値を使って追い出しを検証するためである。

**上限超過時の挙動**: 前面化されたサーフェスを購読集合へ入れ、集合が `cap` を超えたら
`lastForegroundAt` が最古のものの購読を解除する。ただし前面自身は追い出さない（I2）。
**`lastForegroundAt` が同値のときは `system.tree` 順で後ろにあるものを先に外す**
（tie-break を決定的にするため。初期購読は 1 件なので同時刻が並ぶのは主にテストの場面である）。
解除されるのは購読だけで、cmux 側の端末は閉じないし、タブ行からも消えない（ドットが消えるだけ）。

**UDS 接続の割り当て**: 現行どおり **ブラウザ WS 1 本につき cmux UDS 1 本**とし、
サーバー側の多重化（シャーディング）は入れない。

§3.5 の実測に基づく運用限界:

- **1〜2 クライアント: 安全**（前面 p95 237ms、1Hz に対して十分な余裕）
- **3 クライアント: 劣化**（前面 p95 が 1.07 秒。1Hz の周期を守れない）

3 クライアント以上を常用する運用が現実になったときの手段（今回は実装しない）:

1. `BACKGROUND_POLL_INTERVAL` を伸ばす
2. 背面を `render_grid` でなく差分の軽い手段に変える（cmux 側 API の再調査が必要）
3. サーバーの UDS をシャーディングする（4 本で約 2 倍。§3.5 で実測済み）

**上限やクライアント数を引き上げる前に §3.5 と同じ測定をやり直すこと。**
この数値は「32 端末在席・同一 Mac・15 秒」の条件下のものであり、条件が変われば変わる。

### D6.1 サーバーの `surface.create` 既定を `focus: false` にする

サーバーは現在 `surface.create` に `type:'terminal', focus:true` を注入している（`ws.ts:104-107`）。
**実測の結果、この `focus:true` は cmux の選択を奪う**（付録 A の P13）。
非選択ワークスペースへ `workspace_id` 指定で作成したところ、
`result.active` が `workspace:26/surface:98` から `workspace:1/surface:1` へ移動した。
`focus:false` では移動しない。

D1 の「PWA は cmux の選択状態に一切触れない」を守るため、**既定を `focus: false` に変える**。
前面化は PWA 側の `ViewState` で行うので、cmux 側のフォーカスは不要である。
これは既存の `+` の振る舞いを変える（今は作成と同時に Mac 側もそこへ移る）が、
UR4 の方針に沿った変更であり、CLAUDE.md にも記録する。

### D7. サーバー: 平坦化したサーフェスにワークスペース属性を付ける

`FlatSurface`（`ws.ts:36-45`）には `workspace_ref` が無い。UR1 のクロスワークスペース表示には必須なので、
`workspace_ref` / `workspace_title` / `workspace_id` を追加する。
`workspace_id` は P7 の対象指定作成に必要である。

あわせて **`active: boolean`** を追加する。`system.tree` の `result.active.surface_ref` と
一致する 1 件だけが `true` になる（D3 の初期前面決定に使う）。既存の `selected` は
ペイン内選択の意味のまま残し、意味の違う 2 つを混同しないよう `FlatSurface` の型に
コメントで書き分ける。全 WS 平坦化時に `active` が 2 件以上になったらサーバー側のバグである。
`flattenSurfaces` は `workspaceRef` 省略時に全ワークスペースを返す実装が既にあるため（`ws.ts:48-69`）、
変更は各行への属性付与だけで済む。透過中継の仕組みには手を入れない。

クライアントは `listSurfaces()` を**引数なし**で呼ぶようになる（`App.tsx:118-120` のコメントが
避けていた「他ワークスペースのタブ混入」は、UR1 では混入ではなく仕様である）。

`ws.ts` の `TreeWorkspace`（`ws.ts:23-27`）は `ref` と `panes` しか型に起こしていないが、
実レスポンスには `id` / `title` / `selected` / `pinned` / `index` が含まれる（付録 A）。型を広げれば取り出せる。

### D8. オフラインキャッシュの書き込み方針（round 1 レビュー P2-2 への対応）

現在の `lib/surface-cache.ts` の問題は 3 つある。

1. 1 サーフェスあたり `text` と `scrollback` が各 200,000 文字 + `grid` を保存でき、
   件数の上限が無い（`surface-cache.ts:11,30-52`）
2. `QuotaExceededError` を握り潰す（`surface-cache.ts:47-51`）
3. `grid` は**毎ポーリング**書き込まれる（`App.tsx:210`）。同期 localStorage 書き込みである

多端末化はこの 3 つすべてを悪化させるため、範囲内で直す。

| # | 方針 |
|---|---|
| C1 | **永続化するのは前面サーフェスのみ**。背面は state（メモリ）にだけ持つ。オフライン表示は前面のぶんしか見せないので、これで機能は落ちない |
| C2 | **内容が変化したときだけ書く**。`grid` も `scrollback` と同様に前回値と比較する（現在 `scrollback` だけが `lastScrollbackRef` で比較されている） |
| C3 | `QuotaExceededError` を捕捉したら、**`cmux-surface-cache:` 接頭辞のキーを `updatedAt` の古い順に削除しながら、成功するか候補が尽きるまで再試行する**（上限付きループ）。1 件だけ消して 1 回再試行では足りない |
| C4 | `MAX_CACHED_SURFACES = 12` は**二次ガード**として残す（C3 が働く前に件数が無限に増えないようにする） |
| C5 | **直列化後の 1 entry のサイズに上限を設ける**（`MAX_CACHED_ENTRY_BYTES`）。現行の `MAX_CACHED_CHARS` は `text` と `scrollback` に**別々に**適用されるうえ `grid` と JSON のオーバーヘッドが載るため、1 件で 500KB を超えうる。サイズは `new TextEncoder().encode(json).length` の**実バイト数**で測る（`String.length` は UTF-16 code unit 数で、CJK を含むと実バイト数と大きくずれる）。超えたら **`scrollback` → `text` → `grid` の順に削り**、`grid` だけでも超えるならその entry は保存しない |
| C6 | **メモリ上のフィード（D3.2）と localStorage の更新契機を分ける**。メモリは毎ポーリング更新、localStorage は「前面かつ内容変化時」のみ。背面の grid を 3 秒ごとに同期書き込みしない |

C1 により毎秒の同期書き込みは 8 回から 1 回に戻る。

### D9. 分割ビューは範囲外。今回用意するのは「フィードの分離」までである（UR5）

端末ごとの状態は `Map<surfaceRef, TerminalFeed>` に持ち、`Terminal` へは
「1 個のフィード」を props で渡す。`Terminal` 自体はどの端末を描いているかを知らない。
`pollPlan` は「表示中」を集合（`visibleRefs`）で受け、単数前提を API に残さない。

ただし **これは分割ビューの必要条件の一部にすぎず、「集合に広げるだけで足りる」わけではない**。
分割ビューを実際に足すときは、少なくとも次の追加設計が要る。

- 「表示中の集合」と「キーボード入力先」の分離（今は同一視している）
- ピン留め/スクロール位置をペインごとに持つこと（現在は `resetKey` で毎回リセットする前提）
- マウス/タップのルーティングを表示中ペインごとに分けること
- 同時表示を購読上限にどう数えるか
- browser サーフェスを分割ペインに置けるか
- サーフェスごとの `ErrorBoundary` とレイアウト状態

UR5 の受入条件は「フィードと描画が 1 端末単位に分離されており、`pollPlan` が単数前提でないこと」
までとし、分割ビューそのものは別途の設計を要する、と明記する。

### D10. WS 切断時に pending RPC を即座に reject する

`ws.ts` は cmux ソケットが閉じると WS を code 1011 で閉じるが（`ws.ts:187-195`）、
**in-flight だった RPC には何も返さない**。クライアント側も WS の `onclose` で
`pendingRef` の Promise を片付けていないため、投げっぱなしの RPC は
10 秒のタイムアウト（`useCmux.ts:23,71-74`）を待って初めて reject される。

単一端末なら宙に浮く Promise は 1 本だが、購読が 8 本になると同時に 8 本が宙に浮く。
本設計が増幅する欠陥なので範囲内で直す。契約は次の 4 点である。

1. **切断時に `pendingRef` の全 Promise を即座に reject する**。各 Promise の reject は
   ちょうど 1 回（タイムアウトタイマーは reject 前に必ず `clearTimeout` する）
2. **アンマウント時にも同じ後始末を行う**。ポーリングの `setTimeout` も全て clear する
3. reject 後に遅れて到着した応答は破棄する（`pendingRef` に無い id は現行どおり無視される）
4. **切断中に新しく呼ばれた RPC は即座に reject する**。現行の `useWebSocket.send` は
   `readyState !== OPEN` のとき**無言で何もしない**（`useWebSocket.ts:73-77`）が、
   `rpc` は送信前に pending と 10 秒タイマーを登録する（`useCmux.ts:67-78`）。
   このため 1 の後始末が終わったあとに呼ばれた RPC は、送信されないまま 10 秒待つ。
   `send` を**成功可否を返す契約**に変え、送れなかったら `rpc` が pending に入れず即 reject する。

テストは「切断時の既存 pending」「切断中の新規 RPC」「アンマウント」「reject 後の遅延応答」の 4 ケース。

参考として push 側の `rpc-connection.ts:58-61` は既に 1 と同じことをしている。

### D11. CLAUDE.md とコードコメントの訂正（UR6）

実装と同じコミット群の中で、次を修正する。後回しにしない。

- `CLAUDE.md` の `hooks/useCmux.ts` の項から「ワークスペース切替は `workspace.select` で cmux 側も
  追従させる — cmux は選択中ワークスペース以外のターミナルを `read_text` できない（`internal_error`）」を削除し、
  次を書く:
  - 非選択ワークスペースでも `surface_id` 指定なら `read_text` / `terminal.replay` / `send_text` が動く
  - `surface.create` は `workspace_ref` を無視するが **`workspace_id`（UUID）は効く**
  - `surface.create` に無効な `workspace_id` を渡すとエラーにならず選択中ワークスペースに作られるので、
    レスポンスの `workspace_id` を検証すること
- `hooks/useCmux.ts:101-103` の同趣旨のコメントを削除（そのコードごと消えるため残骸を残さない）。
- cmux の挙動が変わったときに気づけるよう、§8 のプローブスクリプトの場所と実行方法を CLAUDE.md に書く。

## 5. 画面設計

### 5.1 モバイル（iPhone / PWA、主用途）

```
┌──────────────────────────────────────┐
│ ☰  freelance-jp-app · zsh      ● ⚙ │  Header 44（1 行 2 要素）
├──────────────────────────────────────┤
│ ●[1]Claude ●[2]zsh  [95]Claude  [7]vim  +│  TabBar 38（全サーフェス・横スクロール）
├──────────────────────────────────────┤
│                                      │
│            Terminal（1 面）           │  flex:1
│         （browser なら BrowserView）   │
│                                      │
├──────────────────────────────────────┤
│ [                        ] [送信]    │  InputBar
│ ⌨   A−  A＋                          │
└──────────────────────────────────────┘
```

現行の骨格（Header 44 / TabBar 38 / Terminal flex / InputBar）は変えない。**縦の余白を増やさない**。

**ヘッダー**: **1 行に 2 要素**を `·` で区切って置く
（`ワークスペース名` は `--color-text-muted`、`端末名` は `--color-text`）。
44px の中に 2 行を積むのではない。横幅が足りないときはワークスペース名から省略する。

**タブ 1 個の内訳**（左から）:

```
[ ◗色ドット4px │ 短縮タイトル │ 購読ドット5px │ × ]
   ↑WS 識別色                  ↑UR2 の購読中/非購読の区別
```

| 状態 | 表現 |
|---|---|
| 前面 | 背景 `--color-bg` + 下線 2px `--color-accent`（現行どおり） |
| ライブ購読中（背面） | 5px の塗りつぶしドット `--color-accent` |
| 非購読（browser を含む） | ドットなし。タイトルを `--color-text-muted` へ |
| 購読中で、前面を離れてから出力が変化 | ドットを 6px に拡大（activity） |
| 取得に失敗 | ドットを `--color-warning` に。タイトルは `--color-text-subtle` |

新色は追加しない。ワークスペースの変わり目には既存の `--color-tab-group-border` で区切り線を引く。

**前面が変わるすべての経路で、アクティブタブを `scrollIntoView` する。**
タブタップ、ドロワーからのジャンプ、初期復元、タブを閉じた後の退避、新規作成、通知ジャンプの
6 経路すべてが対象で、経路ごとに実装するのではなく「前面 ref の変化」を 1 箇所で拾って行う。
**購読状態は色だけで伝えない。** タブに `aria-label` を付ける。
全ワークスペースを 1 行に混ぜると `zsh` や `Claude Code` は重複するので、
**accessible name にワークスペース名を含める**:
「influencer-platform / zsh、ライブ購読中」「freelance-jp-app / zsh、未購読」。
browser サーフェスは「未購読」ではなく **「browser、購読対象外」** と伝える
（ライブな iframe を停止した端末だと誤認させないため）。
タブの `×` は**現行どおり端末を閉じる**。意味は変えない。
末尾の `+` は新規端末の作成で、**前面サーフェスのワークスペースに `workspace_id` 指定で作る**（P7）。

### 5.2 ドロワー（一覧・ジャンプ用）

端末が 30 個ある環境ではタブ行の横スクロールだけでは目的の端末に届かない。

```
┌ cmux Remote ────────── × ┐
│ ▾ ● influencer-platform  │
│     ● [1] Claude Code    │ ← ● 購読中 / 太字＝前面
│       [7] zsh            │
│ ▸ ● freelance-jp-app  2  │ ← 2 = 未読通知
│ ▸ ● yui-cc-plugins       │
│ ＋ 新しいワークスペース   │
└──────────────────────────┘
```

- ワークスペース行は現行の見た目を維持し、**タップで展開/折りたたみ**に変える。`workspace.select` は投げない。
- サーフェス行タップ = 前面化（タブ行も該当タブへスクロール）。
- 購読中には行頭に同じドットを出し、タブ行と表現を揃える（UR2 の一貫性）。
- 既定の展開は「前面サーフェスがあるワークスペース」のみ。展開状態は永続化しない。
- ワークスペースを閉じる操作（現行の `×` + AlertDialog、`Drawer.tsx:293-352`）はそのまま残す。

### 5.3 操作モデルと遷移

| 操作 | 結果 | cmux 本体への影響 |
|---|---|---|
| タブをタップ | 前面が切り替わる。購読中なら直近フレームを即描画、非購読ならキャッシュを出して初回取得。購読集合へ加わり、あふれた 1 件の購読が外れる | なし |
| ドロワーのサーフェス行タップ | 同上。加えてタブ行を該当タブへスクロール | なし |
| タブの `×` | 端末を閉じる（現行と同じ）。`reconcile` が購読集合と前面を整える | 端末が閉じる |
| タブの `+` | 前面のワークスペースに `workspace_id` 指定で作成し前面化 | 端末が増える。**選択ワークスペースは動かない** |
| ワークスペース行をタップ | 展開/折りたたみのみ | **なし** |
| PWA をバックグラウンドへ | 全ポーリング停止（E4） | なし |
| 復帰 | 前面のみ即時再取得、背面は次周期から | なし |

## 6. アーキテクチャ

このリポジトリの慣習（ロジックは `lib/` の純粋関数へ、コンポーネントは薄く）に従う。

### 新規モジュール

**`apps/client/src/lib/view-state.ts`（純粋）** — D2 の `ViewState` と 4 つの遷移関数、
D3.1 の `promote`（F1〜F3）と **`createSwitcherReducer`（`SwitcherState` = `{ view, feeds }` の合成遷移）**、
および不変条件 I1〜I6 を満たすことの責任を持つ。UI も RPC も知らない。
`focus` / `initialize` / `reconcile` / `promote` は**この中の内部関数**で、外へは公開しない。
合成 reducer にまとめるのは、**「購読集合に新しく加わった ref」を変更前後の `ViewState` から
求めないと F1〜F3 の適用対象が決まらない**ためである（D3.1 の原子性）。

**`SwitcherState` の所有者は `useCmux` 1 つ**である（`useReducer(createSwitcherReducer(readCache))`）。
`view` と `feeds` を別々の hook が持つ形はやめる — 別々の setter では「本当に購読が増えたか」を
feed 側で判定できず、F4 と browser を表現できないためである（D3.1）。
公開するのは **`selectSurface` / `initializeFrom` / `reconcileWith` の 3 つだけ**で、
タブ・ドロワー・初期復元・退避・新規作成・通知ジャンプの 6 経路はすべてこのいずれかを呼ぶ。

**`apps/client/src/hooks/useTerminalFeeds.ts`** — `useCmux` が持つ `feeds` に対して
`pollPlan` に従って E1〜E5 の規律でサーフェスごとの取得を回す。
`App.tsx:195-275` の単一 effect を置き換える。既存の要件をすべて引き継ぐ:

- in-flight レスポンスが切替後の状態を上書きしないためのキャンセル（`fe53249` の回帰）
- stale surface エラーの 1 回だけ resync（サーフェスごとに持つ）
- ピン留め中のみ scrollback 取得（前面のみ）
- `visibilitychange` / `pageshow` / `focus` での即時再取得（E4）

```ts
export interface TerminalFeed {
  grid: RenderGrid | null
  history: string
  updatedAt: number | null
  activity: boolean       // 前面を離れてから内容が変化した
  status: FeedStatus      // D3.1
  source: FeedSource      // D3.1。表示ケースは (status, source) の組で決まる
  epoch: number           // 昇格ごとに単調増加。応答の適用可否判定に使う（D3.1 F1〜F9）
  promotedAt: number      // 最後に昇格した時刻。表示とログ用（判定には epoch を使う）
}
```

### 変更するモジュール

| ファイル | 変更 |
|---|---|
| `hooks/useCmux.ts` | `selectWorkspace` を公開 API から削除し `currentWorkspace` を `foregroundWorkspaceRef` からの導出値にする（D1/D2）。`listSurfaces()` を全ワークスペース取得に。`createSurface` は `workspace_id` 指定 + レスポンスから新 ref を取得（P7/P9）し、返り値の `workspace_id` を検証（P8）。**`createWorkspace` を D1.1 の 3 手順（create → 共通 refresh を 1 回 → その適用を await して `selectSurface`）に置き換える**。**D2.1 の topology 再取得ループ**（T1〜T5、queued refresh 1 件、dirty は取得開始前に消費、適用した snapshot（`{ generation, surfaces, workspaces }`）を返す `requestTopologyRefresh()`、waiter は要求 seq で照合）を持つ。**`SwitcherState` を `useReducer` で保持し、`selectSurface` / `initializeFrom` / `reconcileWith` だけを公開する**（`focus` は公開しない） |
| `App.tsx` | 単数スカラー（`termGrid`/`termHistory`/`lastUpdated`）を `useTerminalFeeds` に委譲。前面フィードだけを `Terminal` に渡す。browser 分岐は現行維持（D5）。D3.1 の 5 表示ケースを `(status, source)` から選ぶ |
| `components/TabBar.tsx` | 全サーフェスを描画。WS 色ドット、購読ドット、WS 境界の区切り線。`×` の意味は据え置き |
| `components/Drawer.tsx` | ワークスペース行を展開可能にし、配下にサーフェス行を出す。購読ドットを揃える |
| `components/Header.tsx` | `ワークスペース名 · 端末名` の 1 行 2 要素表示。D3.1 の `freshness` を `ConnectionIndicator` へ渡す |
| `components/ConnectionIndicator.tsx` | `lastUpdated?: number \| null` を **`freshness: string \| null`** に変える。現行は「切断中にいつの内容か」しか出せないが、D3.1 は connected 中も「更新: HH:MM:SS」「オフライン時点の内容 · 最終 HH:MM」を出す。時刻の整形は D3.1 の selector に一本化する |
| `lib/surface-cache.ts` | C1〜C6（前面のみ / 変化時のみ / Quota の反復退避 / 件数の二次ガード / **C5 `TextEncoder` 実バイト数での entry 上限と `scrollback`→`text`→`grid` の段階的な切り詰め** / **C6 メモリと localStorage で更新契機を分ける**） |
| `hooks/useWebSocket.ts` / `hooks/useCmux.ts` | D10 の 4 点すべて。切断時の全件 reject、**アンマウント時の同じ後始末とポーリング `setTimeout` の全 clear**、reject 後の遅延応答の破棄、**`send` を成否が分かる契約に変えて切断中の新規 RPC を即 reject** |
| `apps/server/src/ws.ts` | `FlatSurface` に `workspace_ref` / `workspace_title` / `workspace_id` を追加し、**`system.tree` の `result.active` から `active` フラグを載せる**（D7）。**`surface.create` に注入している既定を `focus: true` から `focus: false` へ変える**（D6.1） |
| `CLAUDE.md` | 誤った制約の記述を訂正（D11 / UR6） |

`lib/selection.ts` は**変更しない**が、`initialize` からは**使わない**。
`resolveSelectedRef` の `isActive` 述語に `s.selected` を渡すと、全ワークスペースを平坦化した
一覧では複数が真になり得て誤選択する。`initialize` は `s.active`（D7 で追加する単一フラグ）を
直接見る。`resolveSelectedRef` は `listWorkspaces` / `listPanes` の既存 2 経路で使われ続けるので、
既存の 5 ケースの回帰は壊さない。

`lib/render-grid.ts` / `lib/scrollback.ts` / `lib/scroll-intent.ts` / `lib/terminal-*.ts` は
サーフェス非依存なので変更しない。

## 7. エラー処理

| 事象 | 扱い |
|---|---|
| 背面サーフェスの取得失敗 | そのフィードの `status` を `error` にしタブのドットを警告色に。前面の表示には影響させない |
| 背面が stale（別ウィンドウで閉じられた） | 1 回だけ `listSurfaces` で再取得し、`reconcile` で購読集合から外す |
| 前面が stale | `reconcile` の退避順（D3）で生きたサーフェスへ移る |
| `surface.create` のレスポンスの `workspace_id` が要求と違う | P8 の黙殺ケース、および「対象ワークスペースが直前に閉じられた」通常の競合でも起きる。**端末は残し**、「別のワークスペースに作成されました」を表示して前面化する。自動 rollback（`surface.close`）はしない — ユーザーが意図して作った端末を黙って消す方が損失が大きく、誤配置は `surface.move` で直せるため。この UX を受入条件とする |
| WS 切断 | pending RPC を即時 reject（D10）。全ポーリング停止。各フィードは直近値を保持したまま表示。再接続後の最初のポーリングで復帰 |
| localStorage クォータ超過 | C3 の反復退避。候補が尽きたら諦める |

## 8. テスト方針と成果物

既存の 3 層構成（`lib/` 純粋関数 → hooks/components 配線 → サーバーのワイヤ形式）に従う。

**新規**

- `lib/__tests__/view-state.test.ts` — 4 つの遷移関数に加えて、**不変条件 I1〜I6 を各遷移の事後条件として検証する**。
  とくに「前面タブの端末が閉じられた」「LRU で追い出された」「reconcile で消えた」「ディープリンクが割り込んだ」
  が連続したときに I1・I2 が保たれること（**browser を前面化しても I2 が破れないこと**を含む）。
  D3 の決定順と退避順を表のケースごとに固定し、**terminal の前面消滅 / browser の前面消滅 /
  `surface.move` による ref 振り直し**の 3 ケースで退避順 2 が
  `foregroundWorkspaceRef` から正しく計算されることを固定する。
  **`initialize` が作る購読集合が「terminal の前面 1 件」または空であること**（D6）、
  **`cap` を小さくして `focus` した後、`reconcile` / `initialize` / `pollPlan` がその上限を保存すること**
  — とくに **`reconcile` が購読集合を空にしてから terminal を 1 件足す経路**と
  **`initialize` の 1 件**で上限を超えないこと（I5 は「直近の `focus` に渡した `cap`」に対する事後条件）。
  `promote`（F1〜F3）の分岐を `source` ごとに固定する
- `hooks/__tests__/useTerminalFeeds.test.ts` — サーフェスごとに正しい `surface_id` で `terminal.replay` が飛ぶこと、
  切替時に in-flight が新前面を上書きしないこと、背面では scrollback を取らないこと、
  非購読と browser には一度も投げないこと、**hidden 中は RPC が 0 件**であること（E4）、
  **同一サーフェスの in-flight が 1 件を超えないこと**（E2）。`vi.useFakeTimers()` を使う
- `components/__tests__/TabBar.test.tsx` — 現在テストが無い。全サーフェスの描画、
  購読中/非購読のドット出し分け（UR2 の回帰ガード）、browser にドットを出さないこと、
  WS 境界の区切り、切替、`×`、**前面変化でアクティブタブが `scrollIntoView` されること**、
  **`aria-label` が購読状態に加えてワークスペース名を含むこと**（別ワークスペースの同名端末が
  accessible name で区別できること）、**browser タブが「購読対象外」と読み上げられること**
- D3.1 の 5 ケース（`live`/`memory` / `warming`/`memory` / `warming`/`cache` / `loading`/`none` / `error`）を
  `useTerminalFeeds` と `Terminal` の両方でテストする。とくに**初見で前の端末の画面が残らないこと**
- **D3.1 の状態遷移 F1〜F10 を固定する**（`promote` は `lib/__tests__/view-state.test.ts`、
  取得側は `useTerminalFeeds`）:
  `warming -> live`（昇格後の初回成功）、`warming -> error` と `loading -> error`（初回失敗）、
  **すでに `live` の背面を前面化しても `warming` へ戻らないこと**（F4）、
  **追い出し → 再昇格で `epoch` が進み、昇格前に開始した RPC の遅延応答が破棄されること**（F7。
  時刻比較では通ってしまうケースをテストで作る）、WS 切断で全 feed が `error` になりフレームは残ること（F8）、
  再接続で購読中の全 feed が昇格からやり直されること（F9）、
  **F10 が `status` と `source` を変えないこと**、**各昇格で `promotedAt` も更新されること**、
  **`F2 -> F10 -> 再昇格` で `source` が `'cache'` のまま維持され、初回成功まで `memory` に化けないこと**
  （`epoch` / `promotedAt` は更新される）、
  **`F5n -> F10 -> 再昇格` と `F5n -> F8 -> F9` がどちらも F3 に入り、残っている localStorage
  スナップショットを同一セッションでは再利用しないこと**、
  **F5n が `grid` と `history` の両方を捨てること**、
  **F5n（成功だが `render_grid` が `null`）で `live`/`none` になりフレームが捨てられること**、
  および **`error`/`none` で `updatedAt` が無いとき鮮度ラベルが「接続なし」だけになること**
- **合成 reducer の原子性と `added` 規則**（`lib/__tests__/view-state.test.ts` の `createSwitcherReducer`
  と、`useCmux` の結合テストの両方）— D3.1 の受入条件 1〜5 をそのままテスト名にする:
  `retained memory` / `cache` / `none` の 3 入力で**最初のコミットが
  `warming/memory` / `warming/cache` / `loading/none` であり中間コミットが無いこと**、
  **すでに `live/memory` の購読中 terminal を前面化しても `feeds` と `epoch` が不変であること**（F4）、
  **browser を前面化しても `feeds` が不変であること**（D5）、
  **`initialize` の最初の terminal に F2/F3 が適用されること**、
  **購読集合が空の状態からの `reconcile` の退避先 terminal に F1〜F3 が適用されること**、
  **`reconcile` が購読を削るだけのときは `feeds` が不変であること**。
  あわせて **`focus` / `promote` が hook の公開 API に出ていないこと**

**拡張**

- `lib/__tests__/surface-cache.test.ts` — C2（変化時のみ書く）、C3（Quota で複数件退避して成功する / 候補が尽きたら諦める）、C4、
  C5（**`TextEncoder` の実バイト数で測ること**を CJK を含む入力で固定し、`scrollback` を削って収まる /
  `text` まで削って収まる / **`grid` だけでも超えるので entry を保存しない**の全段階）、
  C6（背面は書かない・書き込み回数を数える）
- `hooks/__tests__/useCmux.test.ts` — **`workspace.select` が一度も飛ばないこと**（D1 の回帰ガード）。
  `createSurface` が `workspace_id` を渡し、レスポンスから ref を取り、`workspace_id` 不一致を検出すること。
  既存の「`surface_id` を使い `surface_ref` を使わない」ガード（`useCmux.test.ts:44-57`）を複数端末版に拡張。
  **D1.1 の 3 条件**: `surface.create` と `workspace.select` が 0 回であること、`workspace.create` が返した
  surface が PWA の前面になること、surface/workspace 両方の一覧が更新されること（1 本の hook テストで固定する）。
  あわせて **step 2 が共通 refresh 経路を 1 回だけ呼ぶこと**（refresh 要求数を数えて二重取得が無いことを固定）、
  **`workspace.create` 直後の T3 が既存の T5 in-flight と衝突しても、step 3 が作成後のスナップショットを見ること**、
  **返った `surface_ref` が再取得した一覧に無い場合は前面を変えずエラーにもしないこと**、
  **step 3 が `focus` ではなく `selectSurface` を通ること**。
  **D10 の 4 ケース**: 切断時の既存 pending が 10 秒を待たず reject されること、**切断中に新しく呼んだ RPC が
  即 reject されること**、**アンマウントで pending と全ポーリング `setTimeout` が片付くこと**、
  **reject 後に遅れて届いた応答が破棄されること**。
  **D2.1 の topology 再取得**: T1〜T5 それぞれが再取得を起こすこと、in-flight 中は重ねて投げないこと（single-flight）、
  **in-flight 中に T1〜T4 が何回来ても queued refresh は 1 件までであること**、
  **その follow-up の実行中にさらに T3 を発火するともう 1 回走ること**（dirty を開始前に消費する規則）、
  **`requestTopologyRefresh()` が「自分の要求を包含する refresh の適用」まで resolve しないこと**
  （既存 in-flight の完了で resolve しないこと。`generation` で検証する）、
  `hidden` 中は止まること、
  **失敗しても既存の一覧を捨てないこと**、外部での create/close/`surface.move` が一覧に反映されること、
  **`closeWorkspace` の後にサーフェス一覧も `reconcile` されること**
- `components/__tests__/Drawer.test.tsx` — ワークスペース行の展開、サーフェス行タップでの前面化
- `apps/server/src/__tests__/ws.test.ts` — `flattenSurfaces` がワークスペース属性を付けること、
  フィルタ省略時に全ワークスペースを返すこと、browser サーフェスの `url` が保持されること、
  **`active === true` が全サーフェス中で高々 1 件であること**（D7。`selected` が複数真になる
  既存フィクスチャ `ws.test.ts:76,80` を入力にして固定する）、
  **`surface.create` に注入する既定が `focus: false` であること**（D6.1 の回帰ガード）

**変更しないと明示的に決めたもの**

- `components/__tests__/Terminal.test.tsx` — `resetKey` でピン留めがリセットされる既存の期待値は**維持する**。
  タブを行き来してもスクロール位置は復元せず、毎回最下部に戻る。端末ごとのピン留め保持は範囲外（§9）。
  実装時にここが落ちたら設計から外れた副作用である

**成果物: 再現可能なプローブスクリプト**（round 1 レビュー P2-3 への対応）

`scripts/cmux-probe.mjs` を追加する。既定は **read-only** で、次を出力する。

- `system.capabilities` の `protocol` / `version` / `access_mode` / メソッド数とハッシュ
- 選択 / 非選択ワークスペースそれぞれのサーフェスに対する `terminal.replay` と `surface.read_text` の成否
- **negative control**: `surface_ref` 指定が別サーフェスの内容を返すこと（フォールバックの検出）
- 短縮 ref と UUID の両方での結果
- ローカルフォーカスが前後で変わっていないこと
- §3.5 と同じ負荷測定（クライアント数を引数で指定）

書き込み系（`send_text` / `create` / `move`）は `--write` を明示したときだけ実行し、
**専用の使い捨てサーフェスに対してのみ**行い、必ずクローズする。
cmux を更新したらこれを流し、CLAUDE.md の記述と食い違わないかを確認する。

検証コマンドは `pnpm check`（tsc + biome）と `pnpm test`。

## 9. 非目標

- 分割ビュー / 同時複数表示（UR5・D9。基盤だけ用意する）
- 端末ごとのピン留め・スクロール位置の保持
- サーバーの UDS 多重化（2 クライアントまでは不要。D6 に手段と実測値を記録）
- ペインを操作する UI（現行どおりタブの区切り線としてのみ表現）
- 複数の cmux インスタンスへの接続
- Web Push のディープリンクを端末単位にすること（D1 の表）
- `mobile.*` API への移行（§3.4。browser サーフェスを失うため）

## 10. リスクと未解決

| # | 内容 | 対応 |
|---|---|---|
| R1 | 端末が 30 個ある環境ではタブ行が長大になる | ドロワーの一覧（5.2）がジャンプ手段。検索やフィルタは必要になってから |
| R2 | 実測は 1 つの cmux ビルドでのもの。将来の更新で前提が崩れる | §8 のプローブスクリプトを残し、CLAUDE.md から参照する（D11） |
| R3 | 3 クライアント同時で前面 p95 が 1 秒を超える | D6 に安全域（2 台）と 3 つの緩和策を明記。今回は実装しない。上限変更前に再測定を必須とする。**4 台目を自動検知して自動縮退する仕組みは入れない**（検知手段が無く、入れると複雑さに見合わない） |
| R4 | activity 判定は grid の比較で行うため、カーソル点滅だけでも変化と見なす可能性 | 比較対象から `cursor` を除いた `lines` のみをハッシュする |
| R5 | 通知タップはワークスペース単位のまま | 範囲外（D1 の表） |
| R6 | タブ行の並びが `system.tree` 順のため並べ替えられない | 範囲外。cmux 側の並びと一致している方が混乱が少ない。`surface.reorder` は存在するが cmux 本体の並びを変えるため使わない |
| R7 | iPhone 実機での CPU / 電池 / WS 転送量は未測定。§3.5 は Mac 側の UDS 占有のみ | 実装後に実機で前面 1Hz の体感と発熱を確認する。悪ければ `BACKGROUND_POLL_INTERVAL` を伸ばす（設定値の変更だけで済む） |
| R8 | `focus:false` に変えると、`+` で作った端末が Mac 側で自動的に開かなくなる | UR4 の方針そのものであり意図した変更。CLAUDE.md に記録する |
| R9 | **§4 D3.1 の合成 reducer（`createSwitcherReducer`）と D2.1 の `generation` 契約は、レビューを受けていない**（下記） | 実装時にここが最初の検証対象になる。§8 の該当テストを**先に**書いてから実装する |

### レビューの到達点（記録）

design review（codex / gpt-5.6-sol / xhigh）を **point=spec で 5 ラウンド**行った。これが運用上の上限である。

| round | 対象 | 結果 |
|---|---|---|
| 1 | `9912285` / `fb8a95f` | needs_work |
| 2 | `60efccc` | needs_work（P1 6 / P2 6） |
| 3 | `3368e8f` | needs_work（P1 3 / P2 6） |
| 4 | `d13d3fe` | needs_work（**P1 0** / P2 5。「次ラウンドで approve 可能な範囲」との評価） |
| 5 | `0e3779a` | needs_work（P1 1 / P2 3） |

**round 5 の P1 は round 4 の修正で持ち込んだ自己矛盾だった。** 原子性のために導入した
`selectSurface` が `focus` と `promote` を別々の setter で呼ぶ形だったため、`promote` に
変更前の `subscriptions` が届かず、「すでに購読中か」を判定できずに **F4 を必ず破る**
（および browser・`initialize`・`reconcile` を表現できない）というものである。

この指摘は妥当だったので、**`ViewState` と feed を 1 つの合成状態にして 1 つの reducer で動かし、
「F1〜F3 を適用するのは `subscriptions` に新しく加わった ref だけ」という 1 行の規則**に
置き換えた。round 5 の P2 3 件（F5n 後の cache 再利用条件、I5 の証明、共通 refresh の
`generation` 契約）も同時に反映している。

**ただしこの反映自体は 5 ラウンドの上限に達した後の変更であり、レビューを受けていない。**
実装に入る前提としてこの事実を記録しておく。plan フェーズと code review で拾う。

## 付録 A. プローブの記録

socket: `~/.local/state/cmux/last-socket-path` が指す先（実測時 `/Users/yui/.local/state/cmux/cmux-501.sock`）

**接続先の同定**（`system.capabilities`）:
`{"protocol":"cmux-socket","version":2,"access_mode":"allowAll"}`、メソッド数 303。
`surface.*` 28 / `workspace.*` 50 / `pane.*` 9 / `terminal.*` 5 / `window.*` 7 / `system.*` 6。
`system.version` と `system.info` は `method_not_found`。

**`system.tree` の構造**: windows → workspaces → panes → surfaces の 4 階層。
workspace は `ref` / `id` / `title` / `selected` / `pinned` / `index` / `panes`、
surface は `ref` / `id` / `title` / `type` / `selected` / `selected_in_pane` / `focused` /
`pane_ref` / `pane_id` / `index` / `index_in_pane` / `tty` / `url`。
`result.active` に現在の `workspace_ref` / `surface_ref` / `pane_ref` などが入る。

**作成先指定（P6〜P10）の実出力**:

```
surface.create workspace_ref=<非選択WSの短縮ref>  -> 選択中WSに作られた（無視）
surface.create workspace_id=BOGUS-NOT-A-UUID     -> エラーなし。選択中WSに作られた
surface.create workspace_id=<非選択WSのUUID>      -> ★ 対象WSに作られた
  response: {"surface_id":"...","surface_ref":"surface:118","workspace_id":"C459840B-...",
             "workspace_ref":"workspace:1","pane_id":"...","pane_ref":"pane:1","type":"terminal"}
surface.move surface_id=<UUID> workspace_id=<UUID> -> ★ 目的地に到達（ref は振り直される）
terminal.create workspace_id=BOGUS -> invalid_params "Missing or invalid workspace_id"
pane.create     workspace_id=BOGUS -> invalid_params "Missing or invalid direction (left|right|up|down)"
```

**`focus` が cmux の選択を奪うか（P13。D6.1 の根拠）**:

入力は 3 つで、いずれも非選択ワークスペースを対象にした。A はサーバーが現在注入している
payload（`ws.ts:104-107`）そのものである。各手順の後に 1 秒待ってから `system.tree` の
`result.active` を読んだ。

```
active BEFORE:  workspace_ref=workspace:26  surface_ref=surface:98

A) surface.create { type:'terminal', focus:true,  workspace_id:<非選択WSのUUID> }
   -> create OK
   active AFTER: workspace_ref=workspace:1   surface_ref=surface:1
   => ★ 選択が動いた。focus:true は cmux の選択を奪う

B) surface.create { type:'terminal', focus:false, workspace_id:<同じ非選択WS> }
   -> create OK
   active AFTER: workspace_ref=workspace:1   surface_ref=surface:1   （A の後から不変）
   => 選択は動かない

C) workspace.create {}
   response keys: window_ref, window_id, group_ref, group_id,
                  workspace_ref, workspace_id, surface_ref, surface_id
   => 新ワークスペース配下の surface 数 = 1（既定端末が 1 つ含まれる）
   => 新ワークスペースは selected=false
   => レスポンスに type は含まれない  ← D1.1 が一覧を引き直す理由
```

作成した 2 サーフェスと 1 ワークスペースは同じ実行の `finally` で `surface.close` /
`workspace.close` して片付けた。

この 3 つを流したスクリプトは `probe13.mjs` として保全してあり
（`/private/tmp/claude-501/multi-terminal-switch-handoff/probe13.mjs`）、
§8 の `scripts/cmux-probe.mjs --write` に取り込む。**raw stdout そのものは、この直後に起きた
macOS TCC の障害（`~/Documents` 全体が EPERM）とセッション再起動で失われている。**
上の値は障害前に記録した観測値である。再取得したい場合は上記スクリプトを流し直せばよい
（選択を動かすので、実行後は `restore.mjs` で戻すこと）。

**ref 安定性（P11/P12）**: 他ワークスペースでの作成・削除に対し既存 32 サーフェスの ref は 32/32 不変。
`surface.move` されたサーフェス自身の ref のみ振り直される。

**負荷測定（§3.5）**: 前面 1 本を 1Hz（`replay` + `read_text(2000行)`）、背面 7 本を 3 秒間隔（`replay`）、
背面は 400ms ずつずらす。各 15 秒。数値は本文 §3.5 の表を参照。

**書き込み検証の作法**: `send_text` の検証は自分で作った使い捨てサーフェスに対してのみ行い、
検証後に必ずクローズする。ワークスペースの選択を一時的に動かした場合は必ず元へ戻す。
本 spec の作成中に作った使い捨てサーフェスはすべてクローズ済みで、選択ワークスペースも復元済みである。
