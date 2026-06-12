import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

// build 用の vite.config を継承しつつ（react プラグイン等）、テスト用の setup を追加する。
// setup では jsdom に欠けている localStorage を補う（vitest.setup.ts 参照）。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      setupFiles: ['./vitest.setup.ts'],
    },
  }),
)
