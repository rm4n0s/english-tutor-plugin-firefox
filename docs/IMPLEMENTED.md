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
