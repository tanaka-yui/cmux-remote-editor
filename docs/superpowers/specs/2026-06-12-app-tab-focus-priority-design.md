# app-tab-focus-priority 設計

## 背景・要望

PWA リモートビューアで、ローカル PC の cmux 側でタブ/ワークスペースを選択すると、
アプリの表示がその選択に「引っ張られて」追従してしまう。ユーザーはアプリ側の選択を
優先したい(アプリで一度選んだら、PC 側の選択でアプリ表示が勝手に切り替わらないように)。

設計意図(CLAUDE.md):「タブ・ワークスペース切替は PWA 側の表示のみ変更し、
ローカル cmux のフォーカスは奪わない」。

## 問題箇所

`apps/client/src/hooks/useCmux.ts` の3つのポーリング関数が、毎回 cmux 側の
`selected`/`focused` フラグへ強制追従している:

- `listWorkspaces` (L80-81): `selected` ワークスペースで `currentWorkspace` を上書き
- `listPanes` (L97-98): `focused` ペインで `currentPane` を上書き
- `listSurfaces` (L119-126): `selected` サーフェスで `currentSurface` を上書き(cmux selected を最優先)

## 修正方針

選択解決のロジックを純粋関数に抽出し、3関数で優先順位を統一する:

1. アプリが既に選択中 (`prev`) で、それがまだリストに存在 → `prev` を維持(**アプリ優先**)
2. アプリ未選択(初回など) → cmux の `selected`/`focused` を初期選択として採用
3. どちらも無い → リスト先頭へフォールバック(リモートで閉じられた時の退避)

これは `listSurfaces` が部分的に実装済みのロジックの**優先順位を反転**
(cmux selected チェックを prev チェックの後ろに回す)し、3関数で共通化するもの。

## 構成

### 新規: `apps/client/src/lib/selection.ts`

純粋関数。テスト可能。

```ts
export function resolveSelectedRef<T>(
  prev: string | null,
  list: T[],
  getRef: (item: T) => string,
  isActive: (item: T) => boolean,
): string | null {
  if (prev && list.some((i) => getRef(i) === prev)) return prev      // アプリ優先
  const active = list.find(isActive)
  if (active) return getRef(active)                                   // 初回: cmux selected
  return list[0] ? getRef(list[0]) : null                            // フォールバック
}
```

### 変更: `apps/client/src/hooks/useCmux.ts`

3関数を、それぞれ関数型 setState + `resolveSelectedRef` 呼び出しに置き換える。

- `listWorkspaces`: `setCurrentWorkspace((prev) => resolveSelectedRef(prev, wsList, (w) => w.ref, (w) => !!w.selected))`
- `listPanes`: `setCurrentPane((prev) => resolveSelectedRef(prev, paneList, (p) => p.selected_surface_ref, (p) => !!p.focused))`
- `listSurfaces`: `setCurrentSurface((prev) => resolveSelectedRef(prev, list, (s) => s.ref, (s) => s.selected))`

### 新規テスト: `apps/client/src/lib/__tests__/selection.test.ts`

- アプリ選択が存在する限り、ポーリング(cmux selected が別へ変化)で上書きされない
- 初回(`prev` が null)は cmux `selected`/`focused` を採用
- 選択対象がリストから消えたら先頭へ退避(グレースフルフォールバック)
- 空リストでは null

## 副次的な挙動変化(改善方向)

`listWorkspaces`/`listPanes` は現在フォールバックを持たない(active が無ければ未設定)が、
本修正で「選択対象が消えたら先頭へ退避」が入る。これは要望のグレースフルな
フォールバック維持に沿う改善。

## 検証

- `cd apps/client && pnpm vitest run`
- ルートで `pnpm check`(tsc + biome)

## ファイル重複の注意

別タスク「app-tab-delete-sync」も同じ `useCmux.ts` を編集する可能性がある。
変更は外科的に最小限に留め、result.md に変更ファイル・関数を明記する。
