# 履歴モード廃止・常時スクロールバック連続ビュー 設計

- 日付: 2026-07-27
- ブランチ: `feat/modeless-scrollback`（予定）
- ステータス: 設計合意済み（実装計画はこの後 writing-plans で作成）
- 関連: `2026-06-16-live-scrollback-design.md` を**置き換える**（同 spec の「履歴モード（historyMode トグル）」を廃止）

## 目的

「ライブ ⇄ 履歴」のモード切替をなくし、**常にスクロールバック N 行＋色付きライブ画面が 1 つのスクロール領域に
連続して存在する**表示にする。通常のターミナルエミュレータと同じく、上へ自然にスクロールすれば過去が読め、
最下部にいれば最新に追従する。N（遡れる行数）は既存の設定スライダー（`cmux:history-lines`、既定 2000）に従う。

## 背景・現状

- **ライブ表示** = `terminal.replay` の `render_grid`（可視画面のみ・色付き）を毎秒ポーリングし wterm に描画。
- **履歴モード（historyMode）** = ライブ上端での上オーバースクロールで進入し、`read_text`（`scrollback:true, lines`）の
  プレーンテキストを **1 回だけ**取得して `<pre>` に固定表示（色なし・ライブポーリング停止）。最下部復帰でライブへ戻る。
- 問題: 進入/復帰という「切替」が挟まるため、遡る操作が 2 段階（オーバースクロール検知→取り直し）になり、
  進入中はライブ更新も止まる。ユーザー要望は「切替ではなく、リアルタイム表示に含まれる行数バッファの調整」。

## 重要な制約（cmux 側）

- 色付きスクロールバックは取得できない。`terminal.replay` は可視画面のみ、`read_text` の scrollback は
  プレーンテキストのみ。→ **履歴部分は色なしテキスト、ライブの現在画面（最下部）は色付き**。この 2 領域が
  縦に連続する見た目になる（割り切り、現行履歴モードと同じ制約）。
- wterm の WASM スクロールバックは 1000 行ハードコード上限のため、履歴を wterm に流す設計は不可（現行どおり
  `<pre>` 直描画）。

## 検討した代替案（不採用）

- **全プレーンテキスト化**（履歴＋画面を 1 つの `<pre>` に）: 色・カーソル・マウス（タップ→クリック）を失う退行。
- **wterm スクロールバック蓄積**: 上記 1000 行上限に加え、ライブ描画が毎フレーム `[2J[3J` 全消去する設計と根本衝突。

## スコープ

- Terminal を「履歴 `<pre>`（上）＋ wterm グリッド（下）」の**常時縦積み**にし、wrapper のネイティブスクロールで連続的に遡れる。
- スクロールバックもポーリングで**リアルタイム更新**する（ただし下記のとおり最下部ピン留め中のみ）。
- `historyMode` state・進入/復帰検知（`onEnterHistory`/`onExitHistory`・`isOverscrollUp`・wheel/touch 閾値）を**全廃**。
- 設定スライダーは「ライブ表示に含める履歴行数」として維持（範囲・既定値は据え置き）。

非対象（YAGNI）:

- 色付きスクロールバック（cmux 制約のため不可）。
- 差分取得・間引き等の帯域最適化（既定 2000 行×毎秒は LAN 前提で許容。ピン留め外でのフェッチスキップが実質の節約）。
- 遡り読取中の「内容アンカーで読位置維持しつつ更新反映」（複雑。据え置きで代替）。

## 設計の核：常時ハイブリッド連続ビュー

### レイアウト（Terminal.tsx）

- wrapper（`overflow:auto`）内に `<pre>`（スクロールバック・プレーンテキスト）→ `WTerminal`（色付きグリッド）の順で
  **同時に**描画する（現行の `useGrid` による排他表示を廃止）。
- `<pre>` は現行の履歴描画スタイル（同フォント・`whiteSpace:pre`・`width:max-content`・`cleanScreen` で行末空白除去）を流用。
- グリッドが無い場合（停止端末・オフラインキャッシュ）は `<pre>` のみ＝現行のプレーンテキスト表示と同じ。
  このとき scrollback は末尾の画面ぶんを削らず全文を出す。

### データフロー（App.tsx）

- 毎秒ポーリングを 1 本に統合する:
  - `readGrid(currentSurface)` — **常時**取得（現行どおり）。
  - `readText(currentSurface, { scrollback: true, lines: historyLines })` — **最下部ピン留め中のみ**取得。
- `historyMode` state と履歴取得 effect は削除。取得した scrollback は `termScrollback` state に持ち Terminal へ渡す。
- 片方の失敗が他方を巻き込まないよう独立に await する（grid 失敗は既存の stale-surface 再同期経路、
  scrollback 失敗はログのみで前回表示を維持）。

### ピン留め（末尾追従）と据え置き

- **ピン留め判定は Terminal が持つ**（スクロールコンテナの持ち主）。wrapper の `scroll`（capture）で
  `isAtBottom` を評価し、変化時に `onPinnedChange(pinned)` で App へ通知。App は ref に保持し、
  ポーリングが scrollback フェッチの可否に使う。初期値・サーフェス切替時はピン留め（`true`）。
- **ピン留め中**: `<pre>`/グリッド更新のたびに `scrollTop = scrollHeight` で末尾へ追従（useLayoutEffect）。
- **上スクロール中（非ピン）**: scrollback はフェッチ自体をスキップ → `<pre>` は据え置き＝読んでいる行が流れない。
  scrollTop には一切触れない（ネイティブ慣性維持）。グリッドは viewport 外（下）で更新され続けるが高さは
  rows 固定なので上の内容は動かない。
- **最下部へ戻る**: `onPinnedChange(true)` → 次のポーリング（≤1 秒）で scrollback が最新化され追従再開。
  進入/復帰の特別なイベントは不要（`hasScrolledUp` 等の即バウンド防止ロジックも不要になる）。

### alternate screen（TUI）ガード

- `render_grid.active_screen === 'alternate'`（nvim / lazygit / less 等）の間は `<pre>` を描画せず、
  scrollback のフェッチもスキップする（グリッドのみ＝現行のライブ表示と同じ）。TUI にスクロールバックの
  概念はなく、上に別内容（primary の履歴）が見えると混乱するため。
- alternate → primary 復帰時はピン留めへリセットし最下部から再開する。

### 境界の重複除去（seam）

- `read_text(scrollback:true)` が末尾に現在の可視画面を含む場合、下のグリッドと二重になるため、
  **末尾 `grid.rows` 行を削って** `<pre>` に出す。純粋関数（例: `lib/scrollback.ts` の
  `stripVisibleScreen(text, rows)`）に切り出して単体テストする。
- **実装時の検証項目**: scrollback が実際に可視画面を含むか・行数がどう数えられるか（折返し行の扱い等）を
  実機プローブで確認してから削り方を確定する。scrollback が rows 行以下なら `<pre>` は空（非表示）。

### タップ座標変換の基準変更

- 上に `<pre>` が積まれるため、タップ→セル変換（`pointToCell`）の基準を wrapper から `.wterm` 要素の
  rect に変更する（rect はスクロール済み位置を反映するため scrollTop/scrollLeft 補正も簡素化できる）。
- マウスモード判定（`deriveMouseMode` / DECCKM）は `historyMode` によるゲートを外し、常に `termGrid` から導出。

## アーキテクチャ / コンポーネント境界

| 単位 | 役割 | 依存 | テスト |
|---|---|---|---|
| `lib/scrollback.ts`（新規） | seam 除去の純粋関数（`stripVisibleScreen` 等） | なし | vitest 単体 |
| `lib/scroll-intent.ts` | `isAtBottom` のみ残す（`isOverscrollUp` は削除） | なし | vitest 単体（既存を縮小） |
| `components/Terminal.tsx` | pre＋grid 常時縦積み・ピン留め判定/末尾追従・`onPinnedChange` 通知・座標変換の基準変更 | scrollback / scroll-intent | 手動（実機） |
| `App.tsx` | ポーリング統合（grid 常時＋scrollback はピン留め中のみ）・`historyMode` 削除・`termScrollback` state | useCmux | 既存テスト更新 |
| `components/Header.tsx` / `ConnectionIndicator.tsx` | `historyMode` prop と「履歴 · HH:MM時点」表示を削除（オフライン表示は維持） | — | 既存テスト更新 |
| `components/SettingsModal.tsx` | スライダーの説明文言を「ライブ表示に含める履歴行数」に更新（挙動は不変） | — | 既存テスト更新 |

## エラー処理 / エッジ

- **scrollback フェッチ失敗**（通信不良）: ログのみ。`<pre>` は前回内容を維持（ライブ grid は独立に更新継続）。
- **サーフェス/タブ切替**: `termScrollback` をキャッシュ（`scrollback`）からハイドレートし、ピン留め＋最下部へリセット。
- **オフライン**: キャッシュ済み scrollback＋grid を同レイアウトで表示（更新が止まるだけで表示経路は同一）。
- **キャッシュ書込**: scrollback（最大 200KB クランプ）を毎秒 localStorage へ書くとジャンクの恐れがあるため、
  **内容が変化した時のみ**保存する。
- **リモートのペイン再サイズ**（rows/cols 変化）: グリッド高さが変わるが viewport 下方のため遡り読取位置には影響しない。
  ピン留め中は次の追従で吸収。
- **空スクロールバック**（新規端末）: `<pre>` は空＝実質グリッドのみで現行と同じ見た目。

## 削除するもの（後片付け）

- `App.tsx`: `historyMode` state・履歴取得 effect・`enterHistory`/`exitHistory`。
- `Terminal.tsx`: `onEnterHistory`/`onExitHistory` props・wheel/touch のオーバースクロール検知
  （`WHEEL_ENTER_THRESHOLD`/`TOUCH_ENTER_THRESHOLD`）・`hasScrolledUp`・履歴→ライブ復帰の二重 rAF effect。
- `lib/scroll-intent.ts`: `isOverscrollUp`（および対応テスト）。
- `Header.tsx`/`ConnectionIndicator.tsx`: `historyMode` prop・履歴 notice。
- 実装後に `CLAUDE.md` の Terminal/履歴関連記述を更新。

## テスト

- `lib/__tests__/scrollback.test.ts`（新規）: seam 除去（画面含む/含まない・rows 以下・空・折返し確認結果に応じた境界）。
- `lib/__tests__/scroll-intent.test.ts`: `isOverscrollUp` のテストを削除、`isAtBottom` は維持。
- 既存テストの `historyMode` 参照を除去・更新。`pnpm check`・`pnpm test` 通過。
- 実機（iPhone Safari / PWA）で手動確認:
  - 最下部でライブ追従（色付き）→ そのまま上スクロールで履歴へ連続的に遡れる（切替感なし・慣性維持）。
  - 遡り読取中に出力が続いても読んでいる行が流れない。最下部へ戻ると ≤1 秒で最新に追いつく。
  - seam（履歴と画面の境目）に重複・欠落がない。
  - nvim / lazygit 等 alternate screen では履歴が出ず、タップ→クリック送信が現行どおり動く。
  - 横スクロール（全角・長行）・ピンチ・タップと競合しない。設定スライダーの行数が遡れる範囲に反映される。
