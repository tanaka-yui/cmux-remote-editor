# plan review round 3 — multi-terminal-switch

対象: `docs/superpowers/plans/2026-09-03-multi-terminal-switch.md` @ `811ddb7`

## Summary

- P1: 5 件
- P2: 3 件
- round 2 で問題になった generation ベースの到達不能 waiter は、`requestSeqRef` / `servedUpTo` に分離したことで、通常の「先行失敗 → follow-up 成功/失敗」の連鎖については解消している。
- ただし、Task 6 の中間コミットが実際には green にならないこと、hidden 契約、切替中の feed 判定、Push 通知経路に実装を誤らせる契約が残っているため、このまま別セッションへは渡せない。

## P1（実装を止めるべき）

### P1-1: Task 6 の shim 移行は、現行の依存箇所を閉じておらず `pnpm check && pnpm test` を通せない

plan は `selectWorkspace` を Task 6 で削除する一方、`navigate*` は Task 11 まで触らないとしている（plan:1715-1723）。しかし現行 `useCmux.ts:283-292` の `navigateWorkspace` は `selectWorkspace` を直接参照しているため、指示どおりでは未定義参照になる。

また「同時に直す 3 箇所」の列挙は spec と一致していない。plan:1716-1718 は drawer / `createWorkspace` / `closeWorkspace` を挙げるが、spec §4 D1 が挙げる 3 番目は Push 通知の `?workspace=<id>` であり、現行 `App.tsx:345` にまだ `selectWorkspace` 呼び出しがある。`closeWorkspace` は呼び出し元ではなく hook 内の別処理である。

さらに plan:2012 付近で `listSurfaces` を引数なしへ変えるのに、現行 `App.tsx:157,244` は `listSurfaces(currentWorkspace)` を呼ぶ。既存 `App.test.tsx` はむしろ「必ず workspace ref 付き」を期待しており、Task 6 の Files / `git add` に `App.test.tsx` が無い。Drawer も現行 prop 名は `onSelect` なのに plan:1674 は存在しない `onSelectWorkspace` の削除としており、既存 `Drawer.test.tsx` は `onSelect` を渡し続けるが Task 6 の変更対象に入っていない。

Task 6 で少なくとも次を同時に閉じる必要がある。

- `navigateWorkspace` を新しい `selectSurface` ベースへ移すか、呼び出し元と一緒に Task 6 で削除する。
- Push/ディープリンクの `selectWorkspace` 経路を、その時点でコンパイル可能な新経路へ移す。
- App の 2 箇所の `listSurfaces` 呼び出しと初期取得 effect を全 surface 契約へ直す。
- `App.test.tsx` / `Drawer.test.tsx` を Task 6 の Files と commit に含め、旧期待値・旧 props を同じコミットで更新する。

### P1-2: topology の hidden 停止はタイマーにしか効かず、T3/T4 と dirty follow-up が hidden 中にも RPC を投げる

plan:2152 は topology に E4 の「hidden 停止」を適用するとしているが、`runRefresh` は各サイクルの開始前に visibility を確認せず、そのまま `fetchTopology()` を呼ぶ（plan:2553-2566）。`requestTopologyRefresh` も hidden を確認せず即 `runRefresh` する（plan:2603-2612）。このため hidden 中の T3/T4 は `surface.list` / `workspace.list` を送る。

さらに、先行サイクルの in-flight 中に dirty が立ち、その応答が hidden で破棄された場合、plan:2580-2582 で先行 waiter を reject した直後、plan:2591 の dirty 判定で次ループへ入り、hidden のまま follow-up の 2 RPC を開始する。追加されたテストは T5 タイマー停止と「遅延成功を反映しない」だけで、この経路を検出しない。

hidden 中に入った明示要求を「復帰まで dirty + waiter として保持する」か「RPC を出さず即 reject して T2 に委ねる」かを契約として決め、`runRefresh` の入口と各 follow-up 開始前に適用する必要がある。最低でも以下をテストすること。

- hidden 中の直接 `requestTopologyRefresh()` が RPC を 0 件に保つ。
- in-flight 中に dirty → hidden → 先行応答完了でも、復帰までは follow-up を開始しない。
- 採用した方針に従って waiter が復帰後 resolve、または即 reject し、残留しない。

### P1-3: `useTerminalFeeds` が開始時点の foreground を await 後にも使い、切替後の背面へ `read_text` と localStorage 書き込みを行う

`cycle` は `p = latest.current` と `isVisible` を `readGrid` の前に固定し（plan:3509-3514）、応答後もその古い `isVisible` で cache 保存と `readText` 開始を決めている（plan:3524-3538）。したがって A が前面のときに replay を開始し、待機中に購読済み B へ切り替えると、A の replay が返った時点では A は背面なのに A の scrollback RPC を新規発行し、C1 の「前面のみ」localStorage 書き込みも行う。`readText` 後のガードも pinned と hidden しか見ず、A がなお前面かは確認しない（plan:3542-3547）。これは「背面では scrollback を取らない」と C1/C6 の両方に反する。

また catch は `stopped` しか確認しない（plan:3549-3560）ため、取得待機中に hidden になってから返った rejection は hidden 中に `applyFeedError` と T4 topology refresh を発火する。P1-2 と合成すると hidden 中の topology RPC にもつながる。

意図的に開始時点で固定するのは `epoch` だけにし、各 await の後で `latest.current.visibleRefs` / `pinned` / visibility を読み直す必要がある。deferred `readGrid` の途中で前面を切り替えたとき旧 ref の `readText` と保存が 0 件であるテスト、および hidden 後の遅延 reject が feed/T4 を更新しないテストを追加すること。

### P1-4: Push 通知ジャンプの識別子と遷移関数が誤っており、実際の通知で動かないか購読集合を破壊する

spec §4 D1 は Web Push が渡す値を `workspace_id` と明記しており、現行コードも `workspaces.find(w => w.id === workspaceId)` で UUID から workspace を解決している。一方 Task 11 のテストは `?workspace=workspace:26` という **workspace ref** を入れている（plan:4146-4152）。このテストに合わせて `workspace_ref` を検索すると、実際の Push payload の UUID ではジャンプできない。

加えて plan:4171 は初回 URL と実行中に届く SW `postMessage` をまとめて `initializeFrom` に渡すよう読める。しかし `initialize` は購読集合を「選んだ 1 件だけ」に作り直すため、実行中の通知ジャンプに使うと、それまでのバックグラウンド購読をすべて落とす。spec の「購読中があればそれを選ぶ」は、対象 surface を決めた後に `selectSurface(surface)` して既存購読を保存する経路である。

初回 bootstrap と実行中メッセージを分け、次を明記・テストする必要がある。

- `?workspace=<UUID>` / SW の `workspaceId=<UUID>` は `Workspace.id` で workspace を引く。
- 初回 URL は preferred surface ref を 1 件作って `initializeFrom` へ渡す。
- マウント後の SW message は対象 `Surface` を `selectSurface` へ渡し、既存 subscriptions を保持する。
- Task 6 で旧 `selectWorkspace` を消す時点からこの経路がコンパイル可能である。

### P1-5: 後半タスクにも、提示コードのままでは strict TypeScript / ファイル境界を通らない箇所が残る

「全 12 タスクで `pnpm check && pnpm test`」という checkpoint に対し、少なくとも以下が未解決である。

- Task 8 の `UseTerminalFeedsProps` は `TopologySnapshot` を参照する（plan:3462）が、提示 import 群に `import type { TopologySnapshot } from './useCmux'` が無い。Task 7 のテスト側で使う `TopologySnapshot` の import も手順に無い。
- Task 10 の最初のテストは `const onSelectWorkspace = vi.fn()` を宣言したまま渡しも検証もしない（plan:3887-3894）。`noUnusedLocals: true` なので `pnpm check` で止まり、そもそも「RPC を投げない」をテストしていない。
- `describeFeed` は `null` を返し得る型なのに、Task 11 のテストは narrowing なしで `d.kind` / `d.freshness` / `d.message` を読む（plan:4000-4037）。strict null check で止まる。
- Task 11 は `freshness` を `ConnectionIndicator` の隣へ出すとしている（plan:4167）が、Task 10 が定める `Header` interface に freshness/slot が無く、Task 11 の Files と `git add` は `App.tsx` とそのテストだけである。現行 `ConnectionIndicator` の `lastUpdated` は connected 時の `更新:` / `オフライン時点` を表せないため、`Header.tsx`（または `ConnectionIndicator.tsx`）の契約・テスト・commit 対象を追加しないと 5 ケースを実装できない。

各タスクの Files / imports / test code / `git add` を実際の strict 設定に合わせて閉じてから、個別 green を受入条件にする必要がある。

## P2（改善が望ましい）

### P2-1: `Promise.all` の fail-fast で片方の list RPC が残り、失敗後の follow-up と重なり得る

`fetchTopology` は 2 RPC を `Promise.all` している（plan:2544-2551）。例えば `surface.list` が先に reject し `workspace.list` がまだ pending の場合、サイクルは失敗完了扱いになり、dirty なら次の 2 RPC を開始する。この時点で前サイクルの `workspace.list` と follow-up の `workspace.list` が同時 in-flight になり、E2 の「topology in-flight 1 件」の実体が崩れる。

1 サイクルは両 RPC が settle するまで完了させない（例: 両結果を待って、どちらか失敗なら全体失敗）か、残った RPC を安全に cancel できる契約にするのがよい。片方を gate したまま他方を先に失敗させ、前者が settle するまで follow-up の同 method が始まらないテストがあると固定できる。

### P2-2: `retained memory` の atomic 結合テストが実際には追い出し／再昇格を作っていない

plan:1880 付近の `retained memory` テストは surface が 2 件だけで、公開 `selectSurface` は cap=8 固定なので surface:1 は追い出されない。そのため最後の期待値も `['live', 'warming']` のどちらでもよいとしており、F1 の「再昇格した最初の commit が warming/memory」を検証していない。

9 件目の terminal を選んで確実に対象を追い出すなど、公開経路だけで `subscriptions` から外れた retained feed を作り、再選択後の最初の render を **warming/memory のみに**固定するべきである。

### P2-3: spec と plan で `requestTopologyRefresh` の公開契約が異なる

spec §4 D2.1 / §6 は `Promise<number>` と generation 照合のままだが、plan は正当な理由で `Promise<TopologySnapshot>` + request seq に変更している（plan:2123-2140）。実装者には spec と plan の両方を渡す前提なので、どちらが正かで判断を止めないよう spec 側も同期するか、plan 冒頭にこの点は plan が supersede すると明記するのがよい。

VERDICT: needs_work
