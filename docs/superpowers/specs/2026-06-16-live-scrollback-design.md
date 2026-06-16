# ライブ表示のスクロールバック統合 設計

- 日付: 2026-06-16
- ブランチ: `feat/live-scrollback`
- ステータス: 設計合意済み（実装計画はこの後 writing-plans で作成）

## 目的

ライブ（通常）表示のまま **上スクロールで過去の出力を遡れる** ようにする。遡れる行数は設定モーダルの
バッファ行数（`cmux:history-lines`、既定 2000）に従う。これにより「ライブ表示中は過去へ遡れない／
バッファ設定が効かない」という現状の制約を解消し、別モードとしての「履歴」ボタンを廃止して
**1 つのスクロール操作に統合**する。

## 背景・現状

- **ライブ表示** = `terminal.replay` の `render_grid`（今見えている画面ぶん・**色付き**）を毎秒ポーリング。
  スクロールバックを一切含まない。CLEAR して再描画するため wterm 側にも履歴が溜まらない。
- **履歴モード（「履歴」ボタン）** = `surface.read_text`（`scrollback:true, lines`）の**プレーンテキスト**
  （色・属性なし）を 1 回取得して固定表示。`historyMode` state でトグルしていた。
- 直前のバグ修正で、履歴（`grid=null`・プレーンテキスト）描画時に `.wterm` をビューポート高
  （wrapper の 100%）に収め、wterm 自身のスクロールバック（`has-scrollback` → `.wterm{overflow-y:auto}`）で
  縦スクロール・末尾（最新）追従できるようにした。本設計はこの描画をそのまま再利用する。

## 重要な制約（cmux 側）

- 色付きスクロールバックは取得できない。`terminal.replay` は可視画面のみ・`read_text` の scrollback は
  プレーンテキストのみ。→ **遡り部分は色なしテキスト、ライブの現在画面は色付き**になる。上スクロールで
  色付き→色なしの切替が一瞬見えるのは仕様（割り切り）とする。

## スコープ

- ライブ表示中、**上端でさらに上スクロール（オーバースクロール）** したらスクロールバックへ遷移し、
  過去を遡れる。
- スクロールバックを**上へ遡って読んだ後、最下部へ戻る**とライブ更新が自動再開する。
- 「履歴」ボタン（`Header` の `onToggleHistory`）を廃止。
- バッファ行数スライダー（`SettingsModal`）は「遡れる行数」として維持。

非対象（YAGNI）:
- 色付きスクロールバック（cmux 制約のため不可）。
- スクロールバックの無限増分ロード／ライブ追従中のスクロールバック逐次更新（取得は遷移時の 1 回）。
- 遡り中のライブ内容のリアルタイム反映（遷移中は更新停止＝凍結）。

## 設計の核：スクロール位置による状態遷移

既存の `historyMode` state とデータ経路（ポーリング effect・履歴取得 effect）を**そのまま流用**し、
**トグルの起点を「ボタン」から「スクロール位置」に置き換える**。`historyMode` は意味を
「`true` = 遡り中（ポーリング停止・スクロールバックのプレーンテキスト表示）」に読み替える。

状態遷移:

| 現状態 | トリガー | 次状態 | 動作 |
|---|---|---|---|
| `following`（`historyMode=false`・既定） | 上端で上方向オーバースクロール | 遡り（`historyMode=true`） | `readText(scrollback, lines=設定値)` を 1 回取得 → 凍結表示。ポーリング停止 |
| 遡り（`historyMode=true`） | 一度上へ遡った後、最下部へ復帰 | `following`（`historyMode=false`） | ポーリング再開（色付きライブ復帰） |

**即バウンド防止:** 遡りへ入った直後は wterm の自動追従で末尾（＝最下部）にいるため、単純な
「最下部 = ライブ復帰」だと即座に戻ってしまう。`hasScrolledUp` フラグを持ち、**一度上へ遡って
（＝最下部から離れて）から最下部へ戻った時のみ**ライブ復帰させる。

## スクロール検知（純粋ロジックを分離）

検知の純粋判定を `lib/scroll-intent.ts` に切り出し、DOM/タッチの副作用と分離して単体テスト可能にする。

```ts
// 上端での上方向オーバースクロール（= 遡りへ入る）か
export function isOverscrollUp(args: { scrollTop: number; deltaY: number; atTopEpsilon?: number }): boolean
// 最下部に到達したか（= ライブ復帰候補）
export function isAtBottom(args: { scrollTop: number; clientHeight: number; scrollHeight: number; epsilon?: number }): boolean
```

- `deltaY` の符号規約: **過去を見る方向（＝上スクロール／遡り）を負**とする。
  - `wheel`: `e.deltaY` をそのまま渡す（上スクロール時に負）。
  - タッチ: 指が**下方向**へ動くと上端のコンテンツが現れる＝遡りなので、`deltaY = startY - currentY`
    （指が下へ動く＝`currentY>startY`＝負）として渡す。
  - 進入条件は `scrollTop <= atTopEpsilon && deltaY < -threshold`。
- 閾値（`atTopEpsilon` / 進入 `threshold` / 復帰の `epsilon`）は定数化してハードコードを避ける。

`Terminal.tsx` 側:
- ライブ（grid あり）: スクロールコンテナは wrapper（`overflow:auto`）。`wheel`（`deltaY<0` かつ
  `scrollTop<=epsilon`）と `touchmove`（単指・上端で下方向ドラッグが閾値超え）で `onEnterHistory()` を発火。
  既存のタップ／右クリック判定・横スクロール・ピンチには干渉しない（縦上方向・上端のみで判定）。
- 遡り（grid なし）: 実スクロールコンテナ（直前のバグ修正で `.wterm` が `height:100%`＋`has-scrollback` の
  ときは `.wterm`、100% が解決できず伸びた場合は wrapper）の `scroll` を監視する。実装時に実際にスクロール
  する要素へリスナを付ける（既定は `.wterm`、フォールバックで wrapper）。最下部から離れたら
  `hasScrolledUp=true`、その後最下部復帰で `onExitHistory()` を発火。
- ライブの色付きグリッド描画ロジック自体は無変更。

## アーキテクチャ / コンポーネント境界

| 単位 | 役割 | 依存 | テスト |
|---|---|---|---|
| `lib/scroll-intent.ts` | スクロール意図の純粋判定（`isOverscrollUp`/`isAtBottom`） | なし | vitest 単体 |
| `components/Terminal.tsx` | スクロール/`wheel`/`touchmove` 検知 → `onEnterHistory`/`onExitHistory` 発火 | `scroll-intent` | 手動（実機） |
| `App.tsx` | `historyMode` 管理。`onEnterHistory=()=>setHistoryMode(true)` / `onExitHistory=()=>setHistoryMode(false)` を Terminal へ。ポーリング/履歴取得 effect は据え置き | useCmux | 手動 |
| `components/Header.tsx` | 「履歴」ボタン廃止（`onToggleHistory` 削除）。`historyMode` は鮮度表示用に受け渡し維持 | — | 手動 |

## データフロー

1. `following`: App が `readGrid(currentSurface)` を毎秒ポーリング → 色付きグリッドを Terminal に渡す。
2. ライブ上端で上オーバースクロール → Terminal が `onEnterHistory()` → App が `historyMode=true`。
3. 既存の履歴取得 effect が `readText(currentSurface,{scrollback:true,lines})` を 1 回取得 → `termContent` を更新 →
   Terminal は `grid=null` でプレーンテキストを描画（`.wterm` が末尾＝最新へ自動追従）。ポーリングは停止。
4. ユーザーが上へ遡る（`hasScrolledUp=true`）→ 最下部へ戻る → Terminal が `onExitHistory()` → App が
   `historyMode=false` → ポーリング再開で色付きライブに復帰。

## エラー処理 / エッジ

- `readText` 失敗（通信不良）: 既存どおりログのみ。直前のキャッシュ（`scrollback→text`）へフォールバック。
  遡りに入れても内容が出ない場合があるが、最下部復帰でライブに戻れる。
- タブ/サーフェス切替: 既存どおり `historyMode=false`（ライブ）にリセット。
- グリッドがビューポートより短く縦スクロール領域が無い場合でも、`wheel`/`touchmove` のイベント自体は
  発火するため上オーバースクロール検知は機能する。
- 横スクロール（全角・長行）やタップ／ピンチと競合しないよう、遡り進入は「単指・縦・上方向・上端」に限定。

## テスト

- `lib/__tests__/scroll-intent.test.ts`: `isOverscrollUp`（上端/非上端 × 上/下方向 × 閾値）、`isAtBottom`
  （境界・epsilon）を単体テスト。
- `pnpm check`（tsc + biome）通過。
- 実機（iPhone Safari / PWA）で: ライブ上スクロール→遡り→上へ読む→最下部復帰でライブ再開、慣性・
  rubber-band 下での誤発火が無いこと、横スクロール/タップ/ピンチと競合しないことを手動確認。

## 移行 / 後片付け

- `Header` の「履歴」ボタンとその props（`onToggleHistory`）を削除。`historyMode` 表示（「履歴 · HH:MM時点」）は維持。
- `CLAUDE.md` の該当記述（履歴モードはボタン、Terminal のスクロール記述）を実装後に更新。
