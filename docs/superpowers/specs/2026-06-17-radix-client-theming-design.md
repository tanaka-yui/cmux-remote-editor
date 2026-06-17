# 設計: radix-ui による client 再スキン＋テーマ化（system/light/dark）

- 日付: 2026-06-17
- 対象: `apps/client`
- スコープ: 忠実な再スキン＋テーマ化（既存のレイアウト・操作感・挙動は維持し、内部を radix プリミティブに置換、色を CSS 変数化して system/light/dark に対応、アイコンを lucide-react に）

## 目的

iPhone/iPad のブラウザ・PWA から使う cmux リモートビューアのクライアントを次のように刷新する。

1. UI の振る舞い（ダイアログ・スイッチ・スライダー・テーマ切替セグメント）を **radix-ui のアンスタイルドプリミティブ**に置換し、フォーカストラップ・Escape・Portal・スクロールロック等の a11y を底上げする。
2. ハードコードされた配色を **CSS 変数（意味ベースのトークン）** に集約し、**system / light / dark** の3モードに対応する。テーマは**設定ダイアログ**で切り替えられる。
3. アプリ枠のアイコンを **lucide-react** に統一する。

非目標（やらないこと）:

- ビジュアルのリデザイン（レイアウト・余白・コンポーネント構成は現状を維持する）。
- `Terminal.tsx` の描画ロジック（wterm レンダリング・実測幅・MutationObserver・タッチ→マウス変換等）への変更。ターミナル本文の配色は wterm/ANSI の領域で、テーマ化の対象外。
- 既存の RPC 層・`useCmux`・サーバー側への変更。

## 採用スタック（決定事項）

- **Radix Primitives**（`@radix-ui/react-*`、アンスタイルド）。Radix Themes/Chakra は不採用。理由: 今の紺色テーマを 1:1 で維持でき、モバイル PWA でバンドル/実行コストが最小、選定スタック（radix + lucide）に一致。
- **lucide-react**（アイコン）。
- **自前テーマ層**（CSS 変数 + `data-theme` 属性 + `matchMedia`）。テーマ切替はライブラリ不要で約30行。

導入する radix パッケージ:

- `@radix-ui/react-dialog`（SettingsModal、モバイル Drawer）
- `@radix-ui/react-alert-dialog`（ワークスペースを閉じる確認）
- `@radix-ui/react-switch`（通知トグル）
- `@radix-ui/react-slider`（履歴バッファ行数）
- `@radix-ui/react-toggle-group`（テーマ切替セグメント）
- `lucide-react`

## アーキテクチャ

### テーマ層 — `lib/theme.ts` ＋ `useTheme` フック

責務: テーマ設定の永続化・実テーマの解決・DOM への反映・OS 設定追従。

- 型: `type ThemeSetting = 'system' | 'light' | 'dark'`、`type ResolvedTheme = 'light' | 'dark'`。
- 永続化: `localStorage('cmux:theme')`。`loadTheme(): ThemeSetting`（既定 `'system'`）、`saveTheme(t: ThemeSetting): void`。既存 `lib/settings.ts` と同じ流儀（`typeof localStorage === 'undefined'` ガード）。
- 解決: `resolveTheme(setting: ThemeSetting): ResolvedTheme`。`'system'` のときのみ `matchMedia('(prefers-color-scheme: dark)').matches` を参照。`matchMedia` 非対応環境は `'dark'` にフォールバック。
- 反映: `applyTheme(resolved: ResolvedTheme): void`。`document.documentElement.setAttribute('data-theme', resolved)` と、`<meta name="theme-color">` を実テーマの `--color-bg` 相当値に更新。
- フック `useTheme()`: `{ setting, resolved, setTheme(t) }` を返す。`'system'` の間は `matchMedia` の `change` を購読し、OS 切替に即追従して再 `applyTheme`。`setTheme` は即 `saveTheme` ＋ `applyTheme`（保存ボタンを待たず即時反映）。

### FOUC 防止 — `index.html` のインライン初期化スクリプト

`<head>` 内に極小スクリプトを1つ置き、React マウント前に `localStorage('cmux:theme')` を読んで `resolveTheme` 相当の判定を行い、`document.documentElement.setAttribute('data-theme', …)` を即セットする。これにより初回描画でのテーマちらつきを防ぐ。現状 CSP は無いため inline script で問題ない。

### カラートークン — `styles/theme.css`（新設、`global.css` から import）

`:root[data-theme="dark"]` と `:root[data-theme="light"]` に変数値を定義する。dark は**現状のハードコード値を 1:1 維持**（見た目不変）、light は派生値。

| トークン | 用途 | dark（現状維持） | light（派生） |
|---|---|---|---|
| `--color-bg` | アプリ背景・アクティブタブ背景 | `#1a1a2e` | `#f4f5f7` |
| `--color-surface` | Header/TabBar/InputBar/Dialog 面 | `#16213e` | `#ffffff` |
| `--color-sidebar` | Drawer 面 | `#0f1729` | `#f0f1f4` |
| `--color-control-bg` | 入力欄・キー背景 | `#1a1a2e` | `#ffffff` |
| `--color-border` | 標準ボーダー | `#2a2a4e` | `#d8dbe0` |
| `--color-border-subtle` | 区切り線（`#1e2a42`/`#1a2340`を統合） | `#1e2a42` | `#e6e8ec` |
| `--color-text` | 本文 | `#e0e0e0` | `#1a1a2e` |
| `--color-text-muted` | 副次ラベル（`#aaa`/`#ccc`相当） | `#aaaaaa` | `#5b6370` |
| `--color-text-subtle` | 補足（`#777`/`#888`/`#666`/`#555`/`#999`相当） | `#777777` | `#8a909a` |
| `--color-accent` | 送信/保存/アクティブ | `#4caf50` | `#43a047` |
| `--color-accent-contrast` | アクセント上の文字 | `#ffffff` | `#ffffff` |
| `--color-danger` | エラー/閉じる/未読バッジ | `#e74c3c` | `#d32f2f` |
| `--color-warning` | Needs input | `#f39c12` | `#e08600` |
| `--color-scrim` | モーダル背景 | `rgba(0,0,0,.6)` | `rgba(0,0,0,.35)` |
| `--color-selected` | 選択行ハイライト | `rgba(255,255,255,.08)` | `rgba(0,0,0,.06)` |
| `--color-key-armed-bg` | 武装中キー背景 | `#4a5a9a` | `#dbe2ff` |
| `--color-key-armed-border` | 武装中キー枠 | `#6a7ace` | `#9db0ff` |
| `--color-key-armed-text` | 武装中キー文字 | `#ffffff` | `#1a1a2e` |
| `--color-terminal-bg` | ターミナルビューポート背景（全テーマ固定ダーク） | `#1a1a2e` | `#1a1a2e` |

補足:

- 既存の微妙に異なるグレー（`#aaa`/`#ccc`/`#777`/`#888`/`#666`/`#555`/`#999`）は上記 muted/subtle の2段へ寄せる（忠実性を保ちつつトークンを増やしすぎない）。dark 値は近似で、見た目の差は無視できる範囲。
- ワークスペース識別色 `DEFAULT_PALETTE`（Drawer）はユーザー識別用途のため**テーマ非依存で据え置き**。
- ターミナルのビューポート背景は `--color-terminal-bg`（全テーマでダーク固定）を使い、light でもターミナルはダークのまま。ANSI/wterm の描画には一切触れない。

## コンポーネント別の変更

アイコン方針: **アプリ枠のアイコンのみ lucide に置換**（Menu / Settings / X / Plus / Keyboard / テーマ用 Monitor・Sun・Moon）。**キーボードのキー字形（Esc・Tab・Ctrl・Shift・Opt・⌫・⏎・矢印）は物理キーの表現として glyph のまま据え置く**。

| コンポーネント | 変更内容 |
|---|---|
| **SettingsModal** | `react-dialog` 化（Portal・フォーカストラップ・Escape・スクロールロック・scrim が標準で付く）。中身は「設定ダイアログのレイアウト」節へ刷新。閉じるボタンは lucide `X`。 |
| **テーマ切替（新規 UI）** | `react-toggle-group`（`type="single"`）のセグメント `[System｜Light｜Dark]`。各々 lucide `Monitor`/`Sun`/`Moon`。**選択で即時反映＋即永続**（保存ボタンに依存しない）。 |
| **通知トグル** | `<input type=checkbox>` → `react-switch`。挙動は従来どおり即時購読/解除。非対応環境は `disabled` ＋注記。 |
| **履歴バッファ** | `<input type=range>` → `react-slider`。数値入力（`<input type=number>`）と draft→保存フローは従来どおり維持。 |
| **Header** | `&#9776;`→lucide `Menu`、`&#9881;`→lucide `Settings`。配色をトークン化。構造維持。 |
| **TabBar** | 構造維持（radix Tabs は close＋横スクロール＋追加＋wterm フォーカス事情に不一致のため不採用）。`&times;`→`X`、`+`→`Plus`。アクティブ下線＝`--color-accent` 等トークン化。 |
| **Drawer** | **モバイルのオーバーレイ→`react-dialog`**（フォーカストラップ/Escape/スクロールロックの a11y 改善）。**デスクトップのピン留めサイドバーは素の `<nav>` のまま**（非モーダル、構造維持）。閉じる `X`／新規 `Plus`。スライド遷移は radix の `data-state` ベースで現行同等を維持。配色トークン化。`window.confirm` は下記 AlertDialog に置換。 |
| **ワークスペースを閉じる確認** | `window.confirm` → `react-alert-dialog`（テーマ適用可・見た目統一）。「OK」で `onCloseWorkspace`、キャンセルで何もしない。 |
| **InputBar** | 配色を全トークン化。⌨ トグルを lucide `Keyboard` に。キー字形と Send テキストは据え置き。武装キーは `--color-key-armed-*`。 |
| **ConnectionIndicator** | 配色トークン化（接続=accent/緑系、切断=danger、履歴/オフライン鮮度の文字色は muted/subtle）。状態色は意味トークンに割当。 |
| **TokenGate** | 配色トークン化のみ（ログイン画面）。 |
| **ErrorBoundary** | 配色トークン化（inline/full 両モード）。警告に lucide `AlertTriangle` を任意で付与。 |
| **BrowserView** | 配色トークン化のみ（該当箇所があれば）。 |
| **Terminal** | 描画ロジック不可侵。ビューポート背景に `--color-terminal-bg`（全テーマでダーク固定）を使うだけ。 |

### 設定ダイアログのレイアウト（上から）

1. ヘッダー: 「設定」＋右上に閉じる `X`（lucide）。
2. **テーマ**: `[⧉System｜☀Light｜☾Dark]` セグメント。選択で即時反映＋即永続。
3. **通知（Web Push）**: Switch。非対応環境は `disabled` ＋注記（従来文言）。
4. **履歴バッファ（行数）**: Slider ＋ 数値入力。保存で確定（従来どおり）。
5. フッター: キャンセル／保存。テーマ・通知は即時反映のため、保存対象は実質「履歴行数」のみ（現行挙動を踏襲）。

## データフロー

- `App`/`Main` に `useTheme()` を組み込み、`setting`/`resolved`/`setTheme` を保持。`SettingsModal` には `themeSetting` と `onThemeChange` を props で渡す（既存の `historyLines`/`pushEnabled` と同じ受け渡しパターン）。
- テーマ反映は `useTheme` 内の effect（`applyTheme` + `matchMedia` 購読）に集約。`App` 側は描画にトークンを使うだけ。
- 既存の設定（履歴行数・push）の状態管理・保存タイミングは不変。

## テスト計画（テスト先行 / TDD）

### 新規

- `lib/theme.test.ts`: `loadTheme`/`saveTheme`（既定 `'system'`、localStorage 永続）、`resolveTheme`（`'system'`→`matchMedia` 結果、`'light'/'dark'`→そのまま、`matchMedia` 非対応→`'dark'`）、`applyTheme`（`data-theme` 属性付与＋`theme-color` 更新）、OS 設定変更の `change` 購読で解決テーマが更新される（`matchMedia` をモック）。
- `SettingsModal.test.tsx`（新設）: Dialog の開閉、テーマセグメント選択で `onThemeChange` が即発火、Switch（通知）、Slider＋数値入力の保存フロー。
- Drawer の AlertDialog テスト: 閉じる→確認ダイアログ→「OK」で `onCloseWorkspace` 発火／キャンセルで未発火（`window.confirm` モック依存を廃止）。

### 既存の更新

- `Drawer.test.tsx`: モバイル経路が radix Dialog（Portal 描画）になるためクエリ調整。デスクトップ `<nav>` 経路は維持。
- `InputBar.test.tsx`: 挙動不変。アイコン化箇所は glyph でなく `aria-label` で参照するよう調整。
- `Terminal` / `ErrorBoundary` / `BrowserView`: ロジック不変。色変更が挙動に影響しないことを確認。

### テスト環境のシム

radix の一部（Slider/Dialog）が jsdom で要求する `ResizeObserver`・`matchMedia`・`PointerEvent`・`scrollIntoView` 等の不足モックを vitest セットアップへ追加。

### 完了条件

- `pnpm check`（tsc + biome）グリーン。**`any`/`unknown` 不使用・不要な `class` 不使用**。Biome 規約（シングルクォート・セミコロンなし・行幅120）準拠。
- `pnpm test` 全グリーン。
- 手動確認: system/light/dark の切替、リロード時に FOUC 無し、`theme-color` メタ追従、モバイル Drawer のフォーカストラップ、ターミナルが全テーマでダーク維持。

## リスクとエッジケース

- `matchMedia` 非対応環境は `'system'`→`'dark'` フォールバック。
- iOS PWA は `theme-color` 動的更新の反映が一部バージョンで遅延し得る（許容）。
- 既存のインライン色をトークン化漏れしないよう、着手前に `apps/client/src` 内の `#` 直書き色・`rgba(` を全件洗い出してマッピング表と突き合わせる。
- radix Dialog 化に伴い Drawer/SettingsModal の DOM 階層（Portal）が変わるため、既存テストのセレクタ更新が必要。

## 実装順序（目安）

1. テーマ層（`lib/theme.ts` + `useTheme`）とトークン（`styles/theme.css`）、`index.html` の FOUC 防止スクリプト — テスト先行。
2. SettingsModal を radix Dialog 化＋テーマ切替セグメント追加（Switch/Slider 置換含む）。
3. Header / TabBar / InputBar / ConnectionIndicator / TokenGate / ErrorBoundary / BrowserView / Terminal の色トークン化＋lucide アイコン化。
4. Drawer のモバイル Dialog 化＋ AlertDialog（閉じる確認）。
5. 既存テスト更新・新規テスト・シム整備、`pnpm check` / `pnpm test` グリーン化。
