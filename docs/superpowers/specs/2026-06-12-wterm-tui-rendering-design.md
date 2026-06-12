# wterm TUI レンダリング忠実化 設計

## 背景・ユーザー要望

> 「turbo などで TUI 起動したタブを開くと、崩れて見づらいのですが、wterm の場合、通常の cmux のターミナルのように綺麗に TUI 出すこと可能ですか？できるなら対応して欲しい」

cmux のリモートターミナルビューア（iPhone 等のブラウザ/PWA）で、turbo / vim / top 等の全画面 TUI アプリを開くと表示が崩れる。デスクトップの cmux ターミナルと同等の忠実度で描画したい。

## 根本原因（調査で確定）

ソケット (`/Users/yui/.local/state/cmux/cmux-501.sock`) を直接叩いて確認した事実:

- 現状 `App.tsx` は `surface.read_text` を 1 秒ポーリングし、`Terminal.tsx` が画面全消去（`\x1b[2J\x1b[3J\x1b[H`）→ プレーンテキスト書き込みを繰り返す。
- **`surface.read_text` は ANSI を一切含まないプレーンテキスト**を返す（`hasANSI=false` を実測）。色・属性・カーソル位置・**代替画面（alternate screen）の区別が全て失われる**。
- `Terminal.tsx` の `cleanScreen()` が各行を `trimEnd()` するため、TUI が背景色・末尾スペースで構成するレイアウトが破壊される。
- turbo/vim/top 等は alternate screen に切り替えてセル単位で再描画するが、read_text のテキストダンプはそれを平坦化する。

→ これが「崩れて見づらい」の正体。テキストスナップショットのポーリング描画という方式自体が TUI に不適。

## 実現可能性: 可能

`system.capabilities` で cmux ソケットの全 221 メソッドを列挙し、リッチな描画 API を発見:

- **`terminal.replay`**（cmux 自身のモバイルクライアントが使う `mobile.terminal.replay` と同一系統）が **`render_grid`**（format `cmux.render-grid.v1`）を返す。
- `mobile.host.status.terminal_fidelity = "render_grid"` ＝ cmux 公式がグリッド忠実度でモバイル描画している裏付け。capabilities に `terminal.render_grid.v1` / `terminal.replay.v1` / `terminal.viewport.v1` / `terminal.bytes.v1` / `events.v1`。

### `render_grid` スキーマ（実測, `cmux.render-grid.v1`）

```
{
  columns: number, rows: number,
  cursor: { row, column, visible, style: "block"|..., blinking },
  active_screen: "primary" | "alternate",
  styles: Array<{
    id, foreground: "#RRGGBB", background: "#RRGGBB",
    bold, faint, italic, underline, blink, inverse, strikethrough, overline, invisible
  }>,
  row_spans: Array<{ row, column, style_id, cell_width, text }>,       // 可視グリッド（ランレングス）
  scrollback_spans: Array<{ row, column, style_id, cell_width, text }>, // スクロールバック
  scrollback_rows: number,
  cleared_rows: number[],
  state_seq: number, seq: number, full: boolean,
  modes: Array<{ on, ansi, code }>,
  surface_id: string, workspace_id: string,
  format: "cmux.render-grid.v1"
}
```

ポイント:
- `row_spans` は行ごと・スタイルごとのテキストラン。`column` は表示列（CJK 等の全角は `cell_width` が 2）。
- spans は行全体を必ずしも埋めない（埋まらない列＝デフォルト状態のセル）。
- `terminal.replay` は `surface_id` を受理し、短縮 ref（例 `"surface:60"`）も解決する。`format` パラメータは無視され常に render_grid を返す（生バイトモードは容易には露出しない）。
- アイドル時のサーバープッシュは無し → **更新はポーリングモデル**（`terminal.replay` を定期取得）。`state_seq`/`seq`/`full` による差分機構は存在するが v1 ではフルフレーム取得とする。

## 採用アーキテクチャ

クライアント側で render_grid を ANSI に変換し `@wterm` に書き込む（既存の read_text もクライアント描画だったため一致）。

```
poll → terminal.replay {surface_id} → render_grid
     → renderGridToAnsi(grid)        [純粋関数]
     → @wterm.write(ansiFrame)        （@wterm は grid.columns × grid.rows に固定）
```

- `apps/server/src/ws.ts` は **無変更**（`terminal.replay` は special-case 対象外なので素通し）。
- `workspace.select` 追従は既存実装のまま。currentSurface は常に選択中ワークスペース内なので replay 可能。

### 画面幅の方針（ユーザー決定: ネイティブ幅で忠実再現）

- @wterm を cmux のグリッド寸法（例 187×62）に固定（`autoResize` 廃止、`cols`/`rows` 明示）。デスクトップ cmux と完全に同じ見た目。
- スマホでは既存のピンチズーム + スクロールで閲覧。
- **ホスト PTY はリサイズしない**（`mobile.terminal.viewport` での再レイアウトは採らない）。「ローカル cmux のフォーカス/レイアウトを奪わない」原則を維持。

### 却下した代替案

- **サーバー(ws.ts)で変換**: 透過中継の原則を壊し、描画ロジックがサーバーに混入する。
- **@wterm を使わず自前グリッド描画（DOM/canvas）**: 既存の描画器を捨てて再実装、テストも困難。

## コンポーネント設計

### 1. 新規 `apps/client/src/lib/render-grid.ts`（純粋・TDD 対象）

- 型: `RenderGrid` / `RenderStyle` / `RowSpan` / `GridCursor`（`any`/`unknown`/`class` 不使用）。
- `renderGridToAnsi(grid: RenderGrid): string`:
  1. `\x1b[2J\x1b[H`（全消去 + ホーム）。
  2. `row_spans` を順に: `\x1b[{row+1};{column+1}H`（絶対位置）→ `style_id` の SGR（`38;2;r;g;b` / `48;2;r;g;b` と bold=`1`/faint=`2`/italic=`3`/underline=`4`/blink=`5`/inverse=`7`/invisible=`8`/strikethrough=`9`/overline=`53`、各 span 先頭で `0` リセット後に必要属性を付与）→ `text`。
  3. 末尾: カーソル位置 `\x1b[{cursor.row+1};{cursor.column+1}H` と表示制御 `\x1b[?25h` / `\x1b[?25l`。
- 絶対位置指定により「ギャップ＝デフォルト背景」「staircase」「trim 破壊」を構造的に回避。`#RRGGBB` → `r;g;b` 変換ヘルパを内包。
- 未知の style_id / 空 row_spans / cursor 不在に対する防御（フォールバック）。

### 2. `apps/client/src/hooks/useCmux.ts`

- `readGrid(surfaceRef?: string): Promise<RenderGrid>` を追加。`terminal.replay` を `surface_id` 指定で呼び、`result.render_grid` を返す。
- 既存 `readText` は履歴モード用に残す。返り値 export に `readGrid` を追加。

### 3. `apps/client/src/App.tsx`

- ライブポーリング（端末サーフェスのみ）を `readGrid` に切替。状態を `termContent: string` から `termGrid: RenderGrid | null` へ。
- オフラインキャッシュ（`surface-cache`）に grid を保存・ハイドレート（キャッシュ層の text/grid 取り扱いを拡張）。
- **履歴モードは `readText`（scrollback）据え置き** ＝ スコープ最小化。履歴トグル時は従来の text 表示にフォールバック。
- ブラウザサーフェスは従来通り iframe（replay は呼ばない）。

### 4. `apps/client/src/components/Terminal.tsx`

- props を `grid: RenderGrid | null`（+ 履歴モード用の `content?: string`）へ変更。
- `autoResize` を外し `cols={grid.columns}` / `rows={grid.rows}`（`resize()`）で固定。
- `onReady` / grid 変化時に `renderGridToAnsi(grid)` を `write`。デフォルト背景を cmux の `#1E1E1E` に寄せる。

## テスト戦略（TDD）

- `apps/client/src/lib/__tests__/render-grid.test.ts`（vitest）:
  - 実ソケットから採取した render_grid サンプルを fixture 化。
  - `renderGridToAnsi` の出力を検証: SGR（24bit 前景/背景・bold/italic/underline/inverse）・絶対位置・CJK（全角）幅・カーソル位置/表示制御・空ギャップが背景になること。
  - RED → GREEN の順で実装。
- 完了条件: `pnpm check`（tsc + biome）通過、`cd apps/client && pnpm vitest run` 全通過。

## エッジケース / リスク

- **別ワークスペースのサーフェス**: 既存 `workspace.select` 追従で回避済み。`terminal.replay` も read_text と同じ workspace 制約と想定 → 実装時に `pnpm dev` の複数サーフェス環境で実機確認する。
- **非フォーカスサーフェスの surface_id 指定**: read_text は surface_id を尊重する（確立済み）。replay も同パラメータを受理することを確認済みだが、複数サーフェス環境での実機確認をプランに含める。
- **更新レイテンシ**: v1 は現状同様 1 秒ポーリング。差分（seq）最適化は将来課題として明記。
- **切断時**: 既存の surface-cache フォールバックを grid 対応で維持。

## スコープ外（将来課題）

- `state_seq`/`seq` を使った差分更新・ポーリング間隔短縮。
- 履歴（スクロールバック）モードの render_grid `scrollback_spans` 化。
- ホスト PTY をモバイル幅へリサイズする `mobile.terminal.viewport` 連携。
