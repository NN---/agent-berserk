import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// `claude-code/testing` only resolves inside `claude plugin test`. Vitest has the same
// `test` and `expect`, so the pure-logic tests run in both runners unchanged.
export default defineConfig({
  resolve: {
    alias: { 'claude-code/testing': fileURLToPath(new URL('./node_modules/vitest/dist/index.js', import.meta.url)) },
  },
  test: {
    include: ['hooks/logic.test.ts', 'cli/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['hooks/logic.ts', 'cli/**/*.ts'] },
  },
})
