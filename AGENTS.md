# berserk

A Claude Code mod: `/berserk` burns leftover quota before a window resets. The logic is pure and tested (`hooks/logic.ts`); `hooks/register.tsx` only wires it to the engine.

- Run `npm run check` before you submit ([check locally](docs/contributing/check-locally.md)).
- Keep new logic in `hooks/logic.ts` with a test in `hooks/logic.test.ts`. `register.tsx` stays thin ([tests](docs/contributing/tests.md)).
- Before editing TypeScript, read [TypeScript style](docs/contributing/typescript.md).
- Before editing Markdown, read [Markdown rules](docs/contributing/markdown.md).
- Never add a `@ts-ignore`, an `eslint-disable`, or an `any` to make a check pass; fix the cause or leave the file out.
- Never route to Fable unless the user typed `fable` or `full`. A test holds this.
- Keep everything here public: no personal data, internal names, tokens or private links in code, docs, tests or commit messages.
- Do not use an assistant's memory feature for project knowledge; put it in the repository.

## Where to look

| To learn | Read |
| --- | --- |
| How to contribute | [CONTRIBUTING](CONTRIBUTING.md) |
| What the mod does and how to install it | [README](README.md) |
| Style, tests, local checks | `docs/contributing/` |
