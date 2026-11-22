# TypeScript style

`tsc --noEmit` and ESLint are the gate. Both are strict, and each rule holds a specific invariant rather than a style preference.

## The type gate

`tsconfig.json` turns on `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters` and `noPropertyAccessFromIndexSignature`.

- `erasableSyntaxOnly`: no `enum`, `namespace` or parameter properties. Source stays close to what runs.
- `verbatimModuleSyntax`: a type-only import says so (`import type`).
- Imports between files spell `./logic.js`, not `./logic.ts`.
- Nothing goes in on the back of a `@ts-ignore` or a type widened to `any`. A file left out of the gate is visible in the config; a file inside with the check defeated is not.

## ESLint invariants

- **`no-eval`**, flat.
- **`security/detect-non-literal-regexp`**: a regexp built from input is a ReDoS primitive. Build patterns from literals.
- **`require-atomic-updates`**: state read before an `await` and written after it can lose a concurrent update.
- **The promise rules** (`no-floating-promises`, `no-misused-promises`, `await-thenable`, `return-await`): a promise nobody waits for is work that silently never happens.
- **The `no-unsafe-*` set and `no-explicit-any`**: `any` enters through `JSON.parse` and stored values. Narrow `unknown` with a function instead.
- **`ban-ts-comment`**: a `@ts-expect-error` must say why.
- **`no-non-null-assertion`**, **`consistent-type-imports`** and **`switch-exhaustiveness-check`**.

## What comes back is not what you stored

Treat values from `$.store` and every other outside source as `unknown`. A narrowing function turns it into a typed value or a stated failure (see `load` in `hooks/register.tsx`). Add types and keep the runtime check; declaring a shape and deleting the check that earned it is a net loss.

## Hook rules of the engine

- Helpers that receive `$` are top-level functions, not closures inside `register`, or `claude plugin validate` refuses them.
- `turn.step` is an `async function*` that returns `yield* next(...)`.
- Values a drawing reads live in `$.state` atoms declared in `types/index.d.ts`.
