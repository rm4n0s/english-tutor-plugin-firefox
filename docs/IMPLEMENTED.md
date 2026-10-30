# Implemented

Log of the finished steps of [IMPLEMENTATION.md](IMPLEMENTATION.md), newest last.

## Step 1: Spec and plan
- Branch: feat/docs
- Date: 2026-10-30
- Spec: all (first draft)
- Done: CLAUDE.md (commands, conventions, error handling, security rules, the manager and implementer workflow), docs/SPEC.md (the extension's design, ported from the desktop app at v0.1.3 with every browser difference listed in §2.2), docs/IMPLEMENTATION.md (12 steps, rules, the screenshot harness), this file.
- Screenshots: none: no UI in this step
- Checks: no code yet, so format, typecheck, lint, test, build, lint:ext and screenshots do not apply; the documents were reviewed by hand
- Notes: decisions made in the spec, for the user to confirm: no content scripts in v1 (text from web pages is copied into the tutor page); LLM calls run in the pages, not in the background script; host permissions are requested per LLM origin at runtime; TypeScript with esbuild, vitest, eslint, prettier, web-ext and selenium-webdriver as the only (development) dependencies; files have no `file:` mistake source because a browser gives no path.

## Step 2: Skeleton and screenshot harness
- Branch: feat/skeleton
- Date: 2026-10-30
- Spec: §3, §3.1, §3.2, §4.2 (layout), §4.3 (colours, legend samples), §9.1, §10 (the `AppError` type), §11 (spec test)
- Done: `package.json` (all scripts of CLAUDE.md, only the dev dependencies of §3.1, no runtime dependency), `package-lock.json`, `.nvmrc` (24), `.gitignore`, strict `tsconfig.json`, `eslint.config.js` (typescript-eslint strict and stylistic type-checked rules, `no-floating-promises`, no `any`, `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval` / `new Function` banned, each checked with a throwaway file), prettier config, `vitest.config.ts` (node by default, `happy-dom` per file), `scripts/build.mjs` (esbuild, entry points background, tutor and options, copies manifest, HTML, CSS and icons into `dist/`). `src/manifest.json` as in §3.2, and icons at 16, 32, 48 and 96 px drawn by `scripts/make-icons.mjs` (the PNGs are committed). `src/core/errors.ts` (`AppError`, `wrap`, `via`, `route`, `hasRoute`), `log.ts`, `clock.ts` (with `FakeClock` in `core/testing`), `random.ts`, each with table-driven tests. The background script opens `tutor.html` in a new tab from the toolbar button, through `src/platform` wrappers, with a test on fakes. `tutor.html` with the §4.2 layout (two toolbar rows, the legend row with the three category samples in their colours and line styles, Clear and Copy, editor, issues list and explanation panel, two draggable dividers that also work with arrow keys, status bar), disabled widgets, light and dark themes, no `innerHTML`; `options.html` with its "LLMs" and "General" sections. `src/core/specs.test.ts` parses the §10 and §5.6 tables, checks that tags are unique, and keeps the allow-list of tags without a route test (all 23 for now; the test fails if a listed tag already has a route test, so the list only shrinks). `scripts/screenshots.mjs` and `scripts/fake-llm.mjs`: build, zip with web-ext, a fake OpenAI-compatible server on 127.0.0.1 (streaming or not, replies chosen by the scenario), headless Firefox through selenium-webdriver with the preferences of IMPLEMENTATION.md, one browser session per colour scheme, one named scenario with `npm run screenshots -- <name>`, exit 1 with the reason on failure.
- Screenshots:
  - docs/screenshots/step-02-skeleton/tutor-empty.png: the tutor page, light, all widgets drawn and disabled, empty editor
  - docs/screenshots/step-02-skeleton/tutor-empty-dark.png: the same page in the dark theme
  - docs/screenshots/step-02-skeleton/options-empty.png: the options page with its two empty sections
- Checks: format:check, typecheck, lint, test (7 files, 95 tests), build, lint:ext (0 errors, 0 notices, 0 warnings) and screenshots (3 scenarios, exit 0) all pass. `npm run package` also builds the zip. `npm run start` was not run (it needs a display). The toolbar button was checked by hand once through Firefox's own action trigger from the harness' chrome context: it opened `tutor.html` in a new tab. That check is not part of the committed scenarios.
- Notes:
  - Spec changes (SPEC §3.2): the manifest has `gecko.data_collection_permissions` = `{"required": ["websiteContent"]}` and `gecko_android.strict_min_version` = `142.0`. `web-ext lint` warns without the first (AMO requires it), and warns about the second once the first is set, because the data collection key needs Firefox for Android 142. Android is still unsupported. The category `websiteContent` is a choice for the user to confirm.
  - Plan changes (IMPLEMENTATION.md, Screenshot harness): `driver.get("moz-extension://...")` is refused for pages that are not web accessible ("Navigation ... is not allowed in this context"), and the manifest must not expose them. The harness therefore starts geckodriver with `--allow-system-access` and opens each page with `gBrowser.addTab` in the chrome context. The window is sized so that the page area, not the window, is 1280×800. The dark preference value was verified in Firefox 159: `layout.css.prefers-color-scheme.content-override` 0 is dark, 1 is light (the plan was right), and each scenario fails unless `matchMedia('(prefers-color-scheme: dark)')` matches the scenario's theme.
  - The fake server has one default canned check reply (§5.2). `src/core/llm/testing` does not exist yet, so nothing is shared with it; later steps can move the replies there.
  - `.prettierignore` lists `CLAUDE.md` and `docs/`, so prettier does not reformat the hand-written documents.
  - `AppError.wrap` returns an `AppError` unchanged, so that a tag is never replaced. `AppError.via` mutates and returns the same error.
  - npm warns that esbuild's postinstall is not covered by `allowScripts`; the build works without it, so nothing was approved.
