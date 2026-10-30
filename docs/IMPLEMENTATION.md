# Implementation plan

Steps for building English Tutor for Firefox as described in [SPEC.md](SPEC.md). Finished steps are recorded in [IMPLEMENTED.md](IMPLEMENTED.md).

## Rules

1. **One step at a time, in the order listed.** A step starts from an up-to-date `main` (`git switch main && git pull --ff-only`).
2. **Manager and implementers.** The main Claude Code session is the *manager*. It does not write the code of a step. For each step it launches one implementing agent with the Agent tool: model `sonnet` (Sonnet 5.5), effort `high`. The prompt names the step, the branch, and anything learned in earlier steps that the step needs. The implementing agent does the whole step itself and does not launch agents of its own. Steps run one after another, never in parallel, because each builds on the one before.
3. **Each step has its own branch**, named `feat/<slug>` as given in the step. Never commit work for a step directly on `main`.
4. **A step is finished only when every check passes** on its branch:
   - `npm run format:check`
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run build`, then `npm run lint:ext`
   - `npm run screenshots` (from step 2 on), which must exit with 0

   The implementing agent fixes anything they report. If a check cannot be run or fails, the step is not finished and nothing is published. The failure or skipped check is reported to the user.
5. **Screenshots.** Every step that adds or changes something the user can see adds scenarios to `scripts/screenshots.mjs`, one per UI function it implemented, and commits the PNG files under `docs/screenshots/step-NN-<slug>/` (for example `docs/screenshots/step-06-check/underlines.png`). A scenario sets up the state through the UI (typing, clicking, keys) against the fake LLM server, and takes one screenshot of the whole page at 1280×800. A function whose look differs in the dark theme gets a second `-dark.png`. The step's IMPLEMENTED.md entry lists its screenshots. Earlier scenarios must keep passing, and their PNGs are regenerated only when the step changed what they show. A screenshot must not show anything that varies between runs (a port, a duration, a date), so a plain `npm run screenshots` never changes a committed file: it writes only PNGs that do not exist yet, and puts the others in the gitignored `screenshots-out/`. A PNG is overwritten on purpose with `npm run screenshots -- --update <name>` (repeatable) or `--update-all`, and only for the scenarios the step changed. After regenerating, a second plain run must leave `git status` clean. A scenario that fails leaves what the browser showed at that moment in `screenshots-out/failed/<name>.png`. A scenario whose name is already taken by an earlier step's can set `file`, the name of its PNG.
6. **Add the step's entry to `docs/IMPLEMENTED.md` on the branch**, as the last commit of the step (format below). Every finished step gets an entry. A step without one is not finished.
7. **Review by the manager.** When the agent reports back, the manager checks out the branch and runs every check of rule 4 itself. It looks at each new screenshot (Read tool) and compares it with the SPEC section the step covers. It reads the diff for violations of CLAUDE.md (innerHTML, `any`, plain `Error`, logged text, new dependencies). If something is wrong, the manager sends it back to the same agent (SendMessage) with the specific problems, and repeats this review.
8. **Publish by fast-forward, without a PR:** `git switch main && git merge --ff-only feat/<slug> && git push origin main`. The manager does this after its review. If `main` has moved, rebase the branch on `main`, run the checks again, and then merge. After publishing, delete the local branch.
9. **No `.github/` directory and no GitHub Actions.** The checks run locally.
10. **Dependencies:** only the development dependencies of SPEC §3.1 are approved. Anything else needs the user's approval before it is added. There are no runtime dependencies.
11. **Code conventions** are those in CLAUDE.md: `AppError` with a route test per tag, table-driven tests, no global mutable state, `AbortSignal` for cancellable I/O, the schema only through numbered IndexedDB migrations, no `innerHTML`.
12. **The spec follows the code.** If a step shows that SPEC.md is wrong or incomplete, the fix to SPEC.md is part of that step and is mentioned in its IMPLEMENTED.md entry.
13. **Changes not listed here** (fixes after a step is published, extra features) follow the normal rule in CLAUDE.md: a `feat/...` or `fix/...` branch, and a PR instead of a direct publish.
14. Commit messages are in the imperative mood ("Add IndexedDB migrations").
15. **The reference implementation** (SPEC §2.1) is read from GitHub at the pinned commit, or from a clone in a scratch directory outside this repo. Its files are never copied into this repo; their logic is ported, with tests.

### Format of an IMPLEMENTED.md entry

```
## Step N: <title>
- Branch: feat/<slug>
- Date: YYYY-MM-DD
- Spec: sections covered
- Done: what was added
- Screenshots: docs/screenshots/step-NN-<slug>/*.png, one line per file with what it shows (or "none: no UI in this step")
- Checks: format, typecheck, lint, test, build, lint:ext, screenshots (results; say if any were skipped and why)
- Notes: spec changes, decisions, known limits
```

### Screenshot harness

`npm run screenshots` runs `scripts/screenshots.mjs` (Node, plain JavaScript so it needs no build). It:

1. Builds `dist/` and zips it with `web-ext build`.
2. Starts a fake LLM server on `127.0.0.1` at a fixed port (47811, or the one in the env var `FAKE_LLM_PORT`), so that the address visible in the screenshots is always the same. If the port is busy the run fails at once and says so. It speaks the OpenAI-compatible wire format (section 6 of the spec, streaming too) and answers from canned replies chosen by the scenario. It reuses the canned replies of `src/core/llm/testing` where it can.
3. Starts headless Firefox through `selenium-webdriver` (Selenium Manager fetches geckodriver) with a fresh profile and these preferences:
   - `extensions.webextensions.uuids` = `{"english-tutor@rm4n0s.dev": "<fixed uuid>"}`, so the pages have known `moz-extension://` addresses;
   - `extensions.webextOptionalPermissionPrompts` = `false`, so the host permission of the fake server is granted without a prompt;
   - `ui.prefersReducedMotion` = 1, so that the spinner of the page-mode badge (in a closed shadow root that the harness cannot reach to pause its animation) stands still and its screenshot is the same on every run;
   - for dark scenarios, `layout.css.prefers-color-scheme.content-override` = `0` (verified in Firefox 159: 0 is dark, 1 is light, 2 follows the system). The preference is per profile, so dark scenarios run in their own browser session, and every scenario checks `matchMedia('(prefers-color-scheme: dark)')` so that a wrong scheme fails the run.
4. Installs the zip as a temporary add-on, sizes the window so that the page area is 1280×800 (the window is larger by the height of the browser's own toolbar), and runs each scenario: open the page, configure the fake LLM through the options page (or by a test-only `storage` seed shared by all scenarios), drive the UI, and save `driver.takeScreenshot()` to the scenario's file.
   Selenium cannot navigate to a `moz-extension://` address itself (a page that is not web accessible is refused), so the harness starts geckodriver with `--allow-system-access` and opens each page from the browser's chrome context with `gBrowser.addTab(url, { triggeringPrincipal: <system principal> })`, as a click on the toolbar button would. The manifest has no `web_accessible_resources`.
5. Runs one named scenario with `npm run screenshots -- <name>`, and all of them without arguments. It exits with 1 if any scenario fails, after printing which one and why.
6. Write policy: a PNG goes to `docs/screenshots/` only if it does not exist yet, or its scenario is named with `--update <name>` (repeatable) or all scenarios with `--update-all`. Every other PNG goes to `screenshots-out/` (gitignored, same layout) so that it can still be looked at. Values that vary between runs are made stable by the harness: for example a "connection works (N ms)" line is given a fixed delay by the fake server and rounded to a tenth of a second in the page right before the shot (`ctx.roundDuration`), never in product code.

## Steps

Steps 13 to 15 add page mode (SPEC §4.11). Steps 6 to 12 already build the issues list, the explanation panel, the issue state and the per-text check controller as components that do not depend on the tutor page (`src/ui/`, `src/core/issues/`), so that `page-ui.html` and the content script can reuse them.

### Step 1: Spec and plan (`feat/docs`)
- CLAUDE.md, docs/SPEC.md, docs/IMPLEMENTATION.md, docs/IMPLEMENTED.md.
- Done by the manager. There is no code, so only the review of the documents applies.

### Step 2: Skeleton and screenshot harness (`feat/skeleton`)
- Spec: §3, §3.1, §3.2, §9.1, §10 (the `AppError` type), §11 (spec test).
- `package.json` with the scripts named in CLAUDE.md and the approved dev dependencies, `package-lock.json`, `.nvmrc` (24), `.gitignore` (`node_modules/`, `dist/`, `web-ext-artifacts/`), `tsconfig.json` (strict), `eslint.config.js` (typescript-eslint, `no-floating-promises`, no `innerHTML` via `no-restricted-properties`), prettier config, `vitest.config.ts`, and `scripts/build.mjs` (esbuild: three entry points, copies the manifest, HTML, CSS and icons).
- `src/manifest.json` as in §3.2, with all permissions, the command and the options page. Icons at 16, 32, 48 and 96 px (simple PNG drawn by a script, or SVG).
- `src/core/errors.ts` (`AppError`, `wrap`, `via`, `route`, `hasRoute`), `src/core/log.ts`, `src/core/clock.ts`, `src/core/random.ts`, with tests.
- Background script: the toolbar button opens `tutor.html` in a new tab (focusing comes in step 12).
- `tutor.html` with the layout of §4.2: toolbar rows, legend row, editor area, right column with the two dividers, and the status bar. Widgets are drawn but inactive, and the light and dark themes work. `options.html` with its two empty sections.
- `src/core/specs.test.ts`: parses the §10 table and the §5.6 table from `docs/SPEC.md`. For now it only checks that every tag is unique (the route-test check grows as tags appear; a tag whose code does not exist yet is listed in an allow-list that later steps shrink).
- The screenshot harness of the Rules section, with the fake LLM server answering one canned reply.
- Screenshots: `tutor-empty.png`, `tutor-empty-dark.png`, `options-empty.png`.

### Step 3: Store (`feat/store`)
- Spec: §9, §4.2 (shared data), §10 (store tags).
- `src/core/store`: the promise wrapper over IndexedDB, `migrations.ts` with migration 1, and `Store` with configs (CRUD, unique name), documents (CRUD, list by update), and settings (typed getters with the defaults of §9).
- The `BroadcastChannel` messages of §4.2, behind an interface in `src/platform`.
- Tests with `fake-indexeddb`: migrations from empty, CRUD, the tags `DatabaseOpenFailed`, `MigrationFailed`, `DatabaseQueryFailed`, `LLMConfigNameTaken`, `LLMConfigNotFound`, `DocumentNotFound`, and settings defaults.
- Screenshots: none: no UI in this step.

### Step 4: LLM layer and options page (`feat/llm`)
- Spec: §6, §4.7, §5.8 (usage extraction), §10 (llm tags).
- `src/core/llm`: config validation (`LLMConfigInvalid`, `UnknownProvider`), the three clients (non-streaming and streaming), SSE and NDJSON parsers that cope with any split, usage and stop reason, estimates, No thinking, timeout versus cancel, `HostPermissionDenied`, `LLMCallFailed` (with the Ollama 403 message), and `LLMCallTimeout`.
- `src/core/llm/testing`: the fake `fetch` with canned replies for each provider.
- Options page: the LLM list and form of §4.7, with provider switching, Ollama's default URL, the key handling, the privacy note, host permission requests in the click handler, Test connection, delete with permission removal, and the General section (auto-check, delay, fonts). It saves through the store and broadcasts changes.
- The screenshot harness configures the fake LLM through this form from now on.
- Screenshots: `options-llm-list.png`, `options-llm-form.png` (new LLM, privacy note visible), `options-test-ok.png`, `options-test-failed.png`, `options-general.png`, `options-llm-form-dark.png`.

### Step 5: Analysis core (`feat/analysis`)
- Spec: §5.2, §5.3, §5.4 (prompt and context), §5.6, §5.7 (fingerprint), §5.10 (prompt and parser), §2.1.
- Port from the reference commit: taxonomy (ids, labels, categories, `_other` mapping), the check, retry, explanation and alternatives prompts word for word, the delimiter token, reply parsing, the locator, chunking (`SplitChunks` with the parallel sizes), the analyzer (parallel chunks, merge in order, first failure cancels the rest, one retry), the fingerprint, the explainer (context rule, cache, one at a time), and the suggester (limits, parser, retry).
- Tests ported from the reference tests where they exist, plus the randomised locator test. The `specs.test.ts` taxonomy check is switched on.
- Screenshots: none: no UI in this step.

### Step 6: Tutor page and Check (`feat/check`)
- Spec: §4.2, §4.3 (mirror, colours, legend, loading layer), §4.4 (rows, header, empty states), §4.9, §5.1 (manual check, cancel, failure), §5.8 (status bar).
- The LLM selector with the remembered selection and the empty state. Check and Cancel (`Ctrl+Enter`). The mirror layer with the category styles and the selected-issue background. The legend toggles. The issues list rows, header and empty states. The status bar with states, word count and tokens. The banner. The loading layer with its 10-second line. Token usage stored per request.
- `src/core/issues`: the issue state used by the editor and the list.
- Screenshots: `no-llm.png` (hint and disabled Check), `before-check.png`, `checking.png` (loading layer), `underlines.png` (all three styles), `underlines-dark.png`, `legend-hidden.png` (one category hidden, "Issues (3 of 5 shown)"), `no-errors.png`, `check-failed.png` (banner), `check-cancelled.png`.

### Step 7: Selection, navigation and edits (`feat/selection`)
- Spec: §4.3 (caret selection, tooltip, F7), §4.4 (shared selection, keys, double click), §5.5, §5.1 (auto-check).
- Caret and list selection kept in step through the issue state. Scroll into view. Tooltips from the mirror's rectangles. `F7` / `Shift+F7` with wrapping and hidden categories. Edit detection by common prefix and suffix, rebasing, the edit log during a check and its overflow, touched issues removed at once. Auto-check with its debounce, not recorded.
- Screenshots: `selected-from-text.png`, `selected-from-list.png`, `tooltip.png`, `after-edit.png` (a touched issue gone, a later one moved), `auto-check.png` (no badge).

### Step 8: Explanation panel (`feat/explain`)
- Spec: §4.5, §5.4, §5.9 (markdown renderer).
- `src/core/markdown` with its property test. The panel states, streaming with the 100 ms throttle and follow-scroll, the cache per check result, Cancel, Regenerate and Retry, the link confirmation and opening in a new tab, the no-LLM failed state.
- Screenshots: `explain-loading.png`, `explain-streaming.png`, `explain-ready.png`, `explain-ready-dark.png`, `explain-failed.png`, `explain-cancelled.png`, `link-confirm.png`.

### Step 9: Statistics and usage (`feat/stats`)
- Spec: §5.7, §5.8, §4.4 (badges), §4.5 (header counts, Not an error), §4.8.
- `store.Stats`: record with de-duplication and the ignore set in `storage.session`, notAnError, moveSource, typeStats, countForType, recentExamples, summarize, resets, usage totals. Recording after manual checks only. Badges and header counts. Not an error from the panel and the row's menu. The Statistics dialog with both tabs, sorting, filters, examples and resets. Broadcast of `stats-changed`.
- Screenshots: `badges.png`, `header-counts.png`, `stats-mistakes.png`, `stats-examples.png`, `stats-filtered.png`, `stats-tokens.png`, `stats-reset-confirm.png`, `stats-dark.png`.

### Step 10: Alternatives and selection check (`feat/alternatives`)
- Spec: §4.3 (right-click menu), §4.6, §5.1 (checking a selection), §5.10.
- The editor's context menu entries through `menus.overrideContext`, shown and enabled as §4.3 says, and handled only by the matching tab. The Alternatives panel with its states, double-click replacement through `execCommand("insertText")` with the guard, Copy, Close and cancel. Checking a selection with the merge of results.
- Screenshots: `context-menu.png` (if the harness can capture the native menu; otherwise note it in the entry and capture the state right after choosing an entry), `alternatives-loading.png`, `alternatives-ready.png`, `alternatives-failed.png`, `alternatives-replaced.png`, `selection-check.png` (issues outside the selection unchanged).

### Step 11: Saving and the library (`feat/saving`)
- Spec: §8, §5.7 (sources), §4.2 (tab title, per-tab state, `beforeunload`).
- New and Clear, Copy, Open with the checks of §8, Save and Save As through `downloads`, the Library dialog (open, rename, delete), Save to library with the title dialog and the source move, the unsaved-changes dialog, the tab title, and per-tab restore from `sessionStorage`.
- Screenshots: `open-file.png` (opened file in the editor), `open-failed.png` (banner for a non-UTF-8 file), `save-to-library.png` (title dialog), `library.png`, `unsaved-changes.png`, `restored-after-reload.png`.

### Step 12: Browser integration and polish (`feat/browser`)
- Spec: §4.1, §4.10, §7 (updates), §4.7 (fonts), §4.2 (pane sizes, narrow layout), §11 (background tests).
- Tutor tab discovery and focusing for the toolbar button and the `open-tutor` command, the button's own menu, the web page menu entries and the hand-off through `storage.session` with expiry and `HandoffExpired`, the check-finished notification and its click, update deferral, fonts applied from settings, pane sizes remembered, and the narrow layout.
- README: what it does, install from source (`npm ci`, `npm run build`, `npm run start`, or `about:debugging`), first steps per provider including `OLLAMA_ORIGINS`, keyboard shortcuts, privacy, development commands, and the manual smoke checklist of SPEC §11.
- `npm run package` produces the zip.
- Screenshots: `handoff-check.png` (tutor tab opened from a web page selection, checking), `handoff-alternatives.png`, `handoff-expired.png`, `fonts.png` (custom fonts and sizes), `narrow.png` (800 px wide), `narrow-dark.png`.

### Step 13: Page mode: text boxes, frame and badge (`feat/page-mode`)
- Spec: §4.11 (turning it on, which text boxes, checking, badge, how it is built), §3.2, §4.7 (General section), §9 (settings), §10 (`PageFrameBlocked`, `PageModePermissionDenied`).
- Manifest: `scripting`, the `<all_urls>` optional host permission, `web_accessible_resources` for `page-ui.*`. The build gets two more entry points: `content` (`page.js`) and `page-ui`.
- Options: the page-mode box with its privacy note and permission request, the list of hosts it is off on. Background: registration and unregistration of the content script, keeping it in step with the setting and the permission at startup and on `permissions.onRemoved`, the toolbar menu's Turn off / Turn on on <host>, and `page-mode-off`.
- Content script: the text box rules, focus tracking, the per-box text state and edit detection, the shadow-root host, the hidden `page-ui.html` frame with the `runtime.connect` port, the 5-second `PageFrameBlocked` fallback, automatic checks (on focus and after the typing pause) run by the frame, and the badge with all its states, following the box.
- The screenshot harness serves test pages from the fake LLM server (`/pages/textarea.html`, `/pages/input.html`, `/pages/contenteditable.html`, `/pages/excluded.html` with password, email and `spellcheck="false"` fields, `/pages/strict-csp.html` with `frame-src 'none'`, which Firefox 159 does not apply to the extension's frame, so page mode works there, and `/pages/blocked-frame.html` with `Content-Security-Policy: sandbox`, which does keep the frame from answering). It turns page mode on through the options page (the optional-permission pref grants `<all_urls>`), then opens the test pages in normal tabs.
- Screenshots: `options-page-mode.png`, `badge-checking.png`, `badge-count.png`, `badge-none.png`, `badge-no-llm.png`, `badge-blocked.png` (`blocked-frame.html`, with the card of Open in English Tutor), `excluded-fields.png` (no badge on excluded fields), `toolbar-menu-site.png` (if the harness can capture the menu; otherwise the options page's host list after turning a site off).

### Step 14: Page mode: ask on each site (`feat/page-mode-sites`)
- Spec: §4.11 (turning it on: access asked once, sites, the prompt, changing a choice later), §4.7 (General section, Welcome block), §7 (background), §9 (`page_mode_sites`), §13.
- Replaces Step 13's single switch and its list of hosts it is off on: `page_mode` now means "offered", and each site is `on`, `off` or `ask`. `page_mode_off_hosts` is dropped (no release has shipped it) in favour of `page_mode_sites`; "Not now" is a `storage.session` entry.
- Background: opens `options.html#welcome` on install only; answers `page-mode-config` with the site's state (and the LLM server for the prompt's note); stores `page-mode-site` choices and tells the open pages; the toolbar menu's Turn on / Turn off on <host> follows the three states.
- Options: the Welcome block (Add an LLM, Allow, Not now) through the same page-mode section code, the box renamed, the note, and the list of sites with their state and Remove.
- Content script: on an `ask` site it reads nothing and makes no frame; the first focus on an eligible text box opens the prompt card (closed shadow root, no focus taken, trusted events only, clicks in the first 500 ms ignored); Turn on starts checking the focused box at once.
- The harness copes with the welcome tab that installing the add-on now opens (it is also a scenario). Step 13's scenarios turn sites on through the prompt or the toolbar menu, and their PNGs are regenerated only where what they show changed.
- Screenshots: `welcome.png` (the options page opened on install), `welcome-dark.png`, `site-prompt.png` (the card under a focused text box, remote server note), `site-prompt-local.png` (a server on this computer), `site-prompt-no-llm.png`, `site-turned-on.png` (the badge after Turn on), `options-sites.png` (a site on and a site off, with Remove), `toolbar-menu-site.png` regenerated for the three states if needed. A scenario without a PNG checks that an `off` site and a `later` site get no prompt and send nothing, and that an excluded field never opens the prompt.

### Step 15: Page mode: underlines and the explanation popover (`feat/page-underlines`)
- Spec: §4.11 (underlines, explanation popover), §4.3 (styles), §4.5 (panel states), §5.5 (edits).
- The mirror overlay for `<textarea>` and `<input>` (styles, size and scroll kept in step), the `Range` rectangles for `contenteditable` (text model with mapping back to text nodes), redraw per animation frame, edits that move or remove underlines at once, and the selected-issue background.
- The popover in `page-ui.html`, opened by a click inside an issue, placed below or above the underline, with the shared explanation panel, Not an error, Regenerate / Retry and All issues, switching on caret moves, and closing on `Escape`, an outside click or typing.
- Screenshots: `underlines-textarea.png`, `underlines-textarea-dark.png` (a dark test page), `underlines-input.png`, `underlines-contenteditable.png`, `underlines-scrolled.png` (a long textarea scrolled halfway), `underlines-after-edit.png`, `popover-loading.png`, `popover-ready.png`, `popover-above.png` (issue near the bottom of the viewport).

### Step 16: Page mode: issues dialog (`feat/page-dialog`)
- Spec: §4.11 (issues dialog), §4.4, §4.5, §5.7 (recording from the dialog's Check), §4.1 (hand-off).
- The dialog in `page-ui.html` with the shared issues list and explanation panel, placement inside the viewport next to the box, row selection highlighting the issue in the box, Check / Cancel (recorded under the box's source), Not an error, Open in English Tutor (hand-off), Close, and the no-LLM state.
- README: a page-mode section (allowing it, the prompt on each site, what is sent and what is skipped, changing a site's choice).
- Screenshots: `dialog-issues.png`, `dialog-explanation.png`, `dialog-dark.png`, `dialog-checking.png`, `dialog-no-llm.png`, `dialog-open-in-tutor.png` (the tutor tab opened from the dialog with the box's text).

### Step 17: Release: signing and the install guide (`feat/release`)
- Spec: §3.2 (`update_url`), §12.1 (releases), §13 (distribution).
- The extension is never listed on addons.mozilla.org (AMO). Each release is signed by AMO as **unlisted**, so it installs and stays installed in release Firefox. Version 0.1.0 was signed by hand; this step bumps `version` to **0.2.0** (manifest, `package.json`, the lock file's own version), the first release made with the scripts.
- The code repository stays **private**, so Firefox cannot read it. Releases go to the separate public repository `rm4n0s/english-tutor-releases`, which holds only the signed `.xpi` files (GitHub Release assets, tags `vX.Y.Z`), `updates.json` and a `README.md` (the install guide). The code is never pushed there. The manager creates the repository with the user at release time; the implementing agent creates no repository, pushes nothing and creates no release.
- Updates: `browser_specific_settings.gecko.update_url` is `https://raw.githubusercontent.com/rm4n0s/english-tutor-releases/main/updates.json`, a committed file (SPEC §3.2 says why not the `releases/latest/download` redirect). Each entry's `update_link` is its release's `.xpi` asset and carries `update_hash` (`sha256:` of the signed file). Every earlier version stays in the file.
- `npm run sign` (`scripts/sign.mjs`, logic in `scripts/lib/`): refuses unless the git tree is clean and the versions match; builds; makes the source zip with `git archive` of HEAD; runs `web-ext sign -s dist --channel=unlisted --upload-source-code <zip> --artifacts-dir web-ext-artifacts`; prints the signed `.xpi`'s path. The AMO key comes from `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, or from a gitignored `.env` read at run time by a small parser, and is passed only through the child's environment (never printed, logged, written or on a command line). Without it the script stops and names the AMO API-key page.
- `npm run release-files` (`scripts/release-files.mjs`): from the signed `.xpi`, writes `release-out/<version>/` (gitignored): `english-tutor-<version>.xpi`, the merged `updates.json` (`--previous <path>`, or the raw URL, or `--offline`) and `README.md` (a copy of `docs/INSTALL.md`). It prints the `gh release create ... --repo rm4n0s/english-tutor-releases` command and the commands that commit `updates.json` and the README to the releases repo, and runs none.
- `docs/INSTALL.md` (users, who cannot see the private code): install from the latest release, updates, first steps per provider (with `OLLAMA_ORIGINS`), page mode, privacy, uninstall, the minimum Firefox version. `docs/RELEASING.md` (maintainer): the AMO account, agreement and key, the checklist, what to do when signing is refused or times out, and that the releases repo must stay public.
- README "Install" points to the releases repo and `docs/INSTALL.md`, and keeps a from-source section for developers.
- Tests: vitest, table-driven, for the `.env` parser, the `updates.json` merge and shape, the version checks, the `web-ext` arguments, and both scripts' flows with a fake `git`, `npm` and `web-ext`. Nothing contacts AMO or GitHub. The agent never reads `.env` and never runs `npm run sign`; the maintainer runs the first real one.
- Screenshots: none, nothing the user sees changed.

### Step 18: Page mode: icon first, and real-world editors (`feat/page-icon`)
- Spec: §4.11 (the dimmed badge and the prompt, which text boxes, which focus counts, frames, the debug log, the badge, how it is built), §3.2 and §7 (`scripting` also runs the script in open tabs), §9.1, §11, §13, §10 only if a step needs a tag.
- **Icon first, like LanguageTool.** On a site in the `ask` state (and `later`), the first focus of an eligible text box no longer opens the prompt card by itself. Every eligible focused box gets the 22 px badge at its bottom right corner, **dimmed**, with the tooltip and accessible name "English Tutor is off on <host>. Click to turn it on."; nothing is read, no frame is made, nothing is sent. A click on the dimmed badge opens the card (Turn on, Never on this site, the server note), anchored to the box. A site that is `off` has no badge and no element at all; a site that is `on` is unchanged. The dimmed badge goes when the box loses the focus (the card with it). The 500 ms click guard and the trusted-events-only rule apply to the badge and the card; excluded fields never get a badge. Not now is dropped from the card (the card is opened on demand now, and its close button and `Escape` dismiss it); the `later` state stays in the background script and behaves like `ask`.
- **Real-world editors.** Harness test pages and tests for each: a Quill-style editor (`.ql-editor`, `role="textbox"`, `<p>` children) inserted into a modal after load and focused by script; a LinkedIn-style message box (`contenteditable` div with `role="textbox"`, `<p><br></p>` when empty) in a form an SPA adds later; editors with `spellcheck="false"` (a precise rule instead of skipping everything inside `[spellcheck=false]`, and the markers of CodeMirror, Monaco, Ace and terminals); a box already focused when the content script starts; focus inside open shadow roots; a box focused while its modal is still fading in; same-origin `about:blank` / `srcdoc` iframes (found out in real Firefox 159 whether `allFrames` reaches them and whether `matchOriginAsFallback` is accepted by `scripting`, and used if it is); cross-origin iframes; pages that were already open when page mode was allowed.
- **Following boxes that move without an event.** Found by the Quill page: a modal that grows with a CSS `transform` leaves the badge and the underlines where the box was when it was focused, because a transform fires no resize, scroll or mutation. A `LayoutWatcher` looks at the boxes every 250 ms, and `transitionend` / `animationend` reposition at once.
- **Logging.** At the debug level, in the page's console, one short reason why a focused text-box-like element was skipped (never the text), and the state page mode found for the host.
- Screenshots in `docs/screenshots/step-18-page-icon/`: `badge-dimmed.png`, `badge-dimmed-card.png`, `quill-editor.png`, `spa-message-box.png`, `shadow-editor.png`, `iframe-editor.png`; earlier PNGs that change (for example `site-prompt.png`, now opened from the badge) are regenerated with `--update <name>` only where what they show changed. Scenarios without a PNG: `off` sites show no badge, `ask` sites send nothing, the dimmed badge goes on blur, a box that is already focused at start.
