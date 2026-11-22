# Check locally

```sh
npm ci
npm run check
```

Use npm for dependencies and commit the updated `package-lock.json` when dependencies change.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the unit tests and the build. It skips the plugin tests and validation because they need the `claude` CLI.

`check` runs, in order:

| Script | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` under the strict config |
| `npm run lint` | ESLint, type-aware |
| `npm test` | Vitest unit tests for `hooks/logic.ts` and `cli/` |
| `npm run test:coverage` | the same, with a coverage report |
| `npm run test:plugin` | `claude plugin test .` (also runs `hooks/register.test.ts`) |
| `npm run validate` | `claude plugin validate .` |

The typecheck reads the engine's type file from `.claude-plugin/types/claude-code/index.d.ts`. It is committed so CI and new clones can typecheck without setup. Claude Code writes it, and rewrites it when it loads the mod from a folder you own (`claude --plugin-dir .`), so refresh it after a Claude Code upgrade and commit the change.

Try the mod without installing it: `claude --plugin-dir .`
