# Tests

Run the unit tests with `npm test` (Vitest). Run the engine tests with `npm run test:plugin` (`claude plugin test .`).

`hooks/logic.test.ts` imports `test` and `expect` from `claude-code/testing`. `vitest.config.ts` maps that name to Vitest, so the same file runs under both runners.

- **Pure logic first.** Anything that can be a function of its inputs lives in `hooks/logic.ts` and is tested in `hooks/logic.test.ts` with plain values. No engine, no clock, no stubs.
- **Wiring second.** `hooks/register.test.ts` drives the commands through stubbed engine calls (`clock`, `store`, `theme`, `session.usage`) with a fixed time.
- **Never read the real clock.** Time comes from `$.clock.now()`; tests pin it.
- **A rule gets a test.** The routing and safety rules are tested directly: Fable is never chosen outside `fable` and `full`, a run stops at 98% quota, and a start is refused at 98% or more.
- **Test the failure.** For each parser or narrowing function, add a case for input it must reject.
- **No `process.exit`** in code under test: the runner then reports the file as passing with zero failures.
