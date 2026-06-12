# browser-tab-iframe-webview 設計

## 背景・ユーザー要望

> 「ブラウザタブを開けると思うが、アプリで見たとしても見えないので、アプリの場合 iframe で webview を表示できる様にすることは可能か、可能なら対応したい」

cmux には `type: 'browser'` のサーフェス（ブラウザタブ）が存在する。PWA は現在すべてのサーフェスを `surface.read_text`（ターミナルテキスト）で描画するため、ブラウザサーフェスは内容が見えない／使えない。

## 実現性検証（ライブ cmux ソケットで実証済み）

| 検証項目 | 結果 |
|---|---|
| ブラウザサーフェスの URL 取得 | ✅ `surface.create({type:'browser', url})` で作成でき、`system.tree` の各サーフェスに `url` フィールドが入る（`title` はページタイトル）。現状の `ws.ts#flattenSurfaces` は `type` は通すが **`url` を破棄**している。 |
| 任意 URL の iframe 表示 | ⚠️ **原理的に不可能**。`browser_history.json` の実閲覧先は Google ログイン・AWS SSO・Microsoft OAuth・GitHub 等で、いずれも `X-Frame-Options: DENY/SAMEORIGIN` ／ CSP `frame-ancestors` を返すため `<iframe src=url>` では表示できない。ローカル開発 URL（履歴の `http://127.0.0.1:8000`）など、ヘッダを返さないサイトのみ埋め込み可能。 |
| 代替: スクリーンショット | ✅ `browser.screenshot` RPC が実在（本タスクでは採用しないが将来の選択肢）。 |

**結論**: 「任意 URL の iframe webview」は不可能。採用方針は **iframe + フォールバック**（埋め込み可能サイトは実際に閲覧でき、不可サイトは破綻させず情報提示＋「ブラウザで開く」導線を出す）。

## 採用方針: iframe + フォールバック

ブラウザサーフェスを `<iframe src={url}>` で表示する。埋め込み不可サイトでも UI を破綻させないため、iframe の上に常時ヘッダ（タイトル＋URL＋「新しいタブで開く」リンク）を表示する。これにより:

- **埋め込み可能サイト**（ローカル開発サーバー等）: アプリ内でそのまま閲覧できる。
- **埋め込み不可サイト**（Google 等）: iframe は空白／エラーになるが、ヘッダの「新しいタブで開く」で端末の実ブラウザに逃がせる。

X-Frame-Options によるブロックはクロスオリジンのため JS から確実に検知できない（ブロック時も `load` が発火しうる）。したがって「確実な検知」には依存せず、**常時表示のヘッダ導線**を信頼できる退避手段とする。読み込みタイムアウト（既定 3 秒）で `load` 未発火の場合のみ、補足の注意書きを表示する best-effort なヒントを添える。

## アーキテクチャと変更点（外科的・最小）

### 1. サーバー: `apps/server/src/ws.ts`
- `interface TreeSurface` に `url?: string | null` を追加。
- `interface FlatSurface` に `url: string | null` を追加。
- `flattenSurfaces` の `out.push({...})` に `url: surface.url ?? null` を追加。

これだけでブラウザサーフェスの URL がクライアントに届く。`surface.list → system.tree` 変換の整形ロジックは既存のまま。

### 2. クライアント型: `apps/client/src/lib/cmux-rpc.ts`
- `interface Surface` に `url?: string | null` を追加。

### 3. クライアント新規コンポーネント: `apps/client/src/components/BrowserView.tsx`
- props: `{ url: string; title: string; gestureRef }`。
- 構成: 上部に小さなヘッダバー（`title`、`url`、「新しいタブで開く」リンク = `<a href={url} target="_blank" rel="noreferrer">`）、下に `<iframe src={url}>`（`flex:1`）。
- iframe の `sandbox` は付けない（多くのサイトで JS が必要なため）。`referrerPolicy="no-referrer"`。
- `onLoad` で `loaded=true`。3 秒で未 `load` の場合のみ「このサイトは埋め込み表示に対応していない可能性があります」を控えめに表示。

### 4. クライアント分岐: `apps/client/src/App.tsx`（現 219 行付近）
- `currentSurfaceInfo?.type === 'browser'` かつ `url` あり → `<BrowserView url title gestureRef />` を描画。それ以外 → 既存の `<Terminal />`。
- ブラウザサーフェス選択時は `read_text` ポーリングを行わない（98-120 行の poll effect を `currentSurfaceInfo?.type !== 'browser'` で early-return）。
- `InputBar` はブラウザサーフェス時 `disabled`（ターミナル入力は無意味なため）。

> 注: `App.tsx` は別タスク「app-tab-delete-sync」、`useCmux.ts` は「app-tab-focus-priority」も触れる。変更は分岐追加のみに留め、result.md に明記する。`useCmux.ts` は変更不要。

## データフロー

```
cmux UDS (system.tree, url 付き)
  → ws.ts flattenSurfaces (url を保持)  ← 変更
  → surface.list レスポンス { surfaces:[{..., type, url}] }
  → useCmux listSurfaces → surfaces state（型に url 追加）
  → App.tsx: type==='browser' ? <BrowserView> : <Terminal>  ← 変更
```

## エラー処理
- `url` が無い／空のブラウザサーフェス: ヘッダのみ表示、iframe は描画せず「URL を取得できませんでした」を表示。
- 埋め込み不可サイト: ヘッダの「新しいタブで開く」で退避（前述）。

## テスト
- **サーバー (`bun test`)**: `ws.test.ts` の `flattenSurfaces` に、ブラウザサーフェス（`type:'browser', url:'https://example.com/'`）の `url` が保持されることを検証するケースを追加。`url` が無いターミナルは `url: null` になることも確認。
- **クライアント (`vitest` + @testing-library/react)**: `BrowserView.test.tsx` を新規追加。
  - `url` を渡すと `<iframe>` の `src` に反映される。
  - 「新しいタブで開く」リンクの `href` が `url` と一致する。
  - `title` が表示される。
- `cd apps/client && pnpm vitest run` と ルートで `pnpm check` を通す。

## スコープ外（YAGNI）
- スクリーンショット・ミラー表示（`browser.screenshot`）。
- ブラウザの操作（クリック・スクロール・URL ナビゲーション）の RPC マッピング。
- iframe ブロックのクロスオリジン確実検知。
