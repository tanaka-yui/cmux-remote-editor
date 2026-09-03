# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

cmux のリモートターミナルビューア。iPhone 等のブラウザ/PWA から、ローカルで動く cmux を閲覧・操作する。pnpm workspace + Turborepo のモノレポで、`apps/server`（Bun + Hono のブリッジサーバー）と `apps/client`（React 19 + Vite PWA、UI は radix-ui プリミティブ＋lucide-react、CSS 変数テーマで system/light/dark 対応）の 2 パッケージ構成。

## コマンド

```bash
pnpm install
pnpm dev          # turbo: サーバー(bun --watch, :48701) + クライアント(vite, :5173) 同時起動
pnpm build        # turbo run build
pnpm test         # turbo: サーバー(bun test) + クライアント(vitest)。test は build に依存
pnpm check        # tsc --noEmit + biome check（両パッケージ）
pnpm check:fix    # biome check --write
pnpm lint         # biome lint
```

単一テストの実行:

```bash
cd apps/server && bun test src/__tests__/auth.test.ts        # サーバー（bun test）
cd apps/client && pnpm vitest run src/lib/__tests__/cmux-rpc.test.ts  # クライアント（vitest）
```

運用（本番相当の常駐構成）:

```bash
pnpm bootstrap       # 初回のみ: install + build + cmux allowAll 設定 + docker compose build
pnpm start / stop    # サーバーをホスト常駐起動 + クライアント(nginx)を Docker 起動 / 両方停止
pnpm server:up|down|status|restart|logs   # launchd LaunchAgent 常駐の管理（ログ: apps/server/.run/server.log）
```

クライアントを更新した後の `pnpm start` はイメージを自動再ビルドする（以前は `pnpm bootstrap` が必要だった）。
デプロイは canonical checkout から行う。worktree には証明書がなく、compose project 名も異なる。

サーバーは LaunchAgent（`KeepAlive` + `RunAtLoad`）で常駐し、クラッシュ時は自動再起動、ログイン時は自動復帰する。`pnpm stop` / `pnpm server:down` は plist 削除まで行う完全解除で、Mac を再起動しても止まったまま。Mac 再起動後にスタック全体を自動復帰させるには Rancher Desktop のログイン時自動起動設定が別途必要（クライアント側の復帰は `restart: unless-stopped` が担う）。なお launchd 起動の bun が `~/Documents` 配下の WorkingDirectory を解決するには bun への Full Disk Access 付与が必要（システム設定 → プライバシーとセキュリティ。無いと起動が無言でハングする）。Homebrew で bun を更新すると Cellar パスが変わり許可が外れるため、更新後は再付与すること。

## アーキテクチャ

```
ブラウザ/PWA → nginx (Docker :48710 https / :48700 は https へ 301) → ブリッジサーバー (Bun, ホスト :48701 — 本番は HTTPS/WSS・127.0.0.1 束縛 / dev は HTTP) → cmux UDS (JSON-RPC)
```

TLS は nginx で終端する。証明書は mkcert 製（`pnpm certs:setup` → `certs/`、gitignore 済み、compose の volume で nginx にマウント）。**本番では Bun ブリッジも同じ証明書で TLS 終端する**（`CMUX_REMOTE_TLS=1` を `server:up` が付与、証明書パスは `CMUX_TLS_CERT`/`CMUX_TLS_KEY` で上書き可・既定は `certs/`）。Bun は `127.0.0.1` のみに束縛し（`CMUX_BIND_HOST` で上書き可・既定 loopback）LAN からの直接到達を遮断するため、nginx→Bun を含め平文区間は残らない。nginx は `proxy_pass https://host.docker.internal:48701` + `proxy_ssl_verify off`（mkcert に `host.docker.internal` SAN が無く、かつホスト内ホップのため検証なし＝機密性のみ確保）。**開発モード（`pnpm dev`）は `CMUX_REMOTE_TLS` 未設定で HTTP のまま**、nginx の代わりに Vite dev サーバー(:5173)が `/ws`・`/health` を :48701 にプロキシする。Docker(VM) が loopback の Bun に到達できない環境では `CMUX_BIND_HOST=0.0.0.0` にフォールバック（その場合も TLS は維持される）。

### 重要な制約: サーバーは Docker に入れられない

Rancher Desktop（Lima VM / virtiofs）は bind mount したホストの UNIX ソケットをファイルノードとしては見せるが、VM 境界を越えた connect() を中継しない（`Not supported`）。そのため cmux ソケットにはコンテナからどの設定でも到達できず（`allowAll` でも不可）、サーバーはホストで動かし、Docker は nginx クライアントのみ（`compose.yml` 参照）。調査記録は `docs/superpowers/specs/2026-08-11-server-launchd-design.md`。なお cmux 既定の `cmuxOnly` モードは「cmux の子孫プロセスのみ接続可」という PID 系譜チェックも行う。常駐デーモン運用には cmux を `allowAll` にする必要があり（`pnpm cmux:allow-automation`）、設定は cmux の再起動か Settings → Automation での切替で初めて反映される。開発時（`pnpm dev`）はサーバーが cmux 端末の子プロセスなので `cmuxOnly` のままで動く。

### サーバー (`apps/server/src/`)

- `index.ts` — エントリ。`Bun.serve` で WS upgrade（`/ws`、トークン必須）・Hono ルート（`/health`、クライアント静的配信）を振り分け。
- `ws.ts` — 中核。ブラウザ WS ⇄ cmux UDS の JSON-RPC 透過中継。WS 接続ごとに cmux への UDS 接続を 1 本張る。例外的に書き換える RPC が 2 つ:
  - `surface.list` → `system.tree` に変換し、応答を全ペインのサーフェスに平坦化して `{ surfaces }` に整形（ソケット側の `surface.list` は `workspace_ref` を無視するため）。
  - `surface.create` → `type: 'terminal', focus: false` のデフォルトを注入。
  - cmux ソケットが閉じたら WS を code 1011 で閉じ、クライアントの再接続にフォールバックさせる。
  - UDS 読み取りは **`createLineFramer`（`node:string_decoder` の `StringDecoder`）で UTF-8 安全に行フレーミングする** — `data.toString()` をチャンクごとに連結すると絵文字(4byte)/CJK(3byte) がチャンク境界で割れて U+FFFD（画面上「??」）に化けるため。`render_grid` の文字化けはまずここを疑う（[[server-utf8-chunk-framing]]）。
- `auth.ts` — WS 共有トークン。優先順: 環境変数 `CMUX_REMOTE_TOKEN`（`apps/server/.env` も Bun が自動読込）→ `apps/server/.run/token`（無ければ自動生成・永続化）。比較は `timingSafeEqual`。
- `socket-path.ts` — cmux ソケットパス解決。`CMUX_SOCKET_PATH` → `last-socket-path` ポインタファイル（XDG state / Application Support）→ 既定パスの順。
- `health.ts` — `GET /health`。cmux への接続を 1 本使い回す（ポーリングによる接続チャーン防止）。
- `push/` — Web Push 通知。WS 接続の有無に依らず動く**バックグラウンドポーラー**（`poller.ts`）が専用 cmux 接続（`rpc-connection.ts`、UTF-8 安全な `line-framer.ts` を共用）で `notification.list` を ~10秒間隔ポーリングし、**actionable（Needs input / Permission）かつ未送信の通知のみ**を `web-push`（VAPID）で各購読 endpoint へ送る。`filter.ts`（`isActionable`）/`payload.ts`/`store.ts`（購読・既送信 id を `.run/` に永続）/`send.ts`（410/404 で失効購読を掃除）/`vapid.ts`（`.run/push-vapid.json`）/`routes.ts`（`/push/vapid-public-key`・`/push/subscribe`・`/push/unsubscribe`、共有トークン `Authorization: Bearer` で保護）に分割。起動時に既存通知 id を seed して**バックログを一斉送信しない**。購読が 0 件ならポーラーは停止。env: `CMUX_PUSH_POLL_MS`（既定 10000）/`CMUX_PUSH_SUBJECT`。**dev は HTTP のため Web Push は動かない（secure context 必須）**。

### クライアント (`apps/client/src/`)

- `hooks/useCmux.ts` — 中核。WS 上に Promise ベースの RPC 層（pending Map + 10 秒タイムアウト）を構築し、workspace/pane/surface の状態と操作を提供。**タブ切替は PWA 側の表示のみ変更し、ローカル cmux のペインフォーカスは奪わない**（`surface.focus` RPC は使わない設計）。**ワークスペース切替は cmux 側の選択に一切触れない**（`workspace.select` を呼ばない）。非選択ワークスペースでも **`surface_id` 指定なら `read_text` / `terminal.replay` / `send_text` はすべて成功する**（実機プローブ済み。旧版の「非選択 WS は読めない」という記述は誤りだった）。`surface.create` は `workspace_ref` を**無視する**が **`workspace_id`（UUID）は効く**ので、対象ワークスペースへ直接作成できる。ただし**無効な `workspace_id` を渡してもエラーにならず選択中ワークスペースに作られる**ため、レスポンスの `workspace_id` を必ず検証すること。サーバーが `surface.create` に注入する既定は **`focus: false`**（`focus: true` は cmux の選択を奪う）。表示状態は `lib/view-state.ts` の `SwitcherState`（`ViewState` + `Map<surfaceRef, TerminalFeed>`）を 1 つの reducer で動かし、前面変更の入口は `selectSurface` / `initializeFrom` / `reconcileWith` の 3 つだけである。注意: cmux ソケットの surface 系 RPC（read_text/send_text/send_key/close）はパラメータ `surface_id` を読む。`surface_ref` は無視され、フォーカス中サーフェスへ暗黙にフォールバックする。`terminal.replay` の `render_grid` は `active_screen`（`'primary'` / `'alternate'`＝代替スクリーン）と `modes`（端末の DECSET モード状態 `{ code, ansi, on }[]`）も返す。**タップ→マウス送信の有効化は `modes` で判定する**: `1000`/`1002`/`1003`（マウストラッキング: クリック/ドラッグ/モーション報告）のいずれかが `on` なら端末がマウス入力を受け付ける状態、`1006` が `on` なら SGR 拡張座標形式（`\x1b[<Cb;Col;RowM`/`m`）。`active_screen='alternate'` 単独より正確で、マウス未設定の TUI（`mouse=` 無しの nvim や lazygit）への誤爆を避けられる。

- `lib/view-state.ts` — `SwitcherState` reducer が前面・購読集合・端末別 feed を一体で遷移させる。購読上限/LRU、キャッシュ昇格、activity、5 種類の表示説明をここで決め、grid 付きキャッシュの復元時は可視画面ぶんを scrollback 末尾から除く。
- `hooks/useTerminalFeeds.ts` — `pollPlan` に従って前面 1 秒・背面 3 秒の自己再帰ポーリングを所有する。epoch/plan/可視状態で遅延応答を破棄し、前面かつ最下部ピン留め中だけ scrollback を取得・永続化する。

cmux の挙動が変わったときに気づけるよう、`node scripts/cmux-probe.mjs` を流して
CLAUDE.md の記述と食い違わないかを確認する（書き込み系の検証は `--write`、
性能測定は `--load <クライアント数>`）。
- `components/Terminal.tsx` — `@wterm/react` でレンダリング。`useTerminalFeeds` が取得した可視グリッドとスクロールバックを props で受け取って表示。**スクロールはブラウザのネイティブに任せる**（react-swipeable/react-use は廃止）: wrapper を `overflow:auto` + `touch-action: pan-x pan-y` にして**一本指で縦横スクロール（慣性付き）**。**横スクロール範囲は `.wterm`(wterm ルート, `overflow:hidden`)に `width: max(100%, <実測content>px)` を与える** — `100%` でコンテナ(pane)を満たして**右に app 背景の隙間を作らず**、実コンテンツが pane を超えたら実測幅まで広げて横スクロール可能にする。wterm は height だけ明示固定し width 未指定（無指定だと wrapper 幅に張り付きクリップ）。**実コンテンツ幅は「末尾空白を除いた最右の文字位置」**を計測する（`measuredWidth`）— 端末は各行を `cols` 幅まで空白で埋めるため、行全体や `.term-grid`/`cols*ch` で測ると「内容より右の**空セル**」まで幅に含み、**grid が pane より広い**（デスクトップ cmux のペイン幅＞ビューアのペイン幅）と右に余白/横スクロールが出る。各テキストノードで末尾空白(`/\s+$/`)を除いた `Range` の `right`（`.term-grid` left 基準）の最大を採る（全角は実ジオメトリで正しく反映、`Range` はコンテナ幅非依存でフィードバック無し）。`MutationObserver`＋`requestAnimationFrame` で wterm の非同期再描画（`renderer.setup` の `innerHTML=''`→`setTimeout(0)+rAF`）を捉えて計測し、**allow-shrink** で現在画面にフィット。`span` の無い空フレームは無視（潰れ＝`scrollLeft` 左飛びチラつきを防止）、`fontSize` 変化で再計測、`grid=null`（履歴/プレーン）は計測しない。`max-content` 等の intrinsic 値は使わない（空フレームで潰れチラつくため。明示 px は潰れない）。**ターミナルフォントは `--term-font-family` に `'M PLUS 1 Code'`（`@fontsource/m-plus-1-code`, `main.tsx` で latin/japanese-400 を import・同梱）を最優先で指定する** — Menlo 等は CJK を持たずシステムフォールバック(Hiragino)の送り幅が **1.66:1** で、cmux が**全角=2セル**で配置した内容と px がズレて隔間/位置ズレが出る。M+ 1 Code は **CJK=2×Latin**（実測 `cjkPx/latinPx=2.0`）なので一致する。**ライブ描画は `lib/render-grid.ts` の `renderGridToAnsi` が `render_grid` を ANSI 化して wterm に書くが、span を絶対位置(`ESC[colH`)でなく「行ごとに span 間の隙間を空白で埋めて連続描画」する** — 絶対位置だと wterm コアの CJK セル勘定(width=1)と cmux(全角=2)の差で「全角の2セル目(継続セル)」が wterm 側で空セル=余分な空白になり隔間ズレが出る（フォントを 2× にしてもコアのセル勘定は変わらず残るため、この2点セットで初めて cmux と一致する）。タッチ操作は**一本指タップ=左クリック・二本指タップ=右クリック**（いずれも `mouseEnabled && useSgr && grid` 成立時のみ SGR 送信）。閾値超えの移動があれば「ドラッグ=スクロール」とみなしクリックは送らず `preventDefault` もしない（慣性維持）。タップ確定時のみ `preventDefault` で合成 click を抑止し、さらに `onReady` で **wterm の隠し `<textarea>` を `disabled` にして**フォーカス自体を無効化する（合成 click が漏れてもモバイル仮想キーボード表示と「off-screen textarea を見せようと wrapper が左端へスクロール」する副作用を断つ。`onData` は捨てるのでキーボードは元々無機能）。**二本指ピンチでフォント増減**（指間距離の変化を `PINCH_STEP_PX` 単位で蓄積、`InputBar` の A−/A＋ ボタンでも増減可）。`touch-action: pan-x pan-y` 下では二本指の中心移動はネイティブスクロールに乗るので、ピンチ（距離変化）とスクロール（中心移動）が共存する。**二本指パンの自前実装・スワイプタブ切替は廃止**（スクロールはネイティブ一本指、タブは `TabBar`）。**履歴モードは廃止（モードレス）。同一スクロールコンテナに「スクロールバック `<pre>`（プレーン・色なし）＋色付きライブグリッド」を常時縦積みし、上へのネイティブスクロールだけで過去へ遡れる。** 最下部ピン留め（wrapper 自身の `scroll` 監視で `isAtBottom`、`onPinnedChange` で App へ通知）中のみ `useTerminalFeeds` が `read_text(scrollback, lines=historyLines)` を取得して `<pre>` を更新し末尾へ追従。上へ遡っている間はフェッチ自体をスキップして表示据え置き（読んでいる行が流れない）、最下部復帰で次に成功したポーリングが追いつく。scrollback は末尾に可視画面を含むため `lib/scrollback.ts`（`visibleLineCount`＝grid の最終非空行+1、`stripVisibleScreen`。**`grid.rows` で削ると下部が空の端末で履歴を削りすぎる**）で画面ぶんを削って二重表示を防ぐ。`active_screen='alternate'`（TUI）中は `<pre>` 非表示＋フェッチ停止。サーフェス切替は `resetKey` でピン留めへリセット。タップ→セル座標変換は `<pre>` が上に積まれるため wrapper でなく `.wterm` の rect 基準。**プレーンテキスト（スクロールバック/オフライン）は wterm に書かず `<pre>`（同フォント・行高 1.2・`width:max-content`）へ全行直描画する（grid が無いときは wterm を `display:none`）** — wterm の WASM コアはスクロールバックを **1000 行でハードコード頭打ち**（変更 API なし）にするため、wterm に流すと設定の履歴バッファ（`historyLines`）を 1000 超に上げても遡れる範囲が変わらない。純粋ロジックは `lib/multitouch.ts`（`centroid`/`isTap`）・`lib/sgr-mouse.ts`（`encodeClick`）・`lib/terminal-coords.ts`（座標変換）・`lib/mouse-mode.ts`（`modes` 判定）・`lib/terminal-keys.ts`（特殊キー→生シーケンス）・`lib/scroll-intent.ts`（`isAtBottom`＝ピン留め判定）・`lib/scrollback.ts`（`visibleLineCount`/`stripVisibleScreen`＝seam 除去）に分離。
- `components/InputBar.tsx` — コマンド入力欄＋**常時コンパクト行（⌨ トグル＋フォント A−/A＋ のみ）**＋**⌨ で開く QWERTY フルキーボード**。縦幅を抑えるため特殊キー/矢印は常時行に置かずパネル側に集約する。**特殊キーは cmux の `surface.send_key` を使わず `send_text` で生のエスケープシーケンスを送る**（`lib/terminal-keys.ts` の `encodeKey`）— cmux の send_key は受け付ける key 名に癖があり方向キーが効かないため。方向キーは DECCKM（`modes` の code 1）で `\x1b[`/`\x1bO` を出し分ける。パネルは `KB_LAYOUT`（キー種別ユニオン char/special/mod/raw）で**フル US ANSI 配列を物理キーボードと同じ相対位置**に並べる: 数字行(`` ` ``〜`=`)＋`⌫`／`Tab`＋`qwertyuiop[]\`／`Ctrl`＋`asdfghjkl;'`＋`⏎`／`Shift`＋`zxcvbnm,./`／`Opt`＋`space`＋方向キー。`Esc`=左上、`Ctrl`=Tab の下、矢印=スペース右（`^C` は Ctrl→c で代替）。**修飾キー（Ctrl/Opt/Shift）はワンショット**（タップで武装＝ハイライト→次の1キーで自動解除、複数同時可、パネル開閉で解除）で、**QWERTY パネルの文字キーにのみ適用**（Esc/Tab/方向キーには適用しない）。文字キーは `encodeChar`（Shift: 英字→大文字/記号→US Shift 記号、Ctrl: 英字→`&0x1f` 制御バイト/Space→NUL、Option: 先頭 ESC 前置）で `send_text` 送出。`⌫`=`\x7f`・`⏎`=`\r`（Option 武装時のみ ESC 前置）。footer 廃止で最下部要素になったため `paddingBottom: env(safe-area-inset-bottom)` を持つ。
- `components/ConnectionIndicator.tsx` / `components/Header.tsx` — **旧 footer(StatusBar) は廃止**。接続状態（ドット＋ラベル、接続済み表示からの切断・再接続中は 2 秒猶予でチラつき防止）と、`describeFeed` が整形した鮮度文字列を props で受けて表示する `ConnectionIndicator` を抽出。履歴の別表示は廃止（遡りはモードレスで常時可能、`Terminal.tsx` 参照）。ペイン名/位置ドットは廃止。Header には**歯車（設定）ボタン**もあり `SettingsModal` を開く。
- `components/SettingsModal.tsx` / `lib/settings.ts` — **radix Dialog** ベースの設定モーダル（Portal/フォーカストラップ/Escape/スクロールロック）。項目は (1) **テーマ切替**（radix ToggleGroup で System/Light/Dark、lucide `Monitor`/`Sun`/`Moon`、**即時反映＋即永続**）、(2) **通知（Web Push）**（radix Switch、即時）、(3) **履歴バッファ（スクロールバック行数）**（radix Slider＋数値入力、`HISTORY_LINES_MIN`〜`MAX`=1000〜100000、既定 2000、draft→保存で確定）。履歴行数は `localStorage`(`cmux:history-lines`) に永続し、`useTerminalFeeds` の前面ポーリング（最下部ピン留め中のみ）の `readText(..., { scrollback: true, lines })` に渡る＝**ライブ表示で上へ遡れる行数**。
- `lib/surface-cache.ts` — `historyLines` はライブ表示だけに適用される。オフラインキャッシュは `MAX_CACHED_CHARS = 200_000` の上限付きスナップショットであり、意図された設計である。`MAX_CACHED_SURFACES = 12`・`MAX_CACHED_ENTRY_BYTES = 256KB` で古い entry を退避し、`QuotaExceededError` 時も対象接頭辞の最古 entry を反復退避して再試行する。
- **テーマ（system/light/dark）** — 配色は CSS 変数トークンに集約（`styles/theme.css`、`:root` 既定=dark / `[data-theme='light']` で上書き）。`lib/theme.ts`（`loadTheme`/`saveTheme`/`resolveTheme`/`applyTheme`、`localStorage`(`cmux:theme`)）＋`hooks/useTheme.ts`（`App` 直下で 1 回、`'system'` の間だけ `matchMedia` の `change` を購読し OS に追従）。`index.html` の **FOUC 防止インライン script** が React マウント前に `data-theme` を確定し、`applyTheme` が `<meta name="theme-color">` も実テーマの背景色に更新する（`data-theme` 未設定時は dark にフォールバック）。**dark のトークン値は旧ハードコード色と 1:1、light は派生。アプリ枠の色は全て `var(--color-*)` 経由（インラインスタイル継続）— 新色は theme.css の dark/light 両方に追加してから使う。** **ターミナルのビューポートは全テーマでダーク固定**（`--color-terminal-bg`）で `Terminal.tsx` の描画/wterm の `--term-*` は不可侵。**アプリ枠のアイコンは lucide-react**（キーボードのキー字形は glyph のまま）。詳細設計は `docs/superpowers/{specs,plans}/2026-06-17-radix-client-theming*`（[[client-theming-stack]]）。
- `components/Drawer.tsx` — ワークスペース一覧。**デスクトップ/タブレットはピン留め `<nav>`（非モーダル）、モバイルは radix Dialog のオーバーレイ**（フォーカストラップ/Escape/スクロールロック、スライド/フェードは `global.css` の `drawer-overlay`/`drawer-content` アニメーション）。**ワークスペースを閉じる確認は radix AlertDialog**（旧 `window.confirm` を置換）。新規 `+`／閉じる `×` は lucide `Plus`/`X`。ワークスペース識別色 `DEFAULT_PALETTE` はテーマ非依存で据え置き。
- `lib/token.ts` — URL の `?token=` を localStorage に保存（URL は書き換えない）。WS 接続 URL に常に付与。
- `lib/push.ts` / `sw.ts` — Web Push 購読と Service Worker。**PWA は generateSW から injectManifest へ移行**し（`vite.config.ts` の `strategies: 'injectManifest'`・`srcDir/filename`）、自前 `sw.ts` が `precacheAndRoute` + `NavigationRoute`（SPA フォールバック、`/ws`・`/health` は denylist）に加えて **push / notificationclick** を処理する（タップで既存ウィンドウへ `postMessage({type:'navigate'})`、無ければ `openWindow('/?workspace=<id>')`）。`sw.ts` は DOM lib と衝突するため tsconfig の `exclude` でアプリ `tsc` から外し、vite-plugin-pwa が単独でバンドルする（プロキシ対象パスを増やす場合は SW の denylist に追加）。`lib/push.ts` は許可要求→`pushManager.subscribe`→`POST /push/subscribe`。`SettingsModal` の「通知（Web Push）」トグル（ユーザージェスチャで購読、非対応環境は無効化）で有効化し、`App.tsx` が `?workspace=`／SW メッセージを受けて該当 WS を選択する。
- PWA は `vite-plugin-pwa`（autoUpdate, **injectManifest**, 自前 SW=`src/sw.ts`）。`registerSW({ immediate: true })`（`main.tsx`）で登録。

## コードスタイル

- Biome（`biome.json`）: シングルクォート、セミコロンなし（asNeeded）、行幅 120。コミット前に `pnpm check` を通すこと。
- `package.json` の並び順は `sort-package-json` で管理（`pnpm sort-package:fix`）。
