# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

cmux のリモートターミナルビューア。iPhone 等のブラウザ/PWA から、ローカルで動く cmux を閲覧・操作する。pnpm workspace + Turborepo のモノレポで、`apps/server`（Bun + Hono のブリッジサーバー）と `apps/client`（React 19 + Vite PWA）の 2 パッケージ構成。

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
pnpm server:up|down|status|restart|logs   # ホスト常駐サーバーの管理（ログ: apps/server/.run/server.log）
```

## アーキテクチャ

```
ブラウザ/PWA → nginx (Docker :48710 https / :48700 は https へ 301) → ブリッジサーバー (Bun, ホスト :48701 — 本番は HTTPS/WSS・127.0.0.1 束縛 / dev は HTTP) → cmux UDS (JSON-RPC)
```

TLS は nginx で終端する。証明書は mkcert 製（`pnpm certs:setup` → `certs/`、gitignore 済み、compose の volume で nginx にマウント）。**本番では Bun ブリッジも同じ証明書で TLS 終端する**（`CMUX_REMOTE_TLS=1` を `server:up` が付与、証明書パスは `CMUX_TLS_CERT`/`CMUX_TLS_KEY` で上書き可・既定は `certs/`）。Bun は `127.0.0.1` のみに束縛し（`CMUX_BIND_HOST` で上書き可・既定 loopback）LAN からの直接到達を遮断するため、nginx→Bun を含め平文区間は残らない。nginx は `proxy_pass https://host.docker.internal:48701` + `proxy_ssl_verify off`（mkcert に `host.docker.internal` SAN が無く、かつホスト内ホップのため検証なし＝機密性のみ確保）。**開発モード（`pnpm dev`）は `CMUX_REMOTE_TLS` 未設定で HTTP のまま**、nginx の代わりに Vite dev サーバー(:5173)が `/ws`・`/health` を :48701 にプロキシする。Docker(VM) が loopback の Bun に到達できない環境では `CMUX_BIND_HOST=0.0.0.0` にフォールバック（その場合も TLS は維持される）。

### 重要な制約: サーバーは Docker に入れられない

cmux ソケットは既定の `cmuxOnly` モードで「cmux の子孫プロセスのみ接続可」という PID 系譜チェックを行うため、コンテナ（別プロセスツリー）からの接続は常に拒否される。そのためサーバーはホストで動かし、Docker は nginx クライアントのみ（`compose.yml` 参照）。常駐デーモン運用には cmux を `allowAll` にする必要があり（`pnpm cmux:allow-automation`）、設定は cmux の再起動か Settings → Automation での切替で初めて反映される。開発時（`pnpm dev`）はサーバーが cmux 端末の子プロセスなので `cmuxOnly` のままで動く。

### サーバー (`apps/server/src/`)

- `index.ts` — エントリ。`Bun.serve` で WS upgrade（`/ws`、トークン必須）・Hono ルート（`/health`、クライアント静的配信）を振り分け。
- `ws.ts` — 中核。ブラウザ WS ⇄ cmux UDS の JSON-RPC 透過中継。WS 接続ごとに cmux への UDS 接続を 1 本張る。例外的に書き換える RPC が 2 つ:
  - `surface.list` → `system.tree` に変換し、応答を全ペインのサーフェスに平坦化して `{ surfaces }` に整形（ソケット側の `surface.list` は `workspace_ref` を無視するため）。
  - `surface.create` → `type: 'terminal', focus: true` のデフォルトを注入。
  - cmux ソケットが閉じたら WS を code 1011 で閉じ、クライアントの再接続にフォールバックさせる。
  - UDS 読み取りは **`createLineFramer`（`node:string_decoder` の `StringDecoder`）で UTF-8 安全に行フレーミングする** — `data.toString()` をチャンクごとに連結すると絵文字(4byte)/CJK(3byte) がチャンク境界で割れて U+FFFD（画面上「??」）に化けるため。`render_grid` の文字化けはまずここを疑う（[[server-utf8-chunk-framing]]）。
- `auth.ts` — WS 共有トークン。優先順: 環境変数 `CMUX_REMOTE_TOKEN`（`apps/server/.env` も Bun が自動読込）→ `apps/server/.run/token`（無ければ自動生成・永続化）。比較は `timingSafeEqual`。
- `socket-path.ts` — cmux ソケットパス解決。`CMUX_SOCKET_PATH` → `last-socket-path` ポインタファイル（XDG state / Application Support）→ 既定パスの順。
- `health.ts` — `GET /health`。cmux への接続を 1 本使い回す（ポーリングによる接続チャーン防止）。

### クライアント (`apps/client/src/`)

- `hooks/useCmux.ts` — 中核。WS 上に Promise ベースの RPC 層（pending Map + 10 秒タイムアウト）を構築し、workspace/pane/surface の状態と操作を提供。**タブ切替は PWA 側の表示のみ変更し、ローカル cmux のペインフォーカスは奪わない**（`surface.focus` RPC は使わない設計）。**ワークスペース切替は `workspace.select` で cmux 側も追従させる** — cmux は選択中ワークスペース以外のターミナルを `read_text` できない（`internal_error`）ため、追従なしでは別ワークスペースのライブ表示が不可能。注意: cmux ソケットの surface 系 RPC（read_text/send_text/send_key/close）はパラメータ `surface_id` を読む。`surface_ref` は無視され、フォーカス中サーフェスへ暗黙にフォールバックする。`terminal.replay` の `render_grid` は `active_screen`（`'primary'` / `'alternate'`＝代替スクリーン）と `modes`（端末の DECSET モード状態 `{ code, ansi, on }[]`）も返す。**タップ→マウス送信の有効化は `modes` で判定する**: `1000`/`1002`/`1003`（マウストラッキング: クリック/ドラッグ/モーション報告）のいずれかが `on` なら端末がマウス入力を受け付ける状態、`1006` が `on` なら SGR 拡張座標形式（`\x1b[<Cb;Col;RowM`/`m`）。`active_screen='alternate'` 単独より正確で、マウス未設定の TUI（`mouse=` 無しの nvim や lazygit）への誤爆を避けられる。なお `terminal.replay` は `read_text` と違い、選択中ワークスペース以外のサーフェスでも `render_grid` を返す（実機確認済み）。
- `components/Terminal.tsx` — `@wterm/react` でレンダリング。可視サーフェスを `surface.read_text` で 1 秒間隔ポーリング。**スクロールはブラウザのネイティブに任せる**（react-swipeable/react-use は廃止）: wrapper を `overflow:auto` + `touch-action: pan-x pan-y` にして**一本指で縦横スクロール（慣性付き）**。**横スクロール範囲は `.wterm`(wterm ルート, `overflow:hidden`)に `width: max(100%, <実測content>px)` を与える** — `100%` でコンテナ(pane)を満たして**右に app 背景の隙間を作らず**、実コンテンツが pane を超えたら実測幅まで広げて横スクロール可能にする。wterm は height だけ明示固定し width 未指定（無指定だと wrapper 幅に張り付きクリップ）。**実コンテンツ幅は「末尾空白を除いた最右の文字位置」**を計測する（`measuredWidth`）— 端末は各行を `cols` 幅まで空白で埋めるため、行全体や `.term-grid`/`cols*ch` で測ると「内容より右の**空セル**」まで幅に含み、**grid が pane より広い**（デスクトップ cmux のペイン幅＞ビューアのペイン幅）と右に余白/横スクロールが出る。各テキストノードで末尾空白(`/\s+$/`)を除いた `Range` の `right`（`.term-grid` left 基準）の最大を採る（全角は実ジオメトリで正しく反映、`Range` はコンテナ幅非依存でフィードバック無し）。`MutationObserver`＋`requestAnimationFrame` で wterm の非同期再描画（`renderer.setup` の `innerHTML=''`→`setTimeout(0)+rAF`）を捉えて計測し、**allow-shrink** で現在画面にフィット。`span` の無い空フレームは無視（潰れ＝`scrollLeft` 左飛びチラつきを防止）、`fontSize` 変化で再計測、`grid=null`（履歴/プレーン）は計測しない。`max-content` 等の intrinsic 値は使わない（空フレームで潰れチラつくため。明示 px は潰れない）。**ターミナルフォントは `--term-font-family` に `'M PLUS 1 Code'`（`@fontsource/m-plus-1-code`, `main.tsx` で latin/japanese-400 を import・同梱）を最優先で指定する** — Menlo 等は CJK を持たずシステムフォールバック(Hiragino)の送り幅が **1.66:1** で、cmux が**全角=2セル**で配置した内容と px がズレて隔間/位置ズレが出る。M+ 1 Code は **CJK=2×Latin**（実測 `cjkPx/latinPx=2.0`）なので一致する。**ライブ描画は `lib/render-grid.ts` の `renderGridToAnsi` が `render_grid` を ANSI 化して wterm に書くが、span を絶対位置(`ESC[colH`)でなく「行ごとに span 間の隙間を空白で埋めて連続描画」する** — 絶対位置だと wterm コアの CJK セル勘定(width=1)と cmux(全角=2)の差で「全角の2セル目(継続セル)」が wterm 側で空セル=余分な空白になり隔間ズレが出る（フォントを 2× にしてもコアのセル勘定は変わらず残るため、この2点セットで初めて cmux と一致する）。タッチ操作は**一本指タップ=左クリック・二本指タップ=右クリック**（いずれも `mouseEnabled && useSgr && grid` 成立時のみ SGR 送信）。閾値超えの移動があれば「ドラッグ=スクロール」とみなしクリックは送らず `preventDefault` もしない（慣性維持）。タップ確定時のみ `preventDefault` で合成 click を抑止し、さらに `onReady` で **wterm の隠し `<textarea>` を `disabled` にして**フォーカス自体を無効化する（合成 click が漏れてもモバイル仮想キーボード表示と「off-screen textarea を見せようと wrapper が左端へスクロール」する副作用を断つ。`onData` は捨てるのでキーボードは元々無機能）。**二本指ピンチでフォント増減**（指間距離の変化を `PINCH_STEP_PX` 単位で蓄積、`InputBar` の A−/A＋ ボタンでも増減可）。`touch-action: pan-x pan-y` 下では二本指の中心移動はネイティブスクロールに乗るので、ピンチ（距離変化）とスクロール（中心移動）が共存する。**二本指パンの自前実装・スワイプタブ切替は廃止**（スクロールはネイティブ一本指、タブは `TabBar`）。**ライブ表示は上端でさらに上スクロール（wheel／一本指の下方向ドラッグ。`mouseEnabled` の TUI では横取りしない）すると履歴（スクロールバック）へ入り（`onEnterHistory`）、遡った後に最下部へ戻ると自動でライブへ復帰する（`onExitHistory`）。** 復帰は capture 段の `scroll` 監視で「一度上へ離れてから最下部へ戻った時のみ」発火させ、進入直後の末尾追従での即バウンドを防ぐ。**別モード／「履歴」ボタンは廃止し、スクロール位置で `historyMode` をトグルする**（履歴中は `grid=null` でプレーンテキスト＝色なし・更新停止、`.wterm` を `height:100%` にして wterm の `has-scrollback` で縦スクロール）。純粋ロジックは `lib/multitouch.ts`（`centroid`/`isTap`）・`lib/sgr-mouse.ts`（`encodeClick`）・`lib/terminal-coords.ts`（座標変換）・`lib/mouse-mode.ts`（`modes` 判定）・`lib/terminal-keys.ts`（特殊キー→生シーケンス）・`lib/scroll-intent.ts`（`isOverscrollUp`/`isAtBottom`＝遡り進入/復帰判定）に分離。
- `components/InputBar.tsx` — コマンド入力欄＋**常時コンパクト行（⌨ トグル＋フォント A−/A＋ のみ）**＋**⌨ で開く QWERTY フルキーボード**。縦幅を抑えるため特殊キー/矢印は常時行に置かずパネル側に集約する。**特殊キーは cmux の `surface.send_key` を使わず `send_text` で生のエスケープシーケンスを送る**（`lib/terminal-keys.ts` の `encodeKey`）— cmux の send_key は受け付ける key 名に癖があり方向キーが効かないため。方向キーは DECCKM（`modes` の code 1）で `\x1b[`/`\x1bO` を出し分ける。パネルは `KB_LAYOUT`（キー種別ユニオン char/special/mod/raw）で**フル US ANSI 配列を物理キーボードと同じ相対位置**に並べる: 数字行(`` ` ``〜`=`)＋`⌫`／`Tab`＋`qwertyuiop[]\`／`Ctrl`＋`asdfghjkl;'`＋`⏎`／`Shift`＋`zxcvbnm,./`／`Opt`＋`space`＋方向キー。`Esc`=左上、`Ctrl`=Tab の下、矢印=スペース右（`^C` は Ctrl→c で代替）。**修飾キー（Ctrl/Opt/Shift）はワンショット**（タップで武装＝ハイライト→次の1キーで自動解除、複数同時可、パネル開閉で解除）で、**QWERTY パネルの文字キーにのみ適用**（Esc/Tab/方向キーには適用しない）。文字キーは `encodeChar`（Shift: 英字→大文字/記号→US Shift 記号、Ctrl: 英字→`&0x1f` 制御バイト/Space→NUL、Option: 先頭 ESC 前置）で `send_text` 送出。`⌫`=`\x7f`・`⏎`=`\r`（Option 武装時のみ ESC 前置）。footer 廃止で最下部要素になったため `paddingBottom: env(safe-area-inset-bottom)` を持つ。
- `components/ConnectionIndicator.tsx` / `components/Header.tsx` — **旧 footer(StatusBar) は廃止**。接続状態（ドット＋ラベル、`connected→切断` のみ 2 秒猶予でチラつき防止）とオフライン/履歴の鮮度表示（「最終 HH:MM」/「履歴 · HH:MM時点」）を `ConnectionIndicator` に抽出（`historyMode` を受け取り表示）。**「履歴」ボタンは廃止**し、遡り（履歴）はライブ上端での上スクロールで自動進入する（`Terminal.tsx` が検知）。ペイン名/位置ドットは廃止。Header には**歯車（設定）ボタン**もあり `SettingsModal` を開く。
- `components/SettingsModal.tsx` / `lib/settings.ts` — 設定モーダル。今は**履歴バッファ（スクロールバック行数）**のみ調整可（スライダー＋数値入力、`HISTORY_LINES_MIN`〜`MAX`=1000〜100000、既定 2000）。`localStorage`(`cmux:history-lines`)に永続し、App のライブ遡り（履歴）取得 `readText(..., { scrollback: true, lines })` に渡る＝**ライブで上スクロールして遡れる行数**。
- `lib/token.ts` — URL の `?token=` を localStorage に保存（URL は書き換えない）。WS 接続 URL に常に付与。
- PWA は `vite-plugin-pwa`（autoUpdate）。workbox の `navigateFallbackDenylist` で `/ws`・`/health` を Service Worker から除外している — プロキシ対象のパスを増やす場合はここにも追加が必要。

## コードスタイル

- Biome（`biome.json`）: シングルクォート、セミコロンなし（asNeeded）、行幅 120。コミット前に `pnpm check` を通すこと。
- `package.json` の並び順は `sort-package-json` で管理（`pnpm sort-package:fix`）。
