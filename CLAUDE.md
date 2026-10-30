# CLAUDE.md

Guidance for Claude Code when working in this repository (a Firefox WebExtension in TypeScript, hosted on GitHub).

## Project notes
English Tutor for Firefox is a browser extension that does in Firefox what the desktop app [rm4n0s/english-tutor](https://github.com/rm4n0s/english-tutor) does on Linux. The user writes English text in an editor page. An LLM the user configures (Ollama, an OpenAI-compatible server or Anthropic) finds grammar, vocabulary and syntax errors. The page underlines them, explains the selected one in markdown, suggests alternatives for a selection, and counts the user's mistakes by error type. With *page mode*, it does the same inside text boxes on web pages, on each site where the user said yes when asked (it is off on every site by default): underlines in the box, an error-count badge, an issues dialog, and an explanation popover on a click (SPEC §4.11). The design is in [docs/SPEC.md](docs/SPEC.md); read the relevant section before changing behaviour.

**Reference implementation.** The desktop app is the source of truth for prompts, parsing, locating, chunking, the error taxonomy, fingerprints and the statistics rules. SPEC.md §2.1 names the commit the port follows. Read it from GitHub, or clone it into a scratch directory outside this repo. Never vendor or copy its files into this repo: port the logic to TypeScript, with tests.

**Out of scope on purpose (v1):** writing corrections back into web pages' text boxes, canvas-based editors, the desktop app's web server, system tray, single-instance lock and desktop entry, sync and accounts (see SPEC §2).

## Commands
- Install: `npm ci`
- Build: `npm run build` (esbuild bundles `src/` into `dist/`)
- Run in Firefox: `npm run start` (`web-ext run -s dist`, uses a temporary profile)
- Test all: `npm test` (vitest, no browser needed)
- Test one file: `npx vitest run src/core/analysis/locate.test.ts -t "name"`
- Type check: `npm run typecheck` (`tsc --noEmit`)
- Lint: `npm run lint` (eslint) and `npm run lint:ext` (`web-ext lint -s dist --self-hosted`, after a build; `--self-hosted` because the manifest has `update_url`, which lint refuses for add-ons hosted by Mozilla)
- Format: `npm run format` (prettier --write); `npm run format:check` to verify
- Package: `npm run package` (`web-ext build -s dist`, into `web-ext-artifacts/`)
- Release (maintainer only, needs the AMO key in the environment or `.env`; never run by an agent): `npm run sign` (signs as unlisted on AMO) and `npm run release-files` (writes `release-out/<version>/` and prints the commands). See `docs/RELEASING.md`. Never open, read or print `.env`
- Screenshots: `npm run screenshots` (all scenarios) or `npm run screenshots -- <name>` (one). It drives the built extension in headless Firefox against a fake LLM server (fixed port 47811, or `FAKE_LLM_PORT`). It writes a PNG into `docs/screenshots/` only if it does not exist yet, or with `-- --update <name>` (repeatable) or `-- --update-all`; every other PNG goes to the gitignored `screenshots-out/`, so a plain run never changes a committed screenshot

## Definition of done
Before reporting a task as finished, run `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build` followed by `npm run lint:ext`, then `npm run screenshots`. Fix anything they report. If any step was skipped or failed, say so explicitly.

**Screenshots of every UI function.** Every implementation that adds or changes something the user can see adds a scenario per UI function to `scripts/screenshots.mjs`, and commits the screenshots it produces (`docs/screenshots/step-NN-<slug>/` for plan steps, `docs/screenshots/<branch-slug>/` otherwise). Look at each new screenshot before calling the work done: a screenshot that does not show the function working is a failure, not a formality.

## Implementation steps
- **Every finished step of `docs/IMPLEMENTATION.md` gets an entry in `docs/IMPLEMENTED.md`**, in the format given there, as the last commit of the step's branch. It lists the spec sections covered, what was done, the screenshots, the result of every check, and any spec changes. A step without its entry is not finished and is not published
- **Manager and implementers.** The main Claude Code session is the manager. It launches one Agent per step, one step at a time, with `model: "sonnet"` (Sonnet 5.5) and `effort: "high"`. Then it reviews the result: it re-runs every check, looks at the screenshots, and reads the diff against this file and the spec. It sends problems back to the same agent, and publishes the step only after the review passes (IMPLEMENTATION.md, Rules 2, 7 and 8)
- **If you are an implementing agent**, do the step yourself: do not launch agents, and do not merge into or push to `main`. That is the manager's job. Finish with all checks passing, the screenshots committed, and the IMPLEMENTED.md entry committed on the step's branch. Then report what you did, the check results, the screenshot paths, and anything in the spec you found wrong or had to decide

## Layout
- `src/manifest.json`: Manifest V3, Firefox only
- `src/core/`: logic with no DOM and no `browser.*` (analysis, llm, issues, store, markdown, view, errors). This is where most of the tests are
- `src/platform/`: the only code that calls `browser.*` APIs. It implements small interfaces that `core` and `ui` receive through constructors
- `src/background/`: event page with the toolbar button, context menus, keyboard command and notification clicks. It never calls an LLM
- `src/tutor/`: the editor page (the desktop app's main window)
- `src/options/`: the options page (the desktop app's Preferences dialog)
- `src/content/`: the page-mode content script: finds text boxes, draws the badge and underlines. It never calls an LLM and never sees API keys
- `src/page-ui/`: the page-mode frame (`page-ui.html`), an extension page inside web pages that runs the checks and shows the popover and the dialog
- `src/ui/`: DOM components shared by the pages
- Tests live next to the code (`foo.test.ts`)
- `scripts/`: build and screenshot scripts (plain Node.js)
- `docs/`: SPEC.md (design), IMPLEMENTATION.md (plan and its rules), IMPLEMENTED.md (log of finished steps), `screenshots/`

## TypeScript conventions
- `strict` mode. No `any`; use `unknown` and narrow. No `@ts-ignore` (use `@ts-expect-error` with a reason, and only in tests)
- Never ignore a rejected promise: `await` it, return it, or `.catch` it and report the error. No floating promises (eslint enforces this)
- Anything that does I/O (fetch, IndexedDB, `browser.*`) takes an `AbortSignal` where it can be cancelled, in an options object: `{ signal }`
- Tests are table-driven (`it.each` / `describe.each`)
- No global mutable state: no module-level `let` and no mutable singletons. Dependencies (store, clock, fetch, random, `browser` wrappers) are passed through constructors, so tests can use fakes
- Time comes from an injected `Clock` and randomness from an injected source, so time windows and delimiter tokens are testable
- The schema is created only by numbered IndexedDB migrations in `src/core/store/migrations.ts` (one function per version, never edited after release)
- Prefer the platform (DOM, `fetch`, `IndexedDB`, `crypto`) over libraries. Ask before adding any dependency not listed in SPEC §3. No runtime dependencies are approved

## Security rules (extension pages)
- Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `eval`/`new Function`. Build DOM with `createElement` and `textContent`. `web-ext lint` flags violations, and they are also a review blocker
- LLM output is untrusted (SPEC §5.9). Explanations go through the safe markdown renderer in `src/core/markdown` only. Alternatives are shown as plain text only
- Never log the user's text, LLM replies or API keys, and never put them in error metadata or messages. Token counts and timings may be logged
- Request host permissions per LLM origin at runtime (`permissions.request`). `<all_urls>` exists only as an optional host permission, requested when the user allows page mode (on the welcome page or in the options) and removed when it is turned off. Page mode reads nothing on a site until the user turns it on there. Never add static `content_scripts` or `host_permissions` to the manifest
- Content scripts run next to untrusted pages. Everything they add lives in a closed shadow root. They ignore untrusted events (`isTrusted === false`), read only the text boxes SPEC §4.11 allows (never password, payment or code fields), and pass text only over their `runtime` port to the page-mode frame. They never receive API keys or settings beyond what they need
- Adding a permission to the manifest is a spec change (SPEC §3.2)

## Error handling
All errors are `AppError` from `src/core/errors.ts`. Do not throw strings, plain `Error` or `new Error(...)` from application code.

**Creating errors**
- New failure: `new AppError("Tag", "message", { key: value })`
  - Tag: short PascalCase name of the failure, e.g. `LLMConfigNameTaken`. Every tag is listed in SPEC §10
  - Metadata holds small facts (ids, sizes, status codes), never user text, replies or keys
- Wrapping a foreign error (`DOMException`, `TypeError` from `fetch`, an IndexedDB error): `AppError.wrap("Tag", err, { key: value })`. The original goes in `cause`
- `AppError` records `where` (`"Class.method"`) for each layer that adds context: `err.via("Analyzer.check")`. A route is the `where` chain, outermost first, ending with the tag: `Analyzer.check->OpenAIClient.chat->LLMCallTimeout`

**Propagating errors**
- An `AppError` is rethrown as it is (optionally after `.via(...)`). Never wrap an `AppError` in another one: that would replace its tag
- Cancelling is not an error. Check `signal.aborted` (or an `AbortError` from a cancelled signal) before creating any tag, and return or reject with a dedicated `Cancelled` result that the UI ignores. A timeout (`AbortSignal.timeout`) is not a cancel: it becomes `LLMCallTimeout`

**Testing errors**
- Every new failure case gets its own unique tag and a test that asserts the route, not just that something failed:
  ```ts
  const err = await analyzer.check(text, { signal }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).hasRoute("Analyzer.check->OpenAIClient.chat->LLMCallTimeout")).toBe(true);
  ```
- `hasRoute` matches by substring. `src/core/specs.test.ts` checks that every tag in the SPEC §10 table has at least one route test

## Git and GitHub
- Never commit or push directly to `main`. Work on a branch named `feat/...` or `fix/...`
- **Exception:** if `docs/IMPLEMENTATION.md` exists, follow its Rules section for the steps it lists. Each step is done on its own branch, one at a time. A finished step (all Definition-of-done checks passing, screenshots committed, and the manager's review passed) is published to `main` by the manager with a fast-forward merge and push, without a PR, after its entry is added to `docs/IMPLEMENTED.md` on that branch. Never commit work for a step directly on `main`. Everything that file does not cover (other changes, fixes outside the listed steps) still follows the rule above
- Commit messages: imperative mood, e.g. "Add issue locator"
- PRs: short description, link the issue (`Closes #123`), keep them small
- No `.github/` directory and no GitHub Actions workflows: never add them. The Definition-of-done checks are run locally

## Don't
- Don't edit `dist/`, `web-ext-artifacts/` or other build output; rebuild instead
- Don't commit secrets, API keys, `.env` files, or `.web-extension-id` / signing credentials
- Don't call real LLM providers in tests: use the fake `fetch` in `src/core/llm/testing/`
- Never look for, list, open or read files outside this project folder (no Firefox profiles, home-directory configs or other projects). If something outside it is needed, ask the user to provide it. The exceptions are dependency source in `node_modules/` and the reference implementation read from GitHub (see Project notes)
