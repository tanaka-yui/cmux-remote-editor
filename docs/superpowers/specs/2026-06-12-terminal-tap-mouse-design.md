# ターミナルのタップ → cmux マウス送信 設計

- 日付: 2026-06-12
- ブランチ: `feat/terminal-tap-mouse`
- ステータス: 設計合意済み（実装計画はこの後 writing-plans で作成）

## 目的

PWA のターミナル表示（`@wterm/react`）をタップ／スワイプしたとき、その座標を cmux 側に
マウスイベントとして転送し、nvim（neo-tree / nvim-tree など）のツリー選択や TUI のスクロールを
指で操作できるようにする。新しい RPC は追加せず、既存の `surface.send_text` でマウスの
エスケープシーケンスを送る。

## スコープ

段階実装とする。

- **フェーズ1（今回）**: シングルタップ＝左クリック / 一本指の上下スワイプ＝マウスホイール
- **フェーズ2（後続）**: 長押し＝右クリック / ドラッグ＝範囲選択

非対象（YAGNI）: SGR 非対応のレガシー端末（`1006` off）への送信、ピクセル単位モード（`1016`）、
マウスモードが無効な端末への送信。

## マウスモード検出（設計の核）

`terminal.replay` が返す `render_grid.modes`（端末の DECSET モード状態 `{ code, ansi, on }[]`）を見て、
**端末が今マウス入力を受け付ける状態のときだけ**タップを送る。これにより通常シェルでの誤入力
（`[<0;5;3M` のようなゴミ）が原理的に発生しない。

- `mouseEnabled` = `modes` の `1000` / `1002` / `1003`（マウストラッキング）のいずれかが `on`
- `useSgr` = `modes` の `1006`（SGR 拡張座標）が `on`
- `mouseEnabled && useSgr` のときのみタップ→マウス送信を行う。それ以外は従来挙動

実機観測（2026-06-12, `terminal.replay`）:

| surface | active_screen | 1000 | 1002 | 1003 | 1006 | 判定 |
|---|---|---|---|---|---|---|
| pnpm dev (TUI) | alternate | on | on | off | on | 有効 |
| nvim（`mouse=a`） | alternate | off | on | off | on | 有効 |
| nvim（mouse 無し） | primary | off | off | off | off | 無効 |
| lazygit（非アクティブ時） | primary | off | off | off | off | 無効 |
| 通常シェル / Claude Code | primary | off | off | off | off | 無効 |

`active_screen='alternate'` 単独だと「mouse 未設定の nvim/lazygit」でも送ってしまうため、`modes` を
採用する（`active_screen` は判定に使わない）。

## アーキテクチャ / コンポーネント境界

| 単位 | 役割 | 依存 | テスト |
|---|---|---|---|
| `lib/sgr-mouse.ts`（新規・純粋関数） | `{ button, col, row, action }` → SGR マウス列を生成 | なし | 各ボタン/アクションの出力列 |
| `lib/terminal-coords.ts`（新規・純粋関数） | `pixelToCell(clientX, clientY, rect, scroll, cols, rows, padding)` → 1-based `{ col, row }`（範囲 clamp） | なし | 四隅・padding・scroll・clamp |
| `lib/mouse-mode.ts`（新規・純粋関数） | `render_grid.modes` から `{ mouseEnabled, useSgr }` を導出 | なし | 各モード組み合わせ |
| `lib/gesture-classify.ts`（新規・純粋関数） | touch 開始/終了の座標・時間から `tap` / `wheel(up\|down, count)` を判定（フェーズ1） | なし | 閾値・方向・移動量 |
| `components/Terminal.tsx` | `mouseEnabled` のとき touch を処理し、判定結果を `onSendMouse(text)` で送る | 上記 lib | 挙動分岐 |
| `hooks/useCmux.ts` | `sendMouse(surfaceRef, text)` = 既存 `sendText`（`surface.send_text`）の薄いラッパ。**新 RPC 不要** | 既存 | 既存 |
| `App.tsx` | `mouseEnabled` を Terminal と useGesture に渡し、**有効時はタブ切替スワイプを無効化** | — | — |

## SGR エンコード仕様（フェーズ1）

1-based の `col`/`row` を使う。

- 左クリック: press `\x1b[<0;col;rowM` → release `\x1b[<0;col;rowm`
- ホイール上: `\x1b[<64;col;rowM`（release 不要）
- ホイール下: `\x1b[<65;col;rowM`（release 不要）

ホイールは一度のスワイプで移動量に応じて複数回送る（行数換算、上限あり）。

## 座標変換

- グリッドモードでは `grid.columns` / `grid.rows` が既知。`Terminal.tsx` の wterm 要素を
  `getBoundingClientRect()` で実測し、`padding`（現状 8px）を除いた描画領域を `cols`/`rows` で割って
  セル寸法を求める。
- `overflow: auto` による横スクロール時は `scrollLeft` / `scrollTop` を加算してコンテンツ座標に変換。
- 算出した `col`/`row` は `[1, cols]` / `[1, rows]` に clamp。

## ジェスチャー判定とタブ切替の競合（フェーズ1）

- `mouseEnabled === false`（通常シェル等）: 現状維持。水平スワイプ＝タブ切替、タップ無反応。**既存挙動を壊さない**。
- `mouseEnabled === true`（nvim 等）: Terminal が touch を処理。タップ＝左クリック、上下スワイプ＝ホイール。
  この間は `useGesture` の水平スワイプ（タブ切替）を `App.tsx` 側で無効化して競合を避ける。
- タブ切替はボタン（`TabBar.tsx`）が残るので操作性は維持される。

## データフロー

```
terminal.replay → render_grid(modes, active_screen, columns, rows) → Terminal が mouseEnabled/useSgr を導出
  ├ mouseEnabled=false: 従来どおり（水平スワイプ=タブ切替 / タップ無反応）
  └ mouseEnabled=true:  touch → gesture-classify → (tap|wheel)
                         → pixelToCell → sgr-mouse でエンコード → sendMouse(sendText) → cmux UDS → nvim
1 秒ポーリングの render_grid 更新で結果が画面反映（既存の仕組みを流用）
```

## エラー処理

- 座標が範囲外 → clamp で吸収。
- `send_text` 失敗 → 既存 RPC のエラー処理（10 秒タイムアウト）に委ねる。
- `modes` が未取得（grid 未到達）→ `mouseEnabled=false` 扱い（送らない）。

## 型変更

- `lib/render-grid.ts` の `RenderGrid` に `modes?: { code: number; ansi: boolean; on: boolean }[]` を追加。
  `terminal.replay` は既にこのフィールドを返しているため**サーバー変更は不要**。

## テスト戦略（TDD）

純粋関数を単体テスト（vitest）で先に固める。

- `sgr-mouse`: 各ボタン/アクションの出力列（左クリック press/release、ホイール上下）
- `terminal-coords`: 四隅・padding・scroll オフセット・clamp の境界
- `mouse-mode`: 観測した modes 組み合わせ（有効/無効、SGR 有無）
- `gesture-classify`: tap / wheel の閾値・方向・移動量

## 実装時に詰める点

- ホイールの「移動量 → 送信回数」の換算係数と上限。
- セル寸法を rect 実測で求める際の小数・端数の扱い（タップ位置が境界に来たとき）。
- `mouseEnabled` の状態変化（nvim を抜けた瞬間など）のポーリング遅延（最大 1 秒）に伴う一時的な誤判定の許容。
