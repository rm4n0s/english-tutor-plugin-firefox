// Screenshot harness (docs/IMPLEMENTATION.md, "Screenshot harness").
//
//   npm run screenshots                       all scenarios
//   npm run screenshots -- <name>             one scenario
//   npm run screenshots -- --update <name>    also overwrite the committed PNG of <name> (repeatable)
//   npm run screenshots -- --update-all       overwrite every committed PNG
//
// Write policy: a PNG goes to docs/screenshots/ only if it does not exist yet, or its scenario is
// named by --update (or --update-all). Every other PNG goes to screenshots-out/ (gitignored, same
// layout), so that a plain run never changes a committed screenshot.
//
// It builds dist/, zips it with web-ext, starts a fake LLM server on 127.0.0.1, starts headless
// Firefox through selenium-webdriver (Selenium Manager fetches geckodriver), installs the zip as a
// temporary add-on, and runs each scenario. A scenario drives the real pages and saves a 1280x800
// PNG under docs/screenshots/. The run exits with 1, after printing the reason, if one fails.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { Browser, Builder, By, Key, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { FakeLLMServer, OK_REPLY, PAGE_MODE_TEXT } from "./fake-llm.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

const GECKO_ID = "english-tutor@rm4n0s.dev";
// A fixed internal UUID, so that the pages have known moz-extension:// addresses.
const EXTENSION_UUID = "7b1f3c2e-5d0a-4c8e-9b61-2f4e8a1d6c35";
const ZIP_NAME = "english-tutor-screenshots.zip";
const WIDTH = 1280;
const HEIGHT = 800;
const PAGE_TIMEOUT_MS = 15_000;
// The fake LLM server has a fixed port, because its address is visible in the screenshots.
const FAKE_LLM_PORT = Number(process.env.FAKE_LLM_PORT ?? 47811);

// `layout.css.prefers-color-scheme.content-override`: 0 = dark, 1 = light, 2 = follow the system.
// Verified in Firefox 159 by the "dark" scenarios, which fail unless the page matches the dark scheme.
const COLOR_SCHEME_PREF = { light: 1, dark: 0 };

/**
 * Scenarios. `theme` picks the browser session (the preference is per profile), `dir` is the folder
 * under docs/screenshots/, and `run(ctx)` brings the page to its state and calls `ctx.screenshot()`.
 * The context has: `driver`, `llm` (the FakeLLMServer, to choose replies), `open(page)`, `screenshot()`
 * and `expectTheme()`, and the helpers that drive the options page: `configureFakeLLM(fields)` (opens
 * the options page and adds an LLM that points at the fake server, through the form, as a user would;
 * every scenario that needs an LLM starts with it), `addLLM(fields)` (the same on an options page that
 * is already open), `fill(id, text)`, `click(id)`, `choose(selectId, value)` and `waitForText(id, text)`.
 * Each scenario starts with an empty database (see `resetData`).
 */
const SCENARIOS = {
  "tutor-empty": {
    theme: "light",
    dir: "step-02-skeleton",
    async run(ctx) {
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.waitForText("llm-select", "No LLM configured");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "tutor-empty-dark": {
    theme: "dark",
    dir: "step-02-skeleton",
    async run(ctx) {
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.waitForText("llm-select", "No LLM configured");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "options-empty": {
    theme: "light",
    dir: "step-02-skeleton",
    async run(ctx) {
      await ctx.open("options.html");
      await ctx.driver.wait(until.elementLocated(By.id("llms")), PAGE_TIMEOUT_MS);
      await ctx.driver.wait(until.elementLocated(By.id("llm-empty")), PAGE_TIMEOUT_MS);
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "options-llm-list": {
    theme: "light",
    dir: "step-04-llm",
    async run(ctx) {
      await ctx.configureFakeLLM({ name: "Fake OpenAI server", apiKey: "sk-fake-key" });
      await ctx.addLLM({
        name: "Local Ollama",
        provider: "ollama",
        model: "llama3.1",
        baseUrl: "http://localhost:11434",
      });
      await ctx.addLLM({
        name: "Claude Sonnet",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        baseUrl: "",
        apiKey: "sk-ant-fake-key",
      });
      await ctx.click("llm-list", "li.llm-row");
      await ctx.expectTheme();
      await ctx.expectText("llm-list", "key stored");
      await ctx.expectNoText("llm-list", "sk-");
      await ctx.screenshot();
    },
  },
  "options-llm-form": {
    theme: "light",
    dir: "step-04-llm",
    async run(ctx) {
      await openNewLLMForm(ctx);
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "options-llm-form-invalid": {
    theme: "light",
    dir: "step-04-llm",
    async run(ctx) {
      await ctx.configureFakeLLM({ name: "Fake OpenAI server" });
      await ctx.click("llm-add");
      await ctx.fill("llm-name", "Fake OpenAI server");
      await ctx.fill("llm-temperature", "3");
      await ctx.click("llm-save");
      await ctx.waitForText("llm-form", "Model is required.");
      await ctx.waitForText("llm-form", "Base URL is required for this provider.");
      await ctx.waitForText("llm-form", "Temperature must be a number between 0 and 2.");
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "options-test-ok": {
    theme: "light",
    dir: "step-04-llm",
    async run(ctx) {
      ctx.llm.setReplies({ ...OK_REPLY, delayMs: 300 });
      await ctx.configureFakeLLM({ name: "Fake OpenAI server", apiKey: "sk-fake-key" });
      await ctx.click("llm-list", "li.llm-row");
      await ctx.click("llm-test-selected");
      await ctx.waitForText("llm-status", "connection works");
      await ctx.roundDuration("llm-status");
      const sent = ctx.llm.requests.at(-1)?.body.messages?.at(-1)?.content;
      if (sent !== "Reply with the single word: ok") {
        throw new Error(`the fake server got ${JSON.stringify(sent)} instead of the test prompt`);
      }
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "options-test-failed": {
    theme: "light",
    dir: "step-04-llm",
    async run(ctx) {
      await ctx.configureFakeLLM({ name: "Fake OpenAI server", apiKey: "sk-wrong-key" });
      ctx.llm.setReplies({ status: 401, content: "Incorrect API key provided" });
      await ctx.click("llm-list", "li.llm-row");
      await ctx.click("llm-edit");
      await ctx.click("llm-test");
      await ctx.waitForText("llm-form-result", "Test failed");
      await ctx.waitForText("llm-form-result", "HTTP 401");
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "options-delete-confirm": {
    theme: "light",
    dir: "step-04-llm",
    async run(ctx) {
      await ctx.configureFakeLLM({ name: "Fake OpenAI server" });
      await ctx.click("llm-list", "li.llm-row");
      await ctx.click("llm-delete");
      await ctx.waitForText("llm-confirm", 'Delete "Fake OpenAI server"?');
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "options-general": {
    theme: "light",
    dir: "step-04-llm",
    async run(ctx) {
      await ctx.configureFakeLLM({ name: "Fake OpenAI server" });
      await ctx.click("auto-check");
      await ctx.fill("auto-check-delay", "5", Key.TAB);
      await ctx.fill("font-editor-family", "Georgia", Key.TAB);
      await ctx.fill("font-editor-size", "15", Key.TAB);
      await ctx.fill("font-button-size", "12", Key.TAB);
      await ctx.fill("font-results-family", "Fira Sans", Key.TAB);
      // The values are saved at once: a reload shows them again.
      await ctx.open("options.html");
      await ctx.driver.wait(until.elementLocated(By.id("font-results-family")), PAGE_TIMEOUT_MS);
      await ctx.expectValue("auto-check-delay", "5");
      await ctx.expectValue("font-editor-family", "Georgia");
      await ctx.expectValue("font-editor-size", "15");
      await ctx.expectValue("font-results-family", "Fira Sans");
      await ctx.scrollTo("general");
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "options-llm-form-dark": {
    theme: "dark",
    dir: "step-04-llm",
    async run(ctx) {
      await openNewLLMForm(ctx);
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "no-llm": {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.fill("editor", SAMPLE_TEXT);
      await ctx.waitForText("explanation", "No LLM is configured");
      await ctx.expectDisabled("llm-select");
      await ctx.expectDisabled("check");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "before-check": {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      await openTutorWithText(ctx);
      await ctx.expectText("issues", "Press Check to find errors");
      await ctx.expectText("status-state", "Ready");
      await ctx.expectEnabled("check");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  checking: {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      // The fake server holds the reply, so the page stays in the checking state.
      ctx.llm.setReplies({ ...CHECK_REPLY, delayMs: 30_000 });
      await openTutorWithText(ctx);
      await ctx.click("check");
      await ctx.waitForVisible("loading");
      await ctx.waitForText("status-state", "Checking...");
      await ctx.waitForText("check", "Cancel");
      await ctx.expectReadOnly("editor");
      await ctx.expectNoText("loading", "We will notify you");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  underlines: {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      await checkedSample(ctx);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "underlines-dark": {
    theme: "dark",
    dir: "step-06-check",
    async run(ctx) {
      await checkedSample(ctx);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "underlines-selected": {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      await checkedSample(ctx);
      // The third row is the vocabulary issue "make a photo".
      await ctx.click("issues", ".issue-row:nth-child(3)");
      await ctx.waitForCount("#mirror .issue-selected", 1);
      await ctx.waitForExplanation("Collocation");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "underlines-scrolled": {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      // A text that needs a scroll bar, checked, then scrolled by the mouse wheel to its end:
      // the underlines must stay under their words, with the scroll bar taking room from the text.
      const filler = Array.from(
        { length: 24 },
        (_, i) => `Paragraph ${i + 1} is only here to make the text long. It has no mistakes.`,
      ).join("\n\n");
      ctx.llm.setReplies(CHECK_REPLY);
      await openTutorWithText(ctx, `${filler}\n\n${SAMPLE_TEXT}`);
      await ctx.click("check");
      await ctx.waitForText("status-state", "5 issues");
      await ctx.waitForCount("#mirror span.issue", 5);
      await ctx.wheelScroll("editor", 5000);
      await ctx.waitForScrolledToEnd("editor");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "legend-hidden": {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      await checkedSample(ctx);
      await ctx.click("legend-vocabulary");
      await ctx.waitForText("issues-header", "Issues (3 of 5 shown)");
      await ctx.waitForCount("#mirror span.issue", 3);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "no-errors": {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      ctx.llm.setReplies({ ...CHECK_REPLY, content: JSON.stringify({ issues: [] }) });
      await openTutorWithText(ctx);
      await ctx.click("check");
      await ctx.waitForText("status-state", "No errors found");
      await ctx.waitForText("issues", "No errors found");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "check-failed": {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      ctx.llm.setReplies({ status: 401, content: "Incorrect API key provided" });
      await openTutorWithText(ctx);
      await ctx.click("check");
      await ctx.waitForText("banner", "HTTP 401");
      await ctx.waitForText("status-state", "Check failed");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "check-cancelled": {
    theme: "light",
    dir: "step-06-check",
    async run(ctx) {
      // A first check finds the issues; a second one is cancelled and leaves them as they were.
      await checkedSample(ctx);
      ctx.llm.setReplies({ ...CHECK_REPLY, delayMs: 30_000 });
      await ctx.click("check");
      await ctx.waitForVisible("loading");
      await ctx.waitForText("check", "Cancel");
      await ctx.click("check");
      await ctx.waitForText("status-state", "Check cancelled");
      await ctx.expectHidden("banner");
      await ctx.expectHidden("loading");
      await ctx.waitForCount("#mirror span.issue", 5);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "selected-from-text": {
    theme: "light",
    dir: "step-07-selection",
    async run(ctx) {
      await checkedSample(ctx);
      // The caret goes into "He go" with the keyboard: its row is selected, the issue highlighted,
      // and the caret stays where it is.
      const offset = SAMPLE_TEXT.indexOf("He go") + 2;
      await ctx.keys("editor", TO_START, Key.ARROW_RIGHT.repeat(offset));
      await ctx.waitForCount('#issues .issue-row[aria-selected="true"]', 1);
      await ctx.expectText("issues", "He go");
      await ctx.expectSelectedRow(2, "He go");
      await ctx.waitForCount("#mirror .issue-selected", 1);
      await ctx.waitForExplanation("Subject-verb agreement");
      await ctx.expectCaret("editor", offset);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "selected-from-list": {
    theme: "light",
    dir: "step-07-selection",
    async run(ctx) {
      // A long text, so that the issues are below the fold: choosing a row by keyboard scrolls the
      // editor to its issue. The list keeps the focus (its outline shows), and the editor shows the
      // highlight.
      const filler = Array.from(
        { length: 24 },
        (_, i) => `Paragraph ${i + 1} is only here to make the text long. It has no mistakes.`,
      ).join("\n\n");
      ctx.llm.setReplies(SAMPLE_REPLIES);
      await openTutorWithText(ctx, `${filler}\n\n${SAMPLE_TEXT}`);
      await ctx.click("check");
      await ctx.waitForText("status-state", "5 issues");
      await ctx.waitForCount("#mirror span.issue", 5);
      // Typing the text left the editor scrolled to its end: scroll it back to the top.
      await ctx.wheelScroll("editor", -5000);
      await ctx.waitForScrollTop("editor", 0);
      await ctx.keys("issues", Key.ARROW_DOWN, Key.ARROW_DOWN, Key.ARROW_DOWN);
      await ctx.expectSelectedRow(3, "make a photo");
      await ctx.waitForCount("#mirror .issue-selected", 1);
      await ctx.waitForExplanation("Collocation");
      await ctx.expectScrolled("editor");
      await ctx.expectFocus("issues");
      await ctx.expectCaret("editor", `${filler}\n\n${SAMPLE_TEXT}`.indexOf("make a photo"));
      await ctx.expectTheme();
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
    },
  },
  tooltip: {
    theme: "light",
    dir: "step-07-selection",
    async run(ctx) {
      await checkedSample(ctx);
      await ctx.hoverIssue("make a photo");
      await ctx.waitForVisible("issue-tooltip");
      await ctx.expectText("issue-tooltip", "Collocation · Vocabulary");
      await ctx.expectText("issue-tooltip", "Say take a photo.");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "after-edit": {
    theme: "light",
    dir: "step-07-selection",
    async run(ctx) {
      await checkedSample(ctx);
      // Fix "He go" by typing right after it ("He goes"): that issue goes at once. Then type at the
      // very start, before every other issue: all of them move, and stay under their words.
      const goEnd = SAMPLE_TEXT.indexOf("He go") + "He go".length;
      await ctx.keys("editor", TO_START, Key.ARROW_RIGHT.repeat(goEnd), "es", TO_START, "Hello! ");
      await ctx.waitForCount("#mirror span.issue", 4);
      await ctx.expectUnderlined(["I seen", "make a photo", "I very like", "boring"]);
      await ctx.expectText("issues-header", "Issues (4)");
      await ctx.expectNoText("issues", "He go");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "auto-check": {
    theme: "light",
    dir: "step-07-selection",
    async run(ctx) {
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.waitForText("llm-select", "Fake LLM");
      // Auto-check on, then typing and a pause: no Check button, no loading layer.
      await ctx.click("auto-check");
      await ctx.expectChecked("auto-check");
      await ctx.fill("editor", SAMPLE_TEXT);
      await ctx.waitForText("status-state", "5 issues");
      await ctx.waitForCount("#mirror span.issue", 5);
      await ctx.waitForText("status-tokens", "last: 812 in / 164 out");
      await ctx.expectHidden("loading");
      await ctx.expectNoCountBadges();
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "explain-loading": {
    theme: "light",
    dir: "step-08-explain",
    async run(ctx) {
      // The fake server holds the explanation, so the panel stays in its loading state.
      await explainSelected(ctx, { ...EXPLAIN_REPLY, delayMs: 30_000 });
      await ctx.waitForVisible("explain-progress");
      await ctx.expectText("explain-header", "Subject-verb agreement");
      await ctx.expectText("explain-snippet", "He go");
      await ctx.expectText("explain-category", "Grammar");
      await ctx.expectText("explain-progress", "Cancel");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "explain-streaming": {
    theme: "light",
    dir: "step-08-explain",
    async run(ctx) {
      // A slow stream that stops after a fixed word and holds the connection, so that the shot
      // always shows the same half-written explanation.
      const words = EXPLAIN_REPLY.content.match(/\S+\s*/g);
      const stop = words.findIndex((word) => word.startsWith("past.")) + 1;
      await explainSelected(ctx, { ...EXPLAIN_REPLY, wordDelayMs: 20, stallAfterWords: stop });
      await ctx.waitForText("explain-body", "past.");
      await ctx.expectDataState("explain-panel", "loading");
      await ctx.expectMarkdownRendered({ complete: false });
      await ctx.expectFollowingEnd("explain-body");
      await ctx.expectText("explain-progress", "Cancel");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "explain-ready": {
    theme: "light",
    dir: "step-08-explain",
    async run(ctx) {
      await explainSelected(ctx, EXPLAIN_REPLY);
      await ctx.waitForVisible("explain-regenerate");
      await ctx.expectDataState("explain-panel", "ready");
      await ctx.expectMarkdownRendered();
      await ctx.expectHidden("explain-progress");
      await ctx.waitForVisible("explain-not-error");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "explain-ready-dark": {
    theme: "dark",
    dir: "step-08-explain",
    async run(ctx) {
      await explainSelected(ctx, EXPLAIN_REPLY);
      await ctx.waitForVisible("explain-regenerate");
      await ctx.expectDataState("explain-panel", "ready");
      await ctx.expectMarkdownRendered();
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "explain-failed": {
    theme: "light",
    dir: "step-08-explain",
    async run(ctx) {
      await explainSelected(ctx, { status: 500, content: "The model crashed while thinking." });
      await ctx.waitForVisible("explain-retry");
      await ctx.expectDataState("explain-panel", "failed");
      await ctx.expectText("explain-body", "HTTP 500");
      await ctx.expectHidden("explain-regenerate");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "explain-cancelled": {
    theme: "light",
    dir: "step-08-explain",
    async run(ctx) {
      await explainSelected(ctx, { ...EXPLAIN_REPLY, delayMs: 30_000 });
      await ctx.waitForVisible("explain-progress");
      await ctx.click("explain-cancel");
      await ctx.waitForVisible("explain-regenerate");
      await ctx.expectDataState("explain-panel", "cancelled");
      await ctx.expectText("explain-body", "Explanation cancelled.");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "link-confirm": {
    theme: "light",
    dir: "step-08-explain",
    async run(ctx) {
      await explainSelected(ctx, EXPLAIN_REPLY);
      await ctx.waitForVisible("explain-regenerate");
      await ctx.expectMarkdownRendered();
      const tutorTab = await ctx.driver.getWindowHandle();
      const tabs = (await ctx.driver.getAllWindowHandles()).length;
      await ctx.click("explain-body", "a");
      await ctx.waitForVisible("link-confirm");
      await ctx.expectText("link-confirm-url", EXPLAIN_LINK);
      // Nothing was opened, and the tutor page did not navigate.
      await ctx.expectTabs(tabs);
      await ctx.expectTutorPage();
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
      // Confirming opens the address in one more tab; the tutor tab stays where it is.
      await ctx.click("link-confirm-open");
      await ctx.expectTabs(tabs + 1);
      await ctx.driver.switchTo().window(tutorTab);
      await ctx.expectTutorPage();
    },
  },
  badges: {
    theme: "light",
    dir: "step-09-stats",
    async run(ctx) {
      // Two manual checks of different texts. The second text repeats two error types of the
      // first, so its rows show how often each type has been made so far (SPEC section 4.4).
      await checkTwoTexts(ctx);
      await ctx.waitForBadges(["x3", "x2", "x2", "x3", "x1"]);
      await ctx.expectBadgeTitle(1, "You have made this mistake 3 times");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "header-counts": {
    theme: "light",
    dir: "step-09-stats",
    async run(ctx) {
      await checkTwoTexts(ctx);
      await ctx.waitForBadges(["x3", "x2", "x2", "x3", "x1"]);
      await ctx.click("issues", ".issue-row:nth-child(1)");
      await ctx.expectSelectedRow(1, "She dont");
      await ctx.waitForExplanation("Subject-verb agreement");
      await ctx.waitForText(
        "explain-header",
        "Subject-verb agreement: you have made this mistake 3 times (3 in the last 7 days)",
      );
      await ctx.waitForVisible("explain-not-error");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "stats-mistakes": {
    theme: "light",
    dir: "step-09-stats",
    async run(ctx) {
      await openStatsAfterThreeChecks(ctx);
      await ctx.expectStatsRows([
        ["Subject-verb agreement", "Grammar", "3"],
        ["Verb form", "Grammar", "3"],
        ["Article", "Grammar", "2"],
        ["Collocation", "Vocabulary", "1"],
        ["Missing word", "Syntax", "1"],
        ["Preposition", "Grammar", "1"],
        ["Word order", "Syntax", "1"],
        ["Wrong word", "Vocabulary", "1"],
      ]);
      await ctx.expectText(
        "stats-summary",
        "13 mistakes in all time. Most frequent: Subject-verb agreement.",
      );
      await ctx.fixDates("stats-dialog");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "stats-examples": {
    theme: "light",
    dir: "step-09-stats",
    async run(ctx) {
      await openStatsAfterThreeChecks(ctx);
      await ctx.click("stats-rows", '.stats-row[data-type="subject_verb_agreement"] td');
      await ctx.waitForText("stats-examples", "Most recent examples: Subject-verb agreement");
      await ctx.waitForCount("#stats-examples li", 3);
      await ctx.expectText("stats-examples", "My brother have");
      await ctx.expectText("stats-examples", "She dont");
      await ctx.expectText("stats-examples", "He go");
      await ctx.fixDates("stats-dialog");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "stats-filtered": {
    theme: "light",
    dir: "step-09-stats",
    async run(ctx) {
      await openStatsAfterThreeChecks(ctx);
      await ctx.choose("stats-category", "grammar");
      await ctx.choose("stats-period", "7d");
      // Sorted by error type, A to Z: a click on the header.
      await ctx.click("stats-table", 'th button[data-column="type"]');
      await ctx.expectStatsRows([
        ["Article", "Grammar", "2"],
        ["Preposition", "Grammar", "1"],
        ["Subject-verb agreement", "Grammar", "3"],
        ["Verb form", "Grammar", "3"],
      ]);
      await ctx.expectText(
        "stats-summary",
        "9 mistakes in the last 7 days (Grammar). Most frequent: Subject-verb agreement.",
      );
      await ctx.fixDates("stats-dialog");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "stats-tokens": {
    theme: "light",
    dir: "step-09-stats",
    async run(ctx) {
      await openStatsAfterThreeChecks(ctx);
      await ctx.click("stats-tab-tokens");
      await ctx.waitForVisible("usage-table");
      await ctx.waitForCount("#usage-rows .usage-row", 2);
      // The first LLM reported its tokens. The second one did not, so they are estimates (`~`).
      await ctx.expectText("usage-rows", "Fake LLM");
      await ctx.expectText("usage-rows", "1.5k in / 284 out");
      await ctx.expectText("usage-rows", "Slow LLM");
      await ctx.expectText("usage-rows", "~");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "stats-reset-confirm": {
    theme: "light",
    dir: "step-09-stats",
    async run(ctx) {
      await openStatsAfterThreeChecks(ctx);
      const [first] = await ctx.driver.getAllWindowHandles();
      await ctx.click("stats-reset");
      await ctx.waitForVisible("stats-reset-confirm");
      await ctx.expectText("stats-reset-confirm", "Delete every recorded mistake?");
      await ctx.fixDates("stats-dialog");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
      // Confirming resets the statistics, and the badges of the other tab, which is still open
      // behind this one, go too (the `stats-changed` message of SPEC section 4.2).
      await ctx.click("stats-reset-confirm-yes");
      await ctx.waitForText("stats-summary", "No mistakes recorded yet.");
      await ctx.waitForCount("#stats-rows .stats-row", 0);
      await ctx.driver.switchTo().window(first);
      await ctx.waitForBadges(["", "", ""]);
    },
  },
  "stats-dark": {
    theme: "dark",
    dir: "step-09-stats",
    async run(ctx) {
      await openStatsAfterThreeChecks(ctx);
      await ctx.click("stats-rows", '.stats-row[data-type="subject_verb_agreement"] td');
      await ctx.waitForCount("#stats-examples li", 3);
      await ctx.fixDates("stats-dialog");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "row-menu-not-an-error": {
    theme: "light",
    dir: "step-09-stats",
    async run(ctx) {
      // The native menu cannot be captured in a screenshot (Selenium captures the page, and the
      // menu is a separate popup of the browser), so the scenario drives the real menu instead:
      // it right-clicks a row, reads the entries of the open menu, and chooses one. The picture
      // shows the page after "Not an error" and "Regenerate explanation" were chosen from it.
      await checkedSample(ctx);
      await ctx.waitForBadges(["x1", "x1", "x1", "x1", "x1"]);
      // The menu holds the two entries and nothing of the browser's own.
      const entries = await ctx.openRowMenu(3);
      if (JSON.stringify(entries) !== JSON.stringify(["Not an error", "Regenerate explanation"])) {
        throw new Error(`the row menu holds ${JSON.stringify(entries)}`);
      }
      await ctx.chooseRowMenuItem("Regenerate explanation");
      // Choosing it selected the third row ("make a photo") and explained it.
      await ctx.expectSelectedRow(3, "make a photo");
      await ctx.waitForExplanation("Collocation");
      // Not an error on the second row ("He go"), which is not the selected one.
      await ctx.openRowMenu(2);
      await ctx.chooseRowMenuItem("Not an error");
      await ctx.waitForCount("#issues .issue-row", 4);
      await ctx.expectUnderlined(["I seen", "make a photo", "I very like", "boring"]);
      await ctx.expectNoText("issues", "He go");
      await ctx.expectSelectedRow(2, "make a photo");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "alternatives-loading": {
    theme: "light",
    dir: "step-10-alternatives",
    async run(ctx) {
      // The fake server holds the answer, so the panel stays in its loading state.
      await askAlternatives(ctx, { ...ALTERNATIVES_REPLY, delayMs: 30_000 });
      await ctx.expectDataState("alternatives", "loading");
      await ctx.expectText("alt-selected", "make a photo");
      await ctx.expectText("alt-state", "Looking for alternatives...");
      await ctx.waitForVisible("alt-close");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "alternatives-ready": {
    theme: "light",
    dir: "step-10-alternatives",
    async run(ctx) {
      await askAlternatives(ctx, ALTERNATIVES_REPLY);
      await ctx.expectDataState("alternatives", "ready");
      await ctx.expectText("alt-state", "4 alternatives");
      await ctx.expectAlternativeRows(ALTERNATIVES);
      await ctx.waitForVisible("alt-copy");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "alternatives-failed": {
    theme: "light",
    dir: "step-10-alternatives",
    async run(ctx) {
      await askAlternatives(ctx, { status: 500, content: "The model crashed while thinking." });
      await ctx.expectDataState("alternatives", "failed");
      await ctx.expectText("alt-state", "Could not get alternatives.");
      await ctx.expectText("alt-error", "HTTP 500");
      await ctx.waitForVisible("alt-retry");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "alternatives-replaced": {
    theme: "light",
    dir: "step-10-alternatives",
    async run(ctx) {
      await askAlternatives(ctx, ALTERNATIVES_REPLY);
      await ctx.expectDataState("alternatives", "ready");
      const before = await ctx.editorValue();
      // Copy first: the panel stays open and the clipboard holds the second row.
      await ctx.click("alternatives", ".alt-row:nth-child(2)");
      await ctx.click("alt-copy");
      await ctx.expectClipboardPasted(ALTERNATIVES[1]);
      // Double-click the first row with the mouse.
      const row = await ctx.driver.findElement(By.css("#alt-list .alt-row:nth-child(1)"));
      await ctx.driver.actions({ async: true }).doubleClick(row).perform();
      const after = before.replace("make a photo", ALTERNATIVES[0]);
      await ctx.waitForEditorValue(after);
      // The panel closed, the caret is after the new text, and the editor has the focus.
      await ctx.expectHidden("alternatives");
      const caret = after.indexOf(ALTERNATIVES[0]) + ALTERNATIVES[0].length;
      const selection = await ctx.editorSelection();
      if (selection.start !== caret || selection.end !== caret || !selection.focused) {
        throw new Error(
          `the caret is ${JSON.stringify(selection)}, expected ${caret} with the focus`,
        );
      }
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
      // One undo step: Ctrl+Z brings the old text back.
      await ctx.driver.executeScript('document.getElementById("editor").focus()');
      await ctx.keys("editor", Key.chord(Key.CONTROL, "z"));
      await ctx.waitForEditorValue(before);
    },
  },
  "selection-check": {
    theme: "light",
    dir: "step-10-alternatives",
    async run(ctx) {
      ctx.llm.setReplies(SELECTION_REPLIES);
      await checkedSample(ctx, SELECTION_REPLIES);
      await ctx.waitForBadges(["x1", "x1", "x1", "x1", "x1"]);
      const idsBefore = await ctx.rowIds();
      const requestsBefore = ctx.llm.requests.length;
      const part = SELECTION_PART;
      const point = await ctx.selectInEditor(part);
      const menu = await ctx.rightClickAt(point);
      await ctx.expectEditorMenu(menu);
      await ctx.chooseRowMenuItem("Check");
      await ctx.waitForText("status-state", "5 issues");
      await ctx.waitForText("status-tokens", "last: 96 in / 22 out");
      await ctx.expectHidden("loading");
      // Only the selection was sent.
      const sent = ctx.llm.requests
        .slice(requestsBefore)
        .filter((r) => !isExplainRequest(r) && !isAlternativesRequest(r))
        .map(userMessageOf);
      if (sent.length !== 1 || !sent[0].includes(part) || sent[0].includes("Yesterday")) {
        throw new Error(`the selection check sent ${JSON.stringify(sent)}`);
      }
      // Every issue in the selection is a new one (new ids, even "He go", which was found again),
      // and the issues outside it are the very ones as before.
      await ctx.expectUnderlined(["I seen", "He go", "he make", "I very like", "boring"]);
      const idsAfter = await ctx.rowIds();
      const same = idsAfter.map((id) => (idsBefore.includes(id) ? "same" : "new"));
      if (JSON.stringify(same) !== JSON.stringify(["same", "new", "new", "same", "same"])) {
        throw new Error(
          `the rows after the selection check are ${same.join(",")}, ids ${idsBefore} -> ${idsAfter}`,
        );
      }
      // "He go" was found again with the fingerprint of the full check, so it is not counted twice;
      // "he make" is a second subject-verb mistake, so both rows say x2.
      await ctx.waitForBadges(["x1", "x2", "x2", "x1", "x1"]);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "context-menu": {
    theme: "light",
    dir: "step-10-alternatives",
    async run(ctx) {
      // The native menu cannot be captured in a screenshot (Selenium captures the page, and the
      // menu is a separate popup of the browser), so the scenario drives the real menu instead:
      // it reads the open menu, asserts its entries, and chooses each of ours. The picture shows
      // the page after both were chosen.
      ctx.llm.setReplies(SELECTION_REPLIES);
      // No LLM yet: Alternative shows, Check is disabled.
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.waitForText("llm-select", "No LLM configured");
      await ctx.fill("editor", SAMPLE_TEXT);
      let menu = await ctx.rightClickAt(await ctx.selectInEditor(SELECTION_PART));
      await ctx.expectEditorMenu(menu, { checkDisabled: true });
      await ctx.closeMenu();

      // With an LLM.
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.waitForText("llm-select", "Fake LLM");
      await ctx.fill("editor", SAMPLE_TEXT);

      // Nothing selected, or only white space selected: no entries of ours.
      await ctx.fill("editor", "Hello      world");
      menu = await ctx.rightClickAt(await ctx.selectInEditor("      "));
      await ctx.expectEditorMenu(menu, { absent: true });
      await ctx.closeMenu();
      menu = await ctx.rightClickAt(await ctx.selectInEditor("Hello", { collapse: true }));
      await ctx.expectEditorMenu(menu, { absent: true });
      await ctx.closeMenu();
      await ctx.fill("editor", SAMPLE_TEXT);

      // A backwards selection works, and each entry does its job.
      menu = await ctx.rightClickAt(
        await ctx.selectInEditor(ALTERNATIVES_PART, { backwards: true }),
      );
      await ctx.expectEditorMenu(menu);
      ctx.llm.setReplies(SELECTION_REPLIES);
      await ctx.chooseRowMenuItem("Alternative");
      await ctx.expectDataState("alternatives", "ready");
      await ctx.expectAlternativeRows(ALTERNATIVES);
      menu = await ctx.rightClickAt(await ctx.selectInEditor(SELECTION_PART));
      await ctx.expectEditorMenu(menu);
      await ctx.chooseRowMenuItem("Check");
      await ctx.waitForText("status-state", "2 issues");
      await ctx.expectUnderlined(["He go", "he make"]);
      await ctx.expectDataState("alternatives", "ready");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "open-file": {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      // A file as Windows writes it: a BOM and CRLF line breaks. The test file is written into a
      // temporary folder and its path is sent to the page's file input.
      await openTutorEmpty(ctx);
      const path = await ctx.writeTestFile("Weekend letter.txt", LETTER_FILE);
      await ctx.chooseFile(path);
      await ctx.waitForEditorValue(LETTER);
      await ctx.expectTitle("Weekend letter – English Tutor");
      await ctx.waitForText("status-words", `${LETTER.split(/\s+/).length} words`);
      // Nothing is unsaved after an Open, and the buttons that need a text are enabled.
      await ctx.expectEnabled("save");
      await ctx.expectEnabled("save-as");
      await ctx.expectEnabled("save-to-library");
      await ctx.expectEnabled("copy");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "open-failed": {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      await openTutorEmpty(ctx);
      await ctx.fill("editor", "My own text stays.");
      // A file in Latin-1 (the e-acute is the single byte E9): not valid UTF-8.
      const path = await ctx.writeTestFile(
        "Old letter.txt",
        Buffer.from("Caf\xe9 notes", "latin1"),
      );
      await ctx.chooseFile(path);
      await ctx.waitForVisible("banner");
      await ctx.expectText("banner", "not valid UTF-8");
      // Nothing was replaced and nothing was asked: the text, the tab title and the unsaved flag.
      await ctx.waitForEditorValue("My own text stays.");
      await ctx.waitForNoDialog("unsaved-dialog");
      await ctx.expectTitle("Untitled* – English Tutor");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "save-download": {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      await openTutorEmpty(ctx);
      await ctx.chooseFile(await ctx.writeTestFile("Weekend letter.txt", LETTER_FILE));
      await ctx.waitForEditorValue(LETTER);
      await ctx.fill("editor", `${LETTER}\nP.S. See you soon.`);
      await ctx.expectTitle("Weekend letter* – English Tutor");
      // Save: a real download into the (temporary) downloads folder, without a dialog.
      await ctx.click("save");
      await ctx.expectTitle("Weekend letter – English Tutor");
      const saved = await ctx.takeDownload("Weekend letter.txt");
      const expected = Buffer.from(`${LETTER}\nP.S. See you soon.`.replace(/\n/g, "\r\n"));
      if (!saved.equals(expected)) {
        throw new Error(`the saved file is ${JSON.stringify(saved.toString())}, not the CRLF text`);
      }
      await ctx.expectNoBanner();
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "save-as-failed": {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      // Save As asks the browser for its native "save file" dialog. A screenshot cannot capture
      // that dialog, and headless Firefox has no file picker: `downloads.download({ saveAs: true })`
      // fails there with "An unexpected error occurred". So this scenario shows the real failure
      // (FileWriteFailed) in the page: the banner, with the text still unsaved. The cancelled-dialog
      // path is covered by unit tests, because the browser cannot be made to cancel a dialog here.
      await openTutorEmpty(ctx);
      await ctx.fill("editor", LETTER);
      await ctx.click("save-as");
      await ctx.waitForVisible("banner");
      await ctx.expectText("banner", "The browser could not save the file.");
      await ctx.expectTitle("Untitled* – English Tutor");
      if ((await readdir(ctx.folders.downloads)).length !== 0) {
        throw new Error("Save As wrote a file although the picker failed");
      }
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  copied: {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      await openTutorWithText(ctx, LETTER);
      await ctx.click("copy");
      await ctx.waitForText("status-state", "Copied");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
      // The whole text, with its line breaks, is on the clipboard.
      await ctx.expectClipboardPasted(LETTER);
    },
  },
  "save-to-library": {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      await checkedLetter(ctx);
      await ctx.click("save-to-library");
      await ctx.waitForDialog("title-dialog");
      // The default title is the first line.
      await ctx.expectValue("title-input", "Dear Anna,");
      await ctx.expectText("title-heading", "Save to library");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();

      // Confirming stores the document, names the tab, and moves the mistakes of the session to it,
      // so checking the saved text again counts nothing twice.
      await ctx.keys("title-input", Key.ENTER);
      await ctx.waitForNoDialog("title-dialog");
      await ctx.expectTitle("Dear Anna, – English Tutor");
      await ctx.click("check");
      await ctx.driver.wait(() => ctx.llm.requests.length >= 2, PAGE_TIMEOUT_MS);
      await ctx.waitForText("check", "Check");
      await ctx.waitForText("status-state", "3 issues");
      await ctx.waitForBadges(["x1", "x1", "x1"]);
      await ctx.click("stats");
      await ctx.waitForVisible("stats-dialog");
      await ctx.waitForCount("#stats-rows .stats-row", 3);
      await ctx.expectStatsRows([
        ["Subject-verb agreement", "Grammar", "1"],
        ["Verb form", "Grammar", "1"],
        ["Word order", "Syntax", "1"],
      ]);
    },
  },
  library: {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      await openLibraryWithThreeDocuments(ctx);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();

      // Open: the text, its title and its line ending come back; the dialog closes.
      await ctx.click("library-list", '.library-row[data-title="Weekend letter"] .library-open');
      await ctx.waitForNoDialog("library-dialog");
      await ctx.waitForEditorValue(LETTER);
      await ctx.expectTitle("Weekend letter – English Tutor");

      // Rename the open document: the tab title follows.
      await ctx.click("library");
      await ctx.waitForCount("#library-list .library-row", 3);
      await ctx.click("library-list", '.library-row[data-title="Weekend letter"] .library-rename');
      await ctx.waitForDialog("title-dialog");
      await ctx.expectText("title-heading", "Rename");
      await ctx.fill("title-input", "Letter to Anna", Key.ENTER);
      await ctx.waitForNoDialog("title-dialog");
      await ctx.expectTitle("Letter to Anna – English Tutor");
      await ctx.waitForCount('#library-list .library-row[data-title="Letter to Anna"]', 1);
    },
  },
  "library-dark": {
    theme: "dark",
    dir: "step-11-saving",
    async run(ctx) {
      await openLibraryWithThreeDocuments(ctx);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "library-delete-confirm": {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      await openLibraryWithThreeDocuments(ctx);
      await ctx.click(
        "library-list",
        '.library-row[data-title="Notes about school"] .library-delete',
      );
      await ctx.waitForVisible("library-confirm");
      await ctx.expectText("library-confirm", "Delete “Notes about school” from the library?");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();

      // Cancel keeps it; Delete removes it.
      await ctx.click("library-delete-cancel");
      await ctx.waitForCount("#library-list .library-row", 3);
      await ctx.click(
        "library-list",
        '.library-row[data-title="Notes about school"] .library-delete',
      );
      await ctx.click("library-delete-ok");
      await ctx.waitForCount("#library-list .library-row", 2);
      await ctx.expectNoText("library-list", "Notes about school");

      // Deleting the open document detaches it: the next Save to library creates a new one, and
      // proposes the same title.
      await ctx.click("library-list", '.library-row[data-title="Weekend letter"] .library-open');
      await ctx.waitForNoDialog("library-dialog");
      await ctx.expectTitle("Weekend letter – English Tutor");
      await ctx.click("library");
      await ctx.waitForCount("#library-list .library-row", 2);
      await ctx.click("library-list", '.library-row[data-title="Weekend letter"] .library-delete');
      await ctx.click("library-delete-ok");
      await ctx.waitForCount("#library-list .library-row", 1);
      await ctx.click("library-close");
      await ctx.waitForNoDialog("library-dialog");
      await ctx.click("save-to-library");
      await ctx.waitForDialog("title-dialog");
      await ctx.expectValue("title-input", "Weekend letter");
    },
  },
  "unsaved-changes": {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      await openTutorWithText(ctx, LETTER);
      await ctx.click("new");
      await ctx.waitForDialog("unsaved-dialog");
      await ctx.expectText("unsaved-message", "This text has changes that are not saved.");
      await ctx.expectText("unsaved-hint", "Save downloads the text as a file.");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();

      // Cancel keeps the text.
      await ctx.click("unsaved-cancel");
      await ctx.waitForNoDialog("unsaved-dialog");
      await ctx.waitForEditorValue(LETTER);
      // Save of a text without a name needs Save As, which cannot work in headless Firefox (see
      // save-as-failed): a failed save cancels the action, so the text stays.
      await ctx.click("clear");
      await ctx.waitForDialog("unsaved-dialog");
      await ctx.click("unsaved-save");
      await ctx.waitForVisible("banner");
      await ctx.waitForNoDialog("unsaved-dialog");
      await ctx.waitForEditorValue(LETTER);
      // Discard clears it, with a new, empty, saved text.
      await ctx.click("new");
      await ctx.waitForDialog("unsaved-dialog");
      await ctx.click("unsaved-discard");
      await ctx.waitForEditorValue("");
      await ctx.expectTitle("Untitled – English Tutor");
      await ctx.expectNoBanner();

      // Save of a named text is a real download, and then the action goes on.
      await ctx.chooseFile(await ctx.writeTestFile("Weekend letter.txt", LETTER_FILE));
      await ctx.waitForEditorValue(LETTER);
      await ctx.fill("editor", `${LETTER} Edited.`);
      await ctx.click("open");
      await ctx.chooseFile(await ctx.writeTestFile("Second.txt", "Second file."));
      await ctx.waitForDialog("unsaved-dialog");
      await ctx.expectText("unsaved-message", "“Weekend letter” has changes");
      await ctx.click("unsaved-save");
      await ctx.waitForEditorValue("Second file.");
      const saved = await ctx.takeDownload("Weekend letter.txt");
      if (!saved.equals(Buffer.from(`${LETTER} Edited.`.replace(/\n/g, "\r\n")))) {
        throw new Error("Save in the dialog did not write the edited text with CRLF line breaks");
      }
      await ctx.expectTitle("Second – English Tutor");
    },
  },
  "handoff-check": {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      // The fake server holds the reply, so the new tab stays in the checking state.
      ctx.llm.setReplies({ ...CHECK_REPLY, delayMs: 30_000 });
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      const text = await ctx.chooseFromWebPageMenu("selected", "Check with English Tutor");
      await ctx.waitForText("llm-select", "Fake LLM");
      await ctx.waitForEditorValue(text);
      await ctx.waitForVisible("loading");
      await ctx.waitForText("status-state", "Checking...");
      await ctx.waitForText("check", "Cancel");
      // The entry is gone, the address is clean, and the text is a new, unsaved-free text.
      await ctx.expectTitle("Untitled – English Tutor");
      await ctx.expectHandoffEntries(0);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "handoff-alternatives": {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      ctx.llm.setReplies(SELECTION_REPLIES);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      const text = await ctx.chooseFromWebPageMenu("phrase", "Alternatives with English Tutor");
      await ctx.waitForEditorValue(text);
      await ctx.expectDataState("alternatives", "ready");
      await ctx.expectText("alt-selected", "make a photo");
      await ctx.expectAlternativeRows(ALTERNATIVES);
      // All of the text is selected, and no check was made.
      const selection = await ctx.editorSelection();
      if (selection.start !== 0 || selection.end !== text.length) {
        throw new Error(`the selection is ${JSON.stringify(selection)}, not all of "${text}"`);
      }
      await ctx.expectText("status-state", "Ready");
      await ctx.expectHandoffEntries(0);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "handoff-expired": {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      // An address whose entry is gone, as after a browser restart.
      await ctx.open("tutor.html#handoff=0a1b2c3d-0000-4000-8000-0123456789ab");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.waitForVisible("banner");
      await ctx.expectText("banner", "no longer available");
      await ctx.waitForEditorValue("");
      await ctx.expectCleanAddress();
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "focus-latest-tutor": {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      // No screenshot: the state is the browser's own (which tab is selected). The toolbar button
      // is clicked from the browser's chrome, as a user would.
      // Three tabs: tutor A, tutor B, and the options page C, which is the one in front.
      await ctx.open("tutor.html");
      // The background script made its menus (the web page submenu and the button's entries): the
      // browser refuses a second entry with the same id.
      await ctx.expectBackgroundMenus([
        "english-tutor-web",
        "english-tutor-web-check",
        "english-tutor-web-alternatives",
        "english-tutor-action-new-tab",
        "english-tutor-action-preferences",
      ]);
      await ctx.openAlongside("tutor.html");
      await ctx.openAlongside("options.html");
      const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

      // A was in front last of the two tutor tabs: the button brings A to the front.
      await ctx.selectTab(1);
      await pause();
      await ctx.selectTab(0);
      await pause();
      await ctx.selectTab(2);
      await pause();
      await ctx.clickToolbarButton();
      await ctx.expectSelectedTab(0, 3);

      // Now B was in front last.
      await ctx.selectTab(0);
      await pause();
      await ctx.selectTab(1);
      await pause();
      await ctx.selectTab(2);
      await pause();
      await ctx.clickToolbarButton();
      await ctx.expectSelectedTab(1, 3);

      // No tutor tab open: the button opens one.
      await ctx.closeTab(1);
      await ctx.closeTab(0);
      await ctx.expectTabCount(1);
      await ctx.clickToolbarButton();
      await ctx.expectTabCount(2);
      await ctx.expectSelectedUrl("tutor.html");
    },
  },
  "notify-background-check": {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      // No screenshot: a notification is the system's, not the page's. The scenario reads the
      // notifications the extension has made from `browser.notifications.getAll()`, called in an
      // extension page of another tab (the harness's only way to see them in a headless browser).
      ctx.llm.setReplies({ ...CHECK_REPLY, delayMs: 1500 });
      await openTutorWithText(ctx);
      const tutor = await ctx.driver.getWindowHandle();
      await ctx.click("check");
      await ctx.waitForText("status-state", "Checking...");
      // Another tab comes to the front while the check runs: the tutor tab is hidden when it ends.
      await ctx.openAlongside("options.html");
      const shown = await ctx.waitForNotifications(1);
      const [[id, options]] = Object.entries(shown);
      if (!/^check-\d+$/.test(id)) throw new Error(`the notification has the id ${id}`);
      if (options.title !== "Check finished" || options.message !== "5 issues") {
        throw new Error(`the notification says ${JSON.stringify(options)}`);
      }

      // A check the user watches (the tab in front) makes none.
      await ctx.clearNotifications();
      await ctx.driver.switchTo().window(tutor);
      await ctx.chrome("gBrowser.selectedTab = gBrowser.tabs[0];");
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.fill("editor", `${SAMPLE_TEXT} `);
      await ctx.click("check");
      await ctx.waitForText("status-state", "5 issues");
      await ctx.openAlongside("options.html");
      await ctx.expectNoNotifications();
      // The tutor tab has unsaved text and is hidden: the browser would ask before closing it, and
      // would not quit. Leaving through `open` closes it as the harness does everywhere.
      await ctx.open("options.html");
    },
  },
  fonts: {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      ctx.llm.setReplies(SAMPLE_REPLIES);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      // Generic families, so that the shot does not depend on which fonts a machine has.
      await ctx.fill("font-editor-family", "serif", Key.TAB);
      await ctx.fill("font-editor-size", "16", Key.TAB);
      await ctx.fill("font-button-family", "monospace", Key.TAB);
      await ctx.fill("font-button-size", "12", Key.TAB);
      await ctx.fill("font-results-family", "serif", Key.TAB);
      await ctx.fill("font-results-size", "13", Key.TAB);
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.waitForText("llm-select", "Fake LLM");
      await ctx.fill("editor", SAMPLE_TEXT);
      await ctx.click("check");
      await ctx.waitForText("status-state", "5 issues");
      await ctx.click("issues", ".issue-row:nth-child(2)");
      await ctx.waitForExplanation("Subject-verb agreement");
      // The three fonts are really in use (the computed values, not just the settings).
      await ctx.expectFont("editor", { family: "serif", px: 16 * (96 / 72) });
      await ctx.expectFont("check", { family: "monospace", px: 12 * (96 / 72) });
      await ctx.expectFont("explanation", { family: "serif", px: 13 * (96 / 72) });
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();

      // A change on the options page reaches the open tutor tab at once.
      const tutor = await ctx.driver.getWindowHandle();
      await ctx.openAlongside("options.html");
      await ctx.driver.wait(until.elementLocated(By.id("font-editor-size")), PAGE_TIMEOUT_MS);
      await ctx.fill("font-editor-size", "20", Key.TAB);
      await ctx.driver.switchTo().window(tutor);
      await ctx.driver.wait(
        async () =>
          Math.abs(
            (await ctx.driver.executeScript(
              'return parseFloat(getComputedStyle(document.getElementById("editor")).fontSize)',
            )) -
              20 * (96 / 72),
          ) < 0.05,
        PAGE_TIMEOUT_MS,
        "the open tutor tab did not follow the font size",
      );
    },
  },
  "pane-sizes": {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      // No screenshot: the positions of the two dividers are dragged, and come back after a reload.
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      const before = await ctx.paneSizes();
      if (Math.abs(before.editor - 65) > 1 || Math.abs(before.issues - 40) > 1) {
        throw new Error(`the panes start at ${JSON.stringify(before)}, not 65 / 40`);
      }
      await ctx.dragDivider("divider-main", -160, 0);
      await ctx.dragDivider("divider-side", 0, 120);
      const moved = await ctx.paneSizes();
      if (!(moved.editor < before.editor - 8) || !(moved.issues > before.issues + 8)) {
        throw new Error(`the dividers did not move: ${JSON.stringify(moved)}`);
      }
      // Reloading gives the same sizes back, from `pane_sizes` in the store.
      await ctx.reload();
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.driver.wait(
        async () => {
          const now = await ctx.paneSizes();
          return (
            Math.abs(now.editor - moved.editor) < 0.5 && Math.abs(now.issues - moved.issues) < 0.5
          );
        },
        PAGE_TIMEOUT_MS,
        `the sizes did not come back: ${JSON.stringify(await ctx.paneSizes())}, expected ${JSON.stringify(moved)}`,
      );
    },
  },
  narrow: {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      await narrowChecked(ctx);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot({ width: NARROW_WIDTH });
    },
  },
  "narrow-dark": {
    theme: "dark",
    dir: "step-12-browser",
    async run(ctx) {
      await narrowChecked(ctx);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot({ width: NARROW_WIDTH });
    },
  },
  "explain-scrolled-top": {
    theme: "light",
    dir: "step-12-browser",
    async run(ctx) {
      await checkedSample(ctx, (request) =>
        isExplainRequest(request) ? longExplanationFor(request) : CHECK_REPLY,
      );
      // The long explanation streams in (the view follows its end while it grows).
      await ctx.click("issues", ".issue-row:nth-child(2)");
      await ctx.expectSelectedRow(2, "He go");
      await ctx.waitForExplanation("Subject-verb agreement");
      await ctx.expectOverflows("explain-body");
      // The stream ended while the view followed its end: the finished text starts at its top.
      await ctx.waitForScrollTop("explain-body", 0);
      // Another issue, and then this one again: its explanation is cached, and opens at its top.
      await ctx.click("issues", ".issue-row:nth-child(1)");
      await ctx.waitForExplanation("Verb form");
      await ctx.click("issues", ".issue-row:nth-child(2)");
      await ctx.expectSelectedRow(2, "He go");
      await ctx.waitForExplanation("Subject-verb agreement");
      await ctx.expectOverflows("explain-body");
      await ctx.waitForScrollTop("explain-body", 0);
      await ctx.expectText("explain-body", "What is wrong");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
    },
  },
  "restored-after-reload": {
    theme: "light",
    dir: "step-11-saving",
    async run(ctx) {
      await checkedLetter(ctx);
      await ctx.waitForBadges(["x1", "x1", "x1"]);
      // Reload the tab. The page asks the browser's own "leave this page?" question because the
      // text has unsaved changes (beforeunload); the harness leaves.
      await ctx.reload();
      await ctx.waitForEditorValue(LETTER);
      // The text is back, unsaved, with no underlines: issues are not kept.
      await ctx.expectTitle("Untitled* – English Tutor");
      await ctx.waitForCount("#mirror span.issue", 0);
      await ctx.waitForCount("#issues .issue-row", 0);
      await ctx.waitForText("status-state", "Ready");
      await ctx.expectEnabled("save");
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();

      // It can be checked again, and counts nothing twice: the source key was restored.
      await ctx.click("check");
      await ctx.waitForText("status-state", "3 issues");
      await ctx.waitForBadges(["x1", "x1", "x1"]);
    },
  },
  // Step 13: page mode (SPEC section 4.11). The badge lives in a closed shadow root, so these
  // scenarios read its state from the pixels of the screenshot, as a user sees it.
  "options-page-mode": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.expectChecked("page-mode");
      await ctx.expectText("page-mode-note", "is checked by");
      await ctx.expectText("page-mode-note", "on this computer");
      await ctx.expectHidden("page-mode-error");
      await ctx.scrollTo("page-mode");
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "badge-checking": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // The fake LLM holds its answer, so that the badge stays on its spinner.
      ctx.llm.setReplies({ ...CHECK_REPLY, delayMs: 120_000 });
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("textarea.html");
      await ctx.focusBox();
      await ctx.waitForLLMRequests(1);
      await ctx.waitForBadge("spinner");
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
    },
  },
  "badge-count": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("textarea.html");
      await ctx.focusBox();
      // Two grammar issues and one vocabulary issue: the count is in the colour of grammar.
      await ctx.waitForBadge("grammar");
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
      // Nothing was recorded in the statistics: only the dialog's Check does that (step 15).
      await ctx.expectNoRecordedMistakes();
    },
  },
  "badge-none": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      ctx.llm.setReplies(NO_ISSUES_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("textarea.html");
      await ctx.focusBox();
      await ctx.waitForBadge("check");
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
    },
  },
  "badge-no-llm": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // No LLM is configured: the options page is opened without adding one.
      await ctx.open("options.html");
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("textarea.html");
      await ctx.focusBox();
      await ctx.waitForBadge("warning");
      if (ctx.llmRequests() !== 0) throw new Error("a request was sent without an LLM");
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
    },
  },
  "badge-blocked": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // The page's policy is `frame-src 'none'`: the frame cannot load, so after 5 seconds the badge
      // shows `!`, and its click offers only Open in English Tutor.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("blocked-frame.html");
      await ctx.focusBox();
      await ctx.waitForBadge("warning");
      if (ctx.llmRequests() !== 0) throw new Error("the blocked frame still checked the text");
      const { x, y } = await ctx.badgeCenter();
      await ctx.clickAt(x, y);
      await ctx.waitForColor(BLOCKED_CARD_BUTTON);
      await ctx.screenshot();
      // Open in English Tutor: a new tutor tab holds the text of the box (the hand-off of
      // SPEC section 4.1), and nothing is written back to the page.
      const before = await ctx.driver.getAllWindowHandles();
      const button = await ctx.waitForColor(BLOCKED_CARD_BUTTON);
      await ctx.clickAt(button.x, button.y);
      await ctx.switchToNewTab(before);
      await waitForPage(ctx.driver, "tutor.html");
      await ctx.waitForEditorValue(PAGE_MODE_TEXT);
    },
  },
  "badge-input": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("input.html");
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
    },
  },
  "badge-contenteditable": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("contenteditable.html");
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
      // The text sent is the editor's two paragraphs joined by a line break.
      const sent = ctx.llm.requests.at(-1)?.body.messages.find((m) => m.role === "user").content;
      if (!String(sent).includes("market.\nHe go")) {
        throw new Error("the paragraphs were not joined by a line break");
      }
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
    },
  },
  "excluded-fields": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("excluded.html");
      const excluded = ["password", "email", "nospell", "card", "optout"];
      for (const id of excluded) {
        await ctx.focusBox(id);
        await ctx.typeInBox(" and some more words", id);
      }
      // Longer than the pause before an automatic check (one second): nothing was sent.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (ctx.llmRequests() !== 0) throw new Error("text of an excluded field was sent");
      for (const id of excluded) await ctx.expectNoBadge(id);
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
      // The control, a plain text box on the same page, is checked: page mode does run here.
      await ctx.focusBox("control");
      await ctx.waitForLLMRequests(1);
      await ctx.waitForBadge("grammar", "control");
    },
  },
  "toolbar-menu-site": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // The toolbar button's menu names the site of the tab in front (SPEC section 4.11). The
      // native menu cannot be photographed (a screenshot is of the page only), so the entries are
      // read from the browser, "Turn off" is chosen, and the options page's list of sites shows
      // the result.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      const options = await ctx.driver.getWindowHandle();
      await ctx.openPageModePage("textarea.html");
      const page = await ctx.driver.getWindowHandle();
      const labels = await ctx.openToolbarMenu();
      for (const wanted of ["New tutor tab", "Preferences", "Turn off on 127.0.0.1"]) {
        if (!labels.includes(wanted)) {
          throw new Error(`the toolbar menu has ${JSON.stringify(labels)}, not ${wanted}`);
        }
      }
      await ctx.chooseToolbarMenuItem("Turn off on 127.0.0.1");
      // The open page stops at once: its overlay goes, and a text box is no longer checked.
      await ctx.waitForNoPageModeHost();
      await ctx.focusBox();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (ctx.llmRequests() !== 0) throw new Error("text was checked on a site that is turned off");
      // The menu now offers the opposite.
      const later = await ctx.openToolbarMenu();
      if (!later.includes("Turn on on 127.0.0.1")) {
        throw new Error(`the toolbar menu has ${JSON.stringify(later)}, not Turn on on 127.0.0.1`);
      }
      await ctx.closeToolbarMenu();
      // The options page lists the site.
      await ctx.driver.switchTo().window(options);
      await ctx.waitForText("page-mode-hosts", "127.0.0.1");
      await ctx.scrollTo("page-mode");
      await ctx.expectTheme();
      await ctx.screenshot();
      // A new page load on that site is left alone too, and Remove turns it on again.
      await ctx.driver.switchTo().window(page);
      await ctx.driver.navigate().refresh();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await ctx.waitForNoPageModeHost();
      await ctx.driver.switchTo().window(options);
      await ctx.click("page-mode-hosts", ".host-remove");
      await ctx.waitForCount("#page-mode-hosts li", 0);
      await ctx.driver.switchTo().window(page);
      await ctx.driver.navigate().refresh();
      await ctx.waitForPageModeHost();
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
    },
  },
  "page-mode-off": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // Turning page mode off and on again, as a user does it on the options page.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      const options = await ctx.driver.getWindowHandle();
      await ctx.openPageModePage("textarea.html");
      const page = await ctx.driver.getWindowHandle();
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");

      await ctx.driver.switchTo().window(options);
      await ctx.click("page-mode");
      await ctx.waitForRegisteredScripts(0);
      if (await ctx.hasAllUrlsPermission()) throw new Error("the <all_urls> permission was kept");
      // The open page removed its badge and everything else at once.
      await ctx.driver.switchTo().window(page);
      await ctx.waitForNoPageModeHost();
      await ctx.expectNoBadge();

      // On again: the box asks for the permission, the script is registered, a new page works.
      await ctx.driver.switchTo().window(options);
      await ctx.click("page-mode");
      await ctx.waitForRegisteredScripts(1);
      if (!(await ctx.hasAllUrlsPermission()))
        throw new Error("the <all_urls> permission is missing");
      await ctx.driver.switchTo().window(page);
      await ctx.driver.navigate().refresh();
      await ctx.waitForPageModeHost();
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
    },
  },
  "strict-csp-frame": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // Found in Firefox 159: a page's `frame-src 'none'` does not stop the extension's own frame
      // that a content script adds, so page mode works on such a page (SPEC section 4.11).
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("strict-csp.html");
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
    },
  },
  "page-mode-edits": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // Typing moves and removes the issues at once (SPEC section 5.5), and a pause in typing
      // starts a new automatic check.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("textarea.html");
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
      await ctx.waitForLLMRequests(1);
      // Slow the next answer down, so that what the edits did is what the badge shows.
      ctx.llm.setReplies({ ...CHECK_REPLY, delayMs: 120_000 });
      // A letter inside "I seen" and one inside "He go" remove both grammar issues: only the
      // vocabulary issue "make a photo" is left, and the badge changes to its colour at once.
      await ctx.typeAt("I s", "e", 0);
      await ctx.typeAt("He g", "o", 0);
      await ctx.waitForBadge("vocabulary");
      await ctx.waitForBadge("spinner");
      await ctx.waitForLLMRequests(2);
    },
  },
};

/** The fake LLM's answer when the text has no mistake. */
const NO_ISSUES_REPLY = {
  content: JSON.stringify({ issues: [] }),
  usage: { prompt_tokens: 60, completion_tokens: 8 },
};

/** The colour of the Open in English Tutor button of the blocked badge's card (#0b5cad). */
const BLOCKED_CARD_BUTTON = [0x0b, 0x5c, 0xad];

/** In the browser's own code: the visible entries of the toolbar button's open context menu. */
const TOOLBAR_MENU_LABELS = `
  const popup = document.getElementById("toolbar-context-menu");
  if (popup === null || popup.state !== "open") return [];
  return [...popup.children].filter((m) => m.localName === "menuitem" && !m.hidden).map((m) => m.label);
`;

/** In the browser's own code: the visible entries of the open page context menu. */
const ROW_MENU_LABELS = `
  const popup = document.getElementById("contentAreaContextMenu");
  if (popup === null || popup.state !== "open") return [];
  return [...popup.children].filter((m) => m.localName === "menuitem" && !m.hidden).map((m) => m.label);
`;

/**
 * In the browser's own code: the visible entries of the open page context menu, in order. A
 * submenu (a `menu` element) is listed with its label and then its entries, which carry
 * `submenu`.
 */
const MENU_ENTRIES = `
  const popup = document.getElementById("contentAreaContextMenu");
  if (popup === null || popup.state !== "open") return [];
  const entries = [];
  const visit = (parent, submenu) => {
    for (const m of parent.children) {
      if (m.hidden) continue;
      if (m.localName === "menuseparator") {
        entries.push({ label: "-", disabled: true, separator: true });
      } else if (m.localName === "menuitem") {
        entries.push({ label: m.label, disabled: m.disabled, ...(submenu ? { submenu } : {}) });
      } else if (m.localName === "menu") {
        entries.push({ label: m.label, disabled: m.disabled, isMenu: true, ...(submenu ? { submenu } : {}) });
        const inner = m.menupopup ?? m.querySelector("menupopup");
        if (inner) visit(inner, m.label);
      }
    }
  };
  visit(popup, null);
  return entries;
`;

/** Keys that put the caret at the start of a short text (the sample wraps to two lines). */
const TO_START = Key.ARROW_UP.repeat(6) + Key.HOME;

/** Where the Step 10 scenarios select: a clause with two of the sample's issues in it. */
const SELECTION_PART = "He go to school every day, and he make a photo of everything.";
/** The words the Alternatives scenarios ask about. */
const ALTERNATIVES_PART = "make a photo";
const ALTERNATIVES = ["takes a photo", "snaps a picture", "shoots a photo", "captures a picture"];
const ALTERNATIVES_REPLY = {
  content: JSON.stringify({ alternatives: ALTERNATIVES }),
  usage: { prompt_tokens: 210, completion_tokens: 34 },
};

/** Whether a request asks for alternatives (the system prompt of SPEC section 5.10). */
function isAlternativesRequest(request) {
  return (request.body.messages ?? []).some(
    (m) => m.role === "system" && String(m.content).includes("writing coach"),
  );
}

function userMessageOf(request) {
  return request.body.messages.find((m) => m.role === "user")?.content ?? "";
}

/**
 * What the fake model finds in the selection of `SELECTION_PART`: "He go" again (the same words,
 * so the same fingerprint as in the full check) and "he make", which replaces "make a photo".
 */
const SELECTION_CHECK_REPLY = {
  content: JSON.stringify({
    issues: [
      {
        text: "He go",
        error_type: "subject_verb_agreement",
        message: "Use goes with he.",
        context_before: "",
        context_after: " to school",
      },
      {
        text: "he make",
        error_type: "subject_verb_agreement",
        message: "Use makes with he.",
        context_before: "every day, and ",
        context_after: " a photo",
      },
    ],
  }),
  usage: { prompt_tokens: 96, completion_tokens: 22 },
};

/** Answers the full check, the selection check, explanations and alternatives. */
const SELECTION_REPLIES = (request) => {
  if (isAlternativesRequest(request)) return ALTERNATIVES_REPLY;
  if (isExplainRequest(request)) return explanationFor(request);
  return userMessageOf(request).includes("Yesterday") ? CHECK_REPLY : SELECTION_CHECK_REPLY;
};

/**
 * Types the sample text, selects "make a photo" and chooses **Alternative** in the browser's
 * context menu. The fake server answers the request with `reply`.
 */
async function askAlternatives(ctx, reply) {
  ctx.llm.setReplies((request) =>
    isAlternativesRequest(request) ? reply : SAMPLE_REPLIES(request),
  );
  await openTutorWithText(ctx);
  const menu = await ctx.rightClickAt(await ctx.selectInEditor(ALTERNATIVES_PART));
  await ctx.expectEditorMenu(menu);
  await ctx.chooseRowMenuItem("Alternative");
  await ctx.waitForVisible("alternatives");
}

/** The text of the Step 6 scenarios, and the issues the fake LLM finds in it (all three categories). */
const SAMPLE_TEXT =
  "Yesterday I seen my friend at the market. He go to school every day, and he make a photo " +
  "of everything. I very like his camera. After lunch I felt boring, so we went home.";

const CHECK_REPLY = {
  content: JSON.stringify({
    issues: [
      {
        text: "I seen",
        error_type: "verb_form",
        message: "Use the past tense: I saw.",
        context_before: "Yesterday ",
        context_after: " my friend",
      },
      {
        text: "He go",
        error_type: "subject_verb_agreement",
        message: "Use goes with he.",
        context_before: "market. ",
        context_after: " to school",
      },
      {
        text: "make a photo",
        error_type: "collocation",
        message: "Say take a photo.",
        context_before: "and he ",
        context_after: " of everything",
      },
      {
        text: "boring",
        error_type: "wrong_word",
        message: "Say bored: boring describes the thing, not the feeling.",
        context_before: "I felt ",
        context_after: ", so we",
      },
      {
        text: "I very like",
        error_type: "word_order",
        message: "Put very before the verb: I like it very much.",
        context_before: "everything. ",
        context_after: " his camera",
      },
    ],
  }),
  usage: { prompt_tokens: 812, completion_tokens: 164 },
};

/** A second text for the statistics scenarios. It repeats two error types of the sample text. */
const TEXT_B =
  "She dont like apples. I have a apple and a orange. My brother have two cats. I want go to the park.";
const REPLY_B = {
  content: JSON.stringify({
    issues: [
      {
        text: "She dont",
        error_type: "subject_verb_agreement",
        message: "Use doesn't with she.",
        context_before: "",
        context_after: " like apples",
      },
      {
        text: "a apple",
        error_type: "article",
        message: "Use an before a vowel sound.",
        context_before: "I have ",
        context_after: " and a orange",
      },
      {
        text: "a orange",
        error_type: "article",
        message: "Use an before a vowel sound.",
        context_before: "apple and ",
        context_after: ". My brother",
      },
      {
        text: "My brother have",
        error_type: "subject_verb_agreement",
        message: "Use has with he or my brother.",
        context_before: "orange. ",
        context_after: " two cats",
      },
      {
        text: "want go",
        error_type: "missing_word",
        message: "Add to: want to go.",
        context_before: "I ",
        context_after: " to the park",
      },
    ],
  }),
  usage: { prompt_tokens: 640, completion_tokens: 120 },
};

/** A third text. The fake server reports no tokens for it, so the app estimates them. */
const TEXT_C = "I am agree with you. She explained me the rule. I look forward to meet you.";
const REPLY_C = {
  content: JSON.stringify({
    issues: [
      {
        text: "am agree",
        error_type: "verb_form",
        message: "Say I agree.",
        context_before: "I ",
        context_after: " with you",
      },
      {
        text: "explained me the rule",
        error_type: "preposition",
        message: "Say explained the rule to me.",
        context_before: "She ",
        context_after: ". I look",
      },
      {
        text: "to meet",
        error_type: "verb_form",
        message: "Use meeting after look forward to.",
        context_before: "forward ",
        context_after: " you",
      },
    ],
  }),
  usage: { prompt_tokens: 0, completion_tokens: 0 },
};

/** Answers the checks of the three texts and the explanations. */
const STATS_REPLIES = (request) => {
  if (isExplainRequest(request)) return explanationFor(request);
  const user = request.body.messages.find((m) => m.role === "user")?.content ?? "";
  if (user.includes("She dont")) return REPLY_B;
  if (user.includes("I am agree")) return REPLY_C;
  return CHECK_REPLY;
};

/** Two manual checks, of the sample text and then of `TEXT_B`, by the first LLM. */
async function checkTwoTexts(ctx) {
  ctx.llm.setReplies(STATS_REPLIES);
  await openTutorWithText(ctx);
  await ctx.click("check");
  await ctx.waitForText("issues", "I seen");
  await ctx.waitForCount("#mirror span.issue", 5);
  await ctx.waitForBadges(["x1", "x1", "x1", "x1", "x1"]);
  await ctx.fill("editor", TEXT_B);
  await ctx.click("check");
  await ctx.waitForText("issues", "She dont");
  await ctx.waitForCount("#mirror span.issue", 5);
}

/**
 * Three manual checks: the sample text and `TEXT_B` by "Fake LLM", `TEXT_C` by "Slow LLM"
 * (a second LLM, which reports no tokens), then a second tab with the Statistics dialog open.
 * Everything goes through the UI; nothing is written to the database by the harness.
 */
async function openStatsAfterThreeChecks(ctx) {
  ctx.llm.setReplies(STATS_REPLIES);
  await ctx.configureFakeLLM({ name: "Fake LLM" });
  await ctx.addLLM({ name: "Slow LLM" });
  await ctx.open("tutor.html");
  await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
  await ctx.waitForText("llm-select", "Fake LLM");
  await ctx.fill("editor", SAMPLE_TEXT);
  await ctx.click("check");
  await ctx.waitForText("issues", "I seen");
  await ctx.waitForBadges(["x1", "x1", "x1", "x1", "x1"]);
  await ctx.fill("editor", TEXT_B);
  await ctx.click("check");
  await ctx.waitForText("issues", "She dont");
  await ctx.waitForBadges(["x3", "x2", "x2", "x3", "x1"]);
  // The second LLM, for the third text.
  await ctx.choose("llm-select", "2");
  await ctx.fill("editor", TEXT_C);
  await ctx.click("check");
  await ctx.waitForText("issues", "am agree");
  await ctx.waitForBadges(["x3", "x1", "x3"]);
  // A second tab, so that a reset there can be seen in the first (stats-reset-confirm).
  await ctx.openAlongside("tutor.html");
  await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
  await ctx.waitForText("llm-select", "Fake LLM");
  await ctx.click("stats");
  await ctx.waitForVisible("stats-dialog");
  await ctx.waitForCount("#stats-rows .stats-row", 8);
}

/** A letter, as the editor holds it (line breaks are LF). */
const LETTER =
  "Dear Anna,\nYesterday I seen my friend at the market. He go to school every day.\n" +
  "I very like his camera.\nBest wishes,\nPeter";

/** The same letter as a Windows editor writes it: a BOM, then CRLF line breaks. */
const LETTER_FILE = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(LETTER.replace(/\n/g, "\r\n")),
]);

/** Adds the fake LLM and opens an empty tutor page. */
async function openTutorEmpty(ctx) {
  await ctx.configureFakeLLM({ name: "Fake LLM" });
  await ctx.open("tutor.html");
  await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
  await ctx.waitForText("llm-select", "Fake LLM");
}

/** The fake LLM's answer for `LETTER`: three issues of three types. */
const LETTER_REPLY = {
  content: JSON.stringify({
    issues: [
      {
        text: "I seen",
        error_type: "verb_form",
        message: "Use the past tense: I saw.",
        context_before: "Yesterday ",
        context_after: " my friend",
      },
      {
        text: "He go",
        error_type: "subject_verb_agreement",
        message: "Use goes with he.",
        context_before: "market. ",
        context_after: " to school",
      },
      {
        text: "I very like",
        error_type: "word_order",
        message: "Put very before the verb: I like it very much.",
        context_before: "day.\n",
        context_after: " his camera",
      },
    ],
  }),
  usage: { prompt_tokens: 320, completion_tokens: 90 },
};

/** The letter, typed and checked (three issues), by the fake LLM. */
async function checkedLetter(ctx) {
  ctx.llm.setReplies(LETTER_REPLY);
  await openTutorWithText(ctx, LETTER);
  await ctx.click("check");
  await ctx.waitForText("status-state", "3 issues");
  await ctx.waitForCount("#mirror span.issue", 3);
}

/** Three texts saved to the library through the UI, and the Library dialog open on them. */
async function openLibraryWithThreeDocuments(ctx) {
  await openTutorEmpty(ctx);
  const texts = [
    ["Notes about school", "My school is big. We have many teachers and a library."],
    ["Job application", "I am writing to apply for the position of assistant."],
    ["Weekend letter", LETTER],
  ];
  for (const [title, text] of texts) {
    await ctx.fill("editor", text);
    await ctx.click("save-to-library");
    await ctx.waitForDialog("title-dialog");
    await ctx.fill("title-input", title, Key.ENTER);
    await ctx.waitForNoDialog("title-dialog");
    await ctx.expectTitle(`${title} – English Tutor`);
    // The tab now shows a library document; the next text starts a new one.
    await ctx.click("new");
    await ctx.waitForEditorValue("");
  }
  await ctx.click("library");
  await ctx.waitForDialog("library-dialog");
  await ctx.waitForCount("#library-list .library-row", 3);
  // Newest update first: the order the texts were saved in, reversed.
  const titles = await ctx.driver.executeScript(
    'return [...document.querySelectorAll("#library-list .library-title")].map((e) => e.textContent)',
  );
  if (
    JSON.stringify(titles) !==
    JSON.stringify(["Weekend letter", "Job application", "Notes about school"])
  ) {
    throw new Error(`the library lists ${JSON.stringify(titles)}`);
  }
  await ctx.fixDates("library-dialog");
}

/** Adds the fake LLM, opens the tutor page and types the sample text. */
async function openTutorWithText(ctx, text = SAMPLE_TEXT) {
  await ctx.configureFakeLLM({ name: "Fake LLM" });
  await ctx.open("tutor.html");
  await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
  // The page selects the first LLM by itself.
  await ctx.waitForText("llm-select", "Fake LLM");
  await ctx.fill("editor", text);
  await ctx.expectEnabled("check");
}

/** The address of the one link in the canned explanation. */
const EXPLAIN_LINK = "http://example.com/grammar/present-simple";

/**
 * A canned explanation in the shape the prompt asks for (SPEC section 5.4), with headings, bold,
 * italic, a list, inline code and one http link.
 */
const EXPLAIN_REPLY = {
  content: [
    "### What is wrong",
    "Add **-s** after *he*, *she* and *it*: *He go* should be *He goes*.",
    "",
    "### Why",
    "The present simple adds **-s** for one person or thing. Other subjects keep the base form: `I go`, `they go`.",
    "",
    "### Better ways",
    "- **He goes** to school every day.",
    "- **He went** to school yesterday, if you mean the past.",
    "",
    "### Remember",
    `Think "he, she, it: the verb gets a hit". See this guide to the [present simple](${EXPLAIN_LINK}).`,
  ].join("\n"),
  usage: { prompt_tokens: 240, completion_tokens: 130 },
};

/** Whether a request to the fake server asks for an explanation (the check prompt does not). */
function isExplainRequest(request) {
  return (request.body.messages ?? []).some(
    (m) => m.role === "system" && String(m.content).includes("patient English teacher"),
  );
}

/** Short canned explanations of the other issues of the sample text, by their faulty words. */
const OTHER_EXPLANATIONS = {
  "I seen": [
    "Use the simple past *saw*, or *have seen*.",
    "Seen needs *have* or *has*; alone, it is wrong.",
  ],
  "make a photo": ["Say **take a photo**.", "*Take* goes with *photo*, *picture* and *shower*."],
  "I very like": ["Put *very much* after the object.", "Say **I like his camera very much**."],
  boring: ["Say **bored** for a feeling.", "*Boring* describes the thing that causes it."],
  "She dont": ["Use **doesn't** with *he*, *she* and *it*.", "Say **She doesn't like apples**."],
};

/** The canned explanation for the faulty words of an explanation request. */
function explanationFor(request) {
  const user = request.body.messages.find((m) => m.role === "user")?.content ?? "";
  const faulty = /=====BEGIN FAULTY WORDS \S+=====\n([\s\S]*?)\n=====END/.exec(user)?.[1];
  const lines = OTHER_EXPLANATIONS[faulty];
  if (lines === undefined) return EXPLAIN_REPLY;
  return {
    content: ["### What is wrong", lines[0], "", "### Remember", lines[1]].join("\n"),
    usage: { prompt_tokens: 180, completion_tokens: 40 },
  };
}

/** The width of the narrow window scenarios, below the 800 px where the layout changes. */
const NARROW_WIDTH = 720;

/**
 * The sample text, checked and its second issue explained, in a window `NARROW_WIDTH` wide
 * (SPEC section 4.2: below 800 px the right column moves under the editor).
 */
async function narrowChecked(ctx) {
  await explainSelected(ctx, EXPLAIN_REPLY);
  await ctx.waitForExplanation("Subject-verb agreement");
  await ctx.resize(NARROW_WIDTH);
  await ctx.expectNarrowLayout();
}

/** A long explanation for "He go": many sections, so that it overflows the panel. */
function longExplanationFor(request) {
  const user = request.body.messages.find((m) => m.role === "user")?.content ?? "";
  const faulty = /=====BEGIN FAULTY WORDS \S+=====\n([\s\S]*?)\n=====END/.exec(user)?.[1];
  if (faulty !== "He go") return explanationFor(request);
  const sections = [
    "What is wrong",
    "Why",
    "Better ways",
    "More examples",
    "Common mistakes",
    "Remember",
  ];
  const lines = [];
  for (const heading of sections) {
    lines.push(`### ${heading}`);
    for (const line of [
      "In the present simple, a verb after *he*, *she* or *it* takes **-s**: *He go* should be *He goes*.",
      "- **He goes** to school every day.",
      "- **She works** in a shop and **it rains** a lot here.",
      "",
    ]) {
      lines.push(line);
    }
  }
  return { content: lines.join("\n"), usage: { prompt_tokens: 300, completion_tokens: 260 } };
}

/** Answers checks with the sample's issues and explanations with the canned explanation. */
const SAMPLE_REPLIES = (request) =>
  isExplainRequest(request) ? explanationFor(request) : CHECK_REPLY;

/**
 * Checks the sample text, then selects the issue "He go" in the list, which starts its
 * explanation. The fake server answers the explanation with `explainReply`.
 */
async function explainSelected(ctx, explainReply) {
  await checkedSample(ctx, (request) => (isExplainRequest(request) ? explainReply : CHECK_REPLY));
  // The second row is the grammar issue "He go".
  await ctx.click("issues", ".issue-row:nth-child(2)");
  await ctx.expectSelectedRow(2, "He go");
}

/** The sample text after a finished check (five issues, three categories). */
async function checkedSample(ctx, replies = SAMPLE_REPLIES) {
  ctx.llm.setReplies(replies);
  await openTutorWithText(ctx);
  await ctx.click("check");
  await ctx.waitForText("status-state", "5 issues");
  await ctx.waitForCount("#mirror span.issue", 5);
  await ctx.waitForText("status-tokens", "last: 812 in / 164 out");
}

/** A new LLM in the form, filled in, with a non-local server so that the privacy note shows. */
async function openNewLLMForm(ctx) {
  await ctx.configureFakeLLM({ name: "Fake OpenAI server" });
  await ctx.click("llm-add");
  await ctx.fill("llm-name", "Work server");
  await ctx.fill("llm-model", "gpt-4o");
  await ctx.fill("llm-base-url", "https://api.example.com/v1");
  await ctx.fill("llm-api-key", "sk-typed-secret-key");
  await ctx.waitForText("llm-privacy-note", "api.example.com");
}

async function buildAndZip() {
  await run("npm", ["run", "build"], { cwd: root });
  await run(
    "npx",
    [
      "web-ext",
      "build",
      "-s",
      "dist",
      "-a",
      "web-ext-artifacts",
      "--overwrite-dest",
      "-n",
      ZIP_NAME,
    ],
    { cwd: root },
  );
  return `${root}web-ext-artifacts/${ZIP_NAME}`;
}

async function startBrowser(theme, zipPath, downloadDir) {
  const options = new firefox.Options();
  options.addArguments("-headless");
  // Downloads (Save, Save As) go to a temporary folder without asking and without a panel, so that
  // the scenarios can check the files (SPEC section 8).
  options.setPreference("browser.download.folderList", 2);
  options.setPreference("browser.download.dir", downloadDir);
  options.setPreference("browser.download.useDownloadDir", true);
  options.setPreference("browser.download.always_ask_before_handling_new_types", false);
  options.setPreference("browser.download.alwaysOpenPanel", false);
  options.setPreference("browser.download.manager.showWhenStarting", false);
  options.setPreference("browser.helperApps.neverAsk.saveToDisk", "text/plain");
  options.setPreference(
    "extensions.webextensions.uuids",
    JSON.stringify({ [GECKO_ID]: EXTENSION_UUID }),
  );
  options.setPreference("extensions.webextOptionalPermissionPrompts", false);
  // Reduced motion: the badge of page mode shows a spinner that stands still, so that its
  // screenshot is the same on every run (the page cannot read into the badge's closed shadow root
  // to pause its animation).
  options.setPreference("ui.prefersReducedMotion", 1);
  options.setPreference(
    "layout.css.prefers-color-scheme.content-override",
    COLOR_SCHEME_PREF[theme],
  );
  // geckodriver needs --allow-system-access for the chrome context that open() uses.
  const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
  const driver = await new Builder()
    .forBrowser(Browser.FIREFOX)
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
  try {
    await sizeViewport(driver);
    await driver.installAddon(zipPath, true);
  } catch (err) {
    await driver.quit();
    throw err;
  }
  return driver;
}

/**
 * Waits until the tab shows `page` and has finished loading. A tab that `gBrowser.addTab` opens
 * starts as `about:blank` and navigates to the page; a script that runs while the document is
 * being replaced can come back with no result at all (`null`), so nothing measures or reads the
 * page before this.
 */
async function waitForPage(driver, page) {
  // A page opened with a fragment (a hand-off key) clears it, so only the path is compared.
  const path = page.split("#")[0];
  await driver.wait(
    async () =>
      (await driver.getCurrentUrl()).endsWith(`/${path}`) &&
      (await driver.executeScript("return document.readyState")) === "complete",
    PAGE_TIMEOUT_MS,
    `${page} never finished loading`,
  );
}

/** The page area's size. Asks again if the script came back empty (the page was navigating). */
async function measureViewport(driver) {
  let size;
  await driver.wait(
    async () => {
      size = await driver.executeScript("return [window.innerWidth, window.innerHeight]");
      return Array.isArray(size) && size.length === 2;
    },
    PAGE_TIMEOUT_MS,
    "the window's size could not be read",
  );
  return size;
}

/** Sizes the window so that the page area, which a screenshot captures, is `width` x HEIGHT. */
async function sizeViewport(driver, width = WIDTH) {
  const window = driver.manage().window();
  await window.setRect({ width, height: HEIGHT });
  const [innerWidth, innerHeight] = await measureViewport(driver);
  const rect = await window.getRect();
  await window.setRect({
    width: rect.width + (width - innerWidth),
    height: rect.height + (HEIGHT - innerHeight),
  });
  const [finalWidth] = await measureViewport(driver);
  if (finalWidth !== width) throw new Error(`the page area is ${finalWidth} px wide, not ${width}`);
}

/**
 * Decodes an 8-bit RGB or RGBA PNG (what the browser's screenshots are) into `{ width, height,
 * pixel(x, y) }`, so that a scenario can look at the colour of a pixel. The badge of page mode lives
 * in a closed shadow root, which the page (and so Selenium) cannot read: its state is read from
 * the picture, as a user sees it.
 */
function decodePng(png) {
  const { width, height } = pngSize(png);
  const colorType = png[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (png[24] !== 8 || channels === 0 || png[28] !== 0) throw new Error("unsupported PNG");
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i];
      const left = i >= channels ? data[y * stride + i - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      data[y * stride + i] = (value + predicted) & 255;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const o = y * stride + x * channels;
      return [data[o], data[o + 1], data[o + 2]];
    },
  };
}

/** The colours of the badge (src/content/style.ts) by what it shows, as read from a screenshot. */
const BADGE_COLORS = {
  grammar: [0xd5, 0x5e, 0x00],
  syntax: [0x00, 0x9e, 0x73],
  vocabulary: [0x00, 0x72, 0xb2],
  check: [0x1b, 0x7a, 0x3d],
  warning: [0xb3, 0x26, 0x1e],
  icon: [0x00, 0x72, 0xb2],
  spinner: [0xff, 0xff, 0xff],
};

function closeTo(pixel, expected, tolerance = 8) {
  return pixel.every((channel, i) => Math.abs(channel - expected[i]) <= tolerance);
}

function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function textOf(driver, id) {
  return driver.findElement(By.id(id)).getText();
}

/**
 * Starts a scenario from an empty database: the options page deletes the IndexedDB database (its
 * own connection closes on `versionchange`), so scenarios do not see each other's LLMs.
 */
async function resetData(ctx) {
  await ctx.open("options.html");
  const result = await ctx.driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     const request = indexedDB.deleteDatabase("english-tutor");
     request.onsuccess = () => done("deleted");
     request.onerror = () => done("failed");`,
  );
  if (result !== "deleted") throw new Error(`could not reset the database: ${result}`);
}

function makeContext(name, scenario, driver, llm, policy, folders) {
  const ctx = {
    driver,
    llm,
    /** Temporary folders outside the repository: `downloads` (where the browser saves) and `files`. */
    folders,
    /**
     * Opens an extension page in a new tab. Selenium cannot navigate to a moz-extension:// address
     * itself (the page is not web accessible, and that is how it should stay), so the browser's own
     * code opens the tab, with the system principal, as a click on the toolbar button would.
     */
    async open(page) {
      const before = await driver.getAllWindowHandles();
      await driver.setContext(firefox.Context.CHROME);
      try {
        await driver.executeScript(
          `const url = arguments[0];
           const tab = gBrowser.addTab(url, {
             triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
           });
           gBrowser.selectedTab = tab;`,
          `moz-extension://${EXTENSION_UUID}/${page}`,
        );
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
      let handle;
      await driver.wait(async () => {
        const after = await driver.getAllWindowHandles();
        handle = after.find((h) => !before.includes(h));
        return handle !== undefined;
      }, PAGE_TIMEOUT_MS);
      for (const old of before) {
        await driver.switchTo().window(old);
        await driver.close();
      }
      await driver.switchTo().window(handle);
      await waitForPage(driver, page);
      await sizeViewport(driver);
    },
    /** Makes the page area `width` px wide (and HEIGHT high), as a narrow window does. */
    async resize(width) {
      await sizeViewport(driver, width);
    },
    /** Fails unless the page really uses the scenario's colour scheme. */
    async expectTheme() {
      const dark = await driver.executeScript(
        "return window.matchMedia('(prefers-color-scheme: dark)').matches",
      );
      if (dark !== (scenario.theme === "dark")) {
        throw new Error(
          `the page is ${dark ? "dark" : "light"}, the scenario wants ${scenario.theme}`,
        );
      }
    },
    /** Takes the screenshot of the page area, which is 1280x800 unless `resize` made it narrower. */
    async screenshot({ width: expectedWidth = WIDTH } = {}) {
      const png = Buffer.from(await driver.takeScreenshot(), "base64");
      const { width, height } = pngSize(png);
      if (width !== expectedWidth || height !== HEIGHT) {
        throw new Error(`the screenshot is ${width}x${height}, not ${expectedWidth}x${HEIGHT}`);
      }
      const relative = `${scenario.dir}/${name}.png`;
      const committed = `${root}docs/screenshots/${relative}`;
      const toCommitted = policy.updateAll || policy.update.has(name) || !existsSync(committed);
      const base = toCommitted ? "docs/screenshots" : "screenshots-out";
      await mkdir(`${root}${base}/${scenario.dir}`, { recursive: true });
      await writeFile(`${root}${base}/${relative}`, png);
      console.log(`  wrote ${base}/${relative}`);
    },

    /**
     * Fields of an LLM for the options form: `name`, `provider` (default openai-compatible), `model`,
     * `baseUrl` (default: the fake server), `apiKey`. The privacy and key notes show as usual.
     */
    async addLLM(fields) {
      const {
        name,
        provider = "openai-compatible",
        model = "fake-model",
        baseUrl = llm.baseUrl,
        apiKey = "",
      } = fields;
      await ctx.click("llm-add");
      if (provider !== "openai-compatible") await ctx.choose("llm-provider", provider);
      await ctx.fill("llm-name", name);
      await ctx.fill("llm-model", model);
      // Ollama's URL is filled in by the form; typing replaces it.
      await ctx.fill("llm-base-url", baseUrl);
      if (apiKey !== "") await ctx.fill("llm-api-key", apiKey);
      await ctx.click("llm-save");
      // The form closes after a save with the permission granted (the harness grants it).
      await driver.wait(
        async () => (await driver.findElements(By.id("llm-form"))).length === 0,
        PAGE_TIMEOUT_MS,
        `the LLM form for "${name}" did not close (did the save fail?)`,
      );
    },
    /** Opens the options page and adds an LLM that points at the fake server, through the form. */
    async configureFakeLLM(fields = {}) {
      await ctx.open("options.html");
      await driver.wait(until.elementLocated(By.id("llm-add")), PAGE_TIMEOUT_MS);
      await ctx.addLLM({ name: "Fake LLM", ...fields });
    },
    /** Types into a field, replacing what it has; `after` (a Key) is sent after the text. */
    async fill(id, text, ...after) {
      const element = await driver.findElement(By.id(id));
      await element.clear();
      await element.sendKeys(text, ...after);
    },
    /** Clicks the element with this id, or, with `selector`, the first match inside it. */
    async click(id, selector) {
      const root = await driver.findElement(By.id(id));
      await (selector === undefined ? root : root.findElement(By.css(selector))).click();
    },
    async choose(selectId, value) {
      await driver.findElement(By.css(`#${selectId} option[value="${value}"]`)).click();
    },
    async waitForText(id, text) {
      await driver.wait(
        async () => (await textOf(driver, id)).includes(text),
        PAGE_TIMEOUT_MS,
        `#${id} never contained ${JSON.stringify(text)}`,
      );
    },
    async expectText(id, text) {
      if (!(await textOf(driver, id)).includes(text))
        throw new Error(`#${id} lacks ${JSON.stringify(text)}`);
    },
    async expectNoText(id, text) {
      if ((await textOf(driver, id)).includes(text))
        throw new Error(`#${id} shows ${JSON.stringify(text)}`);
    },
    async expectValue(id, expected) {
      const value = await driver.findElement(By.id(id)).getAttribute("value");
      if (value !== expected)
        throw new Error(`#${id} is ${JSON.stringify(value)}, not ${JSON.stringify(expected)}`);
    },
    /**
     * Harness only: makes the duration in a result line ("connection works (14 ms)") stable by
     * rounding it to a tenth of a second ("(0.3 s)"). Pair it with a fixed delay of the fake server.
     */
    async roundDuration(id) {
      await driver.executeScript(
        `const element = document.getElementById(arguments[0]);
         element.textContent = element.textContent.replace(
           /\\((\\d+(?:\\.\\d+)?) (ms|s)\\)/,
           (_, n, unit) => "(" + (unit === "ms" ? Number(n) / 1000 : Number(n)).toFixed(1) + " s)",
         );`,
        id,
      );
    },
    /** Waits until the element with this id is displayed. */
    async waitForVisible(id) {
      const element = await driver.findElement(By.id(id));
      await driver.wait(until.elementIsVisible(element), PAGE_TIMEOUT_MS, `#${id} never showed`);
    },
    async expectHidden(id) {
      if (await driver.findElement(By.id(id)).isDisplayed()) throw new Error(`#${id} is shown`);
    },
    async expectEnabled(id) {
      if (!(await driver.findElement(By.id(id)).isEnabled())) throw new Error(`#${id} is disabled`);
    },
    async expectDisabled(id) {
      if (await driver.findElement(By.id(id)).isEnabled()) throw new Error(`#${id} is enabled`);
    },
    async expectReadOnly(id) {
      const readOnly = await driver.findElement(By.id(id)).getAttribute("readonly");
      if (readOnly === null) throw new Error(`#${id} is not read-only`);
    },
    /** Waits until exactly `count` elements match the CSS selector. */
    async waitForCount(selector, count) {
      await driver.wait(
        async () => (await driver.findElements(By.css(selector))).length === count,
        PAGE_TIMEOUT_MS,
        `${selector} never matched ${count} element(s)`,
      );
    },
    /**
     * Harness only: removes what changes between runs of the same page. The focus goes (no
     * blinking caret), and animations (the busy indicator) stop at their first frame.
     */
    async stabilise({ keepFocus = false } = {}) {
      await driver.executeScript(
        `if (!arguments[0] && document.activeElement instanceof HTMLElement) {
           document.activeElement.blur();
         }
         for (const animation of document.getAnimations()) {
           animation.pause();
           animation.currentTime = 0;
         }`,
        keepFocus,
      );
    },
    /** Sends keys to the element with this id, as a user typing into it. */
    async keys(id, ...keys) {
      await driver.findElement(By.id(id)).sendKeys(...keys);
    },
    /** Moves the mouse over the first line of the underline with this text. */
    async hoverIssue(snippet) {
      const point = await driver.executeScript(
        `const span = [...document.querySelectorAll("#mirror span.issue")]
           .find((s) => s.textContent === arguments[0]);
         const rect = span.getClientRects()[0];
         return { x: Math.round(rect.left + 12), y: Math.round(rect.top + rect.height / 2) };`,
        snippet,
      );
      await driver.actions({ async: true }).move({ x: point.x, y: point.y }).perform();
    },
    /** Fails unless the n-th row (1-based) is the only selected one and shows this snippet. */
    async expectSelectedRow(n, snippet) {
      const rows = await driver.findElements(By.css("#issues .issue-row"));
      const flags = await Promise.all(rows.map((r) => r.getAttribute("aria-selected")));
      const expected = rows.map((_, i) => String(i === n - 1));
      if (JSON.stringify(flags) !== JSON.stringify(expected)) {
        throw new Error(`selected rows are ${flags.join(",")}, expected row ${n} only`);
      }
      const text = await rows[n - 1].getText();
      if (!text.includes(snippet)) throw new Error(`row ${n} shows ${JSON.stringify(text)}`);
    },
    async expectCaret(id, offset) {
      const caret = await driver.executeScript(
        "return document.getElementById(arguments[0]).selectionStart",
        id,
      );
      if (caret !== offset) throw new Error(`#${id} has its caret at ${caret}, not ${offset}`);
    },
    async waitForScrollTop(id, top) {
      await driver.wait(
        async () =>
          (await driver.executeScript(
            "return document.getElementById(arguments[0]).scrollTop",
            id,
          )) === top,
        PAGE_TIMEOUT_MS,
        `#${id} never scrolled to ${top}`,
      );
    },
    /** Waits until the element is scrolled down, and fails if the selected issue is out of view. */
    async expectScrolled(id) {
      await driver.wait(
        () =>
          driver.executeScript(
            `const e = document.getElementById(arguments[0]);
             const view = e.getBoundingClientRect();
             const span = document.querySelector("#mirror .issue-selected");
             const rect = span.getClientRects()[0];
             return e.scrollTop > 0 && rect.top >= view.top && rect.bottom <= view.bottom;`,
            id,
          ),
        PAGE_TIMEOUT_MS,
        `#${id} never scrolled to the selected issue`,
      );
    },
    async expectFocus(id) {
      const focused = await driver.executeScript("return document.activeElement.id");
      if (focused !== id) throw new Error(`the focus is in #${focused || "(nothing)"}, not #${id}`);
    },
    async expectChecked(id) {
      if (!(await driver.findElement(By.id(id)).isSelected())) throw new Error(`#${id} is off`);
    },
    /** Fails unless the mirror underlines exactly these words, in order. */
    async expectUnderlined(words) {
      const shown = await driver.executeScript(
        'return [...document.querySelectorAll("#mirror span.issue")].map((s) => s.textContent)',
      );
      if (JSON.stringify(shown) !== JSON.stringify(words)) {
        throw new Error(`underlined ${JSON.stringify(shown)}, expected ${JSON.stringify(words)}`);
      }
    },
    /** Auto-check issues get no count badge (step 9 shows them for manual checks only). */
    async expectNoCountBadges() {
      const shown = await driver.executeScript(
        'return [...document.querySelectorAll("#issues .count-badge")].filter((b) => !b.hidden).length',
      );
      if (shown !== 0) throw new Error(`${shown} count badge(s) shown`);
    },
    /** Scrolls an element with the mouse wheel, as a user does. */
    async wheelScroll(id, deltaY) {
      const element = await driver.findElement(By.id(id));
      await driver.actions({ async: true }).scroll(0, 0, 0, deltaY, element).perform();
    },
    async waitForScrolledToEnd(id) {
      await driver.wait(
        () =>
          driver.executeScript(
            `const e = document.getElementById(arguments[0]);
             return e.scrollTop > 0 && e.scrollTop + e.clientHeight >= e.scrollHeight - 1;`,
            id,
          ),
        PAGE_TIMEOUT_MS,
        `#${id} never scrolled to its end`,
      );
    },
    /** Waits until the explanation panel shows a finished explanation for this error type. */
    async waitForExplanation(label) {
      await ctx.waitForText("explain-header", label);
      await ctx.expectDataState("explain-panel", "ready");
      await ctx.waitForVisible("explain-regenerate");
    },
    async expectDataState(id, state) {
      await driver.wait(
        async () => (await driver.findElement(By.id(id)).getAttribute("data-state")) === state,
        PAGE_TIMEOUT_MS,
        `#${id} never got the state ${state}`,
      );
    },
    /**
     * Fails unless the explanation shows rendered markdown (headings, bold, a list, code and the
     * one link) and no raw markers. `complete: false` is for a half-written text, which has
     * fewer parts but still no raw markers.
     */
    async expectMarkdownRendered({ complete = true } = {}) {
      const found = await driver.executeScript(
        `const body = document.getElementById("explain-body");
         const count = (selector) => body.querySelectorAll(selector).length;
         return {
           headings: count("h5"), bold: count("strong"), items: count("li"), code: count("code"),
           links: count("a"), text: body.textContent,
           images: count("img, script, iframe"),
         };`,
      );
      const raw = ["**", "###", "](", "`"].filter((marker) => found.text.includes(marker));
      if (raw.length > 0) throw new Error(`the explanation shows raw markdown: ${raw.join(" ")}`);
      if (found.headings < 1 || found.bold < 1) throw new Error("no heading or bold text rendered");
      if (found.images > 0) throw new Error("the explanation has active elements");
      if (complete && (found.items < 2 || found.code < 1 || found.links !== 1)) {
        throw new Error(
          `the explanation lacks parts: ${found.items} items, ${found.code} code, ${found.links} links`,
        );
      }
    },
    /** Fails unless the element is scrolled to its end (the streaming text is followed). */
    async expectFollowingEnd(id) {
      const state = await driver.executeScript(
        `const e = document.getElementById(arguments[0]);
         return { top: e.scrollTop, end: e.scrollTop + e.clientHeight >= e.scrollHeight - 2,
                  overflows: e.scrollHeight > e.clientHeight };`,
        id,
      );
      if (state.overflows && !state.end)
        throw new Error(`#${id} does not follow the end of the text`);
    },
    /** Fails unless the number of open tabs is `count`. */
    async expectTabs(count) {
      await driver.wait(
        async () => (await driver.getAllWindowHandles()).length === count,
        PAGE_TIMEOUT_MS,
        `there are never ${count} tab(s)`,
      );
      if ((await driver.getAllWindowHandles()).length !== count) throw new Error("wrong tab count");
    },
    /** Fails unless the current tab is still the tutor page. */
    async expectTutorPage() {
      const url = await driver.getCurrentUrl();
      if (!url.endsWith("/tutor.html")) throw new Error(`the page navigated to ${url}`);
    },
    /**
     * Waits until the count badges of the rows (in order) read exactly `texts`: "x3", or "" for a
     * row without a badge.
     */
    async waitForBadges(texts) {
      let last;
      await driver
        .wait(async () => {
          last = await driver.executeScript(
            `return [...document.querySelectorAll("#issues .issue-row .count-badge")].map(
               (b) => (b.hidden ? "" : b.textContent));`,
          );
          return JSON.stringify(last) === JSON.stringify(texts);
        }, PAGE_TIMEOUT_MS)
        .catch(() => {
          throw new Error(`the badges read ${JSON.stringify(last)}, not ${JSON.stringify(texts)}`);
        });
    },
    async expectBadgeTitle(n, title) {
      const found = await driver.executeScript(
        `return document.querySelectorAll("#issues .issue-row .count-badge")[arguments[0] - 1].title`,
        n,
      );
      if (found !== title) throw new Error(`badge ${n} has the title ${JSON.stringify(found)}`);
    },
    /**
     * Harness only: the dates in the Statistics dialog are the day the scenario runs on (the
     * mistakes were just recorded), so they are rewritten to a fixed day right before the shot, as
     * `roundDuration` does for a duration.
     */
    async fixDates(id, day = "2026-03-05") {
      await driver.executeScript(
        `const walker = document.createTreeWalker(document.getElementById(arguments[0]), NodeFilter.SHOW_TEXT);
         for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
           node.textContent = node.textContent.replace(/\\d{4}-\\d{2}-\\d{2}/g, arguments[1]);
         }`,
        id,
        day,
      );
    },
    /** Fails unless the table of the Mistakes tab has these rows (type, category, total), in order. */
    async expectStatsRows(expected) {
      const found = await driver.executeScript(
        `return [...document.querySelectorAll("#stats-rows .stats-row")].map(
           (tr) => [...tr.querySelectorAll("td")].slice(0, 3).map((td) => td.textContent));`,
      );
      if (JSON.stringify(found) !== JSON.stringify(expected)) {
        throw new Error(
          `the table has ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`,
        );
      }
    },
    /**
     * Opens an extension page in a new tab and leaves the others open, unlike `open`.
     */
    async openAlongside(page) {
      const before = await driver.getAllWindowHandles();
      await driver.setContext(firefox.Context.CHROME);
      try {
        await driver.executeScript(
          `const tab = gBrowser.addTab(arguments[0], {
             triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
           });
           gBrowser.selectedTab = tab;`,
          `moz-extension://${EXTENSION_UUID}/${page}`,
        );
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
      let handle;
      await driver.wait(async () => {
        const after = await driver.getAllWindowHandles();
        handle = after.find((h) => !before.includes(h));
        return handle !== undefined;
      }, PAGE_TIMEOUT_MS);
      await driver.switchTo().window(handle);
      await waitForPage(driver, page);
      await sizeViewport(driver);
    },
    /**
     * Right-clicks the n-th row (1-based) and returns the labels of the entries of the browser's
     * context menu, read from the browser itself. The menu stays open.
     */
    async openRowMenu(n) {
      const row = await driver.findElement(By.css(`#issues .issue-row:nth-child(${n})`));
      await driver.actions({ async: true }).contextClick(row).perform();
      let labels = [];
      await driver.setContext(firefox.Context.CHROME);
      try {
        await driver.wait(
          async () => {
            labels = await driver.executeScript(ROW_MENU_LABELS);
            return labels.length > 0;
          },
          PAGE_TIMEOUT_MS,
          "the row menu never opened",
        );
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
      return labels;
    },
    /** Chooses an entry of the open context menu, as a click on it does. */
    async chooseRowMenuItem(label) {
      await driver.setContext(firefox.Context.CHROME);
      try {
        const chosen = await driver.executeScript(
          `const popup = document.getElementById("contentAreaContextMenu");
           const item = [...popup.children].find((m) => m.localName === "menuitem" && !m.hidden && m.label === arguments[0]);
           if (item === undefined || item.disabled) return false;
           item.doCommand();
           popup.hidePopup();
           return true;`,
          label,
        );
        if (!chosen) throw new Error(`the menu has no enabled entry "${label}"`);
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    /**
     * Selects `part` in the editor (the first occurrence in its text) the way a user would leave
     * it, with a real mouse-free selection through the page's own text selection, and returns a
     * point in the middle of the text on screen (from the mirror, which holds the same text), so
     * that a right-click lands on the selection and keeps it.
     */
    async selectInEditor(part, { backwards = false, collapse = false } = {}) {
      return driver.executeScript(
        `const editor = document.getElementById("editor");
         const [part, backwards, collapse] = arguments;
         const start = editor.value.indexOf(part);
         if (start < 0) throw new Error("the editor has no " + part);
         editor.focus();
         if (collapse) editor.setSelectionRange(start + 2, start + 2);
         else editor.setSelectionRange(start, start + part.length, backwards ? "backward" : "forward");
         // Where the text is on screen: a range over the mirror's text, which has the same text.
         const mirror = document.getElementById("mirror");
         const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
         let offset = 0;
         for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
           const end = offset + node.length;
           if (start >= offset && start < end) {
             const range = document.createRange();
             const from = start - offset;
             range.setStart(node, from);
             range.setEnd(node, Math.min(node.length, from + Math.max(1, Math.min(part.length, 4))));
             const rect = range.getClientRects()[0];
             return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
           }
           offset = end;
         }
         throw new Error("the mirror has no text at " + start);`,
        part,
        backwards,
        collapse,
      );
    },
    /** Right-clicks a point of the page and returns the open context menu (see `readOpenMenu`). */
    async rightClickAt(point) {
      await driver
        .actions({ async: true })
        .move({ x: point.x, y: point.y })
        .contextClick()
        .perform();
      return ctx.readOpenMenu();
    },
    /**
     * The entries of the open context menu, in order, read from the browser itself:
     * `{ label, disabled }` for each visible entry (an entry inside a submenu has `submenu` set
     * to the submenu's label). Waits for the menu to open, and for the extension's entries to be
     * made visible, which the page does after the menu is shown.
     */
    async readOpenMenu({ settleMs = 600 } = {}) {
      await driver.setContext(firefox.Context.CHROME);
      try {
        let entries = [];
        await driver.wait(
          async () => {
            entries = await driver.executeScript(MENU_ENTRIES);
            return entries.length > 0;
          },
          PAGE_TIMEOUT_MS,
          "the context menu never opened",
        );
        // The page makes its entries visible in `menus.onShown`, after the popup opens.
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        return await driver.executeScript(MENU_ENTRIES);
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    /**
     * Opens a test page of the fake server (`PAGES`) in a new tab and leaves the other tabs open,
     * as the browser would for a link. The tab is opened by the browser's own code, as `open` does.
     */
    async openWebPage(name) {
      const before = await driver.getAllWindowHandles();
      await driver.setContext(firefox.Context.CHROME);
      try {
        await driver.executeScript(
          `const tab = gBrowser.addTab(arguments[0], {
             triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
           });
           gBrowser.selectedTab = tab;`,
          llm.pageUrl(name),
        );
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
      await ctx.switchToNewTab(before);
      await driver.wait(
        async () =>
          (await driver.getCurrentUrl()).endsWith(`/pages/${name}`) &&
          (await driver.executeScript("return document.readyState")) === "complete",
        PAGE_TIMEOUT_MS,
        `${name} never finished loading`,
      );
      await sizeViewport(driver);
    },
    /** Switches to the tab that is not in `before` (a list of window handles) and returns its handle. */
    async switchToNewTab(before) {
      let handle;
      await driver.wait(
        async () => {
          const after = await driver.getAllWindowHandles();
          handle = after.find((h) => !before.includes(h));
          return handle !== undefined;
        },
        PAGE_TIMEOUT_MS,
        "no new tab opened",
      );
      await driver.switchTo().window(handle);
      return handle;
    },
    /**
     * Selects all the text of the element on a web page the way a user does with the mouse, and
     * returns a point inside it for a right-click that keeps the selection.
     */
    async selectElementText(id) {
      return driver.executeScript(
        `const element = document.getElementById(arguments[0]);
         const range = document.createRange();
         range.selectNodeContents(element);
         const selection = window.getSelection();
         selection.removeAllRanges();
         selection.addRange(range);
         const rect = range.getClientRects()[0];
         return { x: Math.round(rect.left + 60), y: Math.round(rect.top + rect.height / 2) };`,
        id,
      );
    },
    /**
     * Chooses an entry inside a submenu of the open context menu (the extension's "English
     * Tutor" submenu of a web page), as a click on it does.
     */
    async chooseSubmenuItem(submenuLabel, label) {
      await driver.setContext(firefox.Context.CHROME);
      try {
        const chosen = await driver.executeScript(
          `const popup = document.getElementById("contentAreaContextMenu");
           const menu = [...popup.children].find((m) => m.localName === "menu" && !m.hidden && m.label === arguments[0]);
           if (menu === undefined) return "no submenu " + arguments[0];
           const inner = menu.menupopup ?? menu.querySelector("menupopup");
           const item = [...inner.children].find((m) => m.localName === "menuitem" && !m.hidden && m.label === arguments[1]);
           if (item === undefined || item.disabled) return "no enabled entry " + arguments[1];
           item.doCommand();
           popup.hidePopup();
           return "ok";`,
          submenuLabel,
          label,
        );
        if (chosen !== "ok") throw new Error(chosen);
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    /**
     * The whole path of the web page menu (SPEC section 4.1): opens the test page in a tab,
     * selects the text of the element, right-clicks it, checks that the browser's own menu has
     * the "English Tutor" submenu with both entries, chooses `entry` from it, and follows the new
     * tutor tab that opens. Returns the selected text.
     */
    async chooseFromWebPageMenu(elementId, entry) {
      await ctx.openWebPage("selection.html");
      const text = await driver.executeScript(
        "return document.getElementById(arguments[0]).textContent",
        elementId,
      );
      const menu = await ctx.rightClickAt(await ctx.selectElementText(elementId));
      const sub = menu.filter((e) => e.submenu === "English Tutor").map((e) => e.label);
      const parent = menu.find((e) => e.label === "English Tutor");
      if (parent === undefined || !parent.isMenu) {
        throw new Error(`the web page menu has no English Tutor submenu: ${JSON.stringify(menu)}`);
      }
      if (
        JSON.stringify(sub) !==
        JSON.stringify(["Check with English Tutor", "Alternatives with English Tutor"])
      ) {
        throw new Error(`the submenu holds ${JSON.stringify(sub)}`);
      }
      const before = await driver.getAllWindowHandles();
      await ctx.chooseSubmenuItem("English Tutor", entry);
      await ctx.switchToNewTab(before);
      await waitForPage(driver, "tutor.html");
      await sizeViewport(driver);
      await ctx.expectCleanAddress();
      return text;
    },
    /** Fails unless the page's address has no fragment (the hand-off key went from it). */
    async expectCleanAddress() {
      await driver.wait(
        async () => !(await driver.getCurrentUrl()).includes("#"),
        PAGE_TIMEOUT_MS,
        `the address still has a fragment: ${await driver.getCurrentUrl()}`,
      );
    },
    /** Fails unless `storage.session` holds exactly `count` hand-off entries (read from the page). */
    async expectHandoffEntries(count) {
      const keys = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.storage.session.get(null).then((all) => done(Object.keys(all).filter((k) => k.startsWith("handoff:"))));`,
      );
      if (keys.length !== count)
        throw new Error(`${keys.length} hand-off entries, expected ${count}`);
    },
    /** Runs code in the browser's own window, for the harness's tab and button helpers. */
    async chrome(script, ...args) {
      await driver.setContext(firefox.Context.CHROME);
      try {
        return await driver.executeAsyncScript(
          `const done = arguments[arguments.length - 1];
           const args = [...arguments].slice(0, -1);
           (async () => { ${script} })().then(done, (e) => done({ error: String(e) }));`,
          ...args,
        );
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    /** Brings the n-th tab (0-based) to the front, as a click on it does. */
    async selectTab(index) {
      await ctx.chrome("gBrowser.selectedTab = gBrowser.tabs[arguments[0]];", index);
    },
    async closeTab(index) {
      await ctx.chrome("gBrowser.removeTab(gBrowser.tabs[arguments[0]]);", index);
    },
    /**
     * Presses the extension's toolbar button. A headless browser keeps the button in the
     * extensions panel, which is not built, so the harness puts it on the toolbar first (as a
     * user can) and clicks that.
     */
    async clickToolbarButton() {
      const result = await ctx.chrome(
        `const id = "english-tutor_rm4n0s_dev-browser-action";
         CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR);
         await new Promise((r) => setTimeout(r, 200));
         const node = CustomizableUI.getWidget(id).forWindow(window).node;
         const button = node.querySelector("toolbarbutton");
         if (!node.isConnected || !button) return "the toolbar button is not there";
         button.click();
         return "ok";`,
      );
      if (result !== "ok") throw new Error(String(result?.error ?? result));
    },
    /** Fails unless tab `index` is in front and there are `count` tabs (waits for the browser to settle). */
    async expectSelectedTab(index, count) {
      let state;
      await driver
        .wait(async () => {
          state = await ctx.chrome(
            "return { index: gBrowser.tabs.indexOf(gBrowser.selectedTab), count: gBrowser.tabs.length };",
          );
          return state.index === index && state.count === count;
        }, PAGE_TIMEOUT_MS)
        .catch(() => {
          throw new Error(
            `tab ${state?.index} of ${state?.count} is in front, expected tab ${index} of ${count}`,
          );
        });
      // And it stays so: the button did not open another tab a moment later.
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await ctx.chrome(
        "return { index: gBrowser.tabs.indexOf(gBrowser.selectedTab), count: gBrowser.tabs.length };",
      );
      if (state.index !== index || state.count !== count) {
        throw new Error(`later: tab ${state.index} of ${state.count} is in front`);
      }
    },
    async expectTabCount(count) {
      await driver.wait(
        async () => (await ctx.chrome("return gBrowser.tabs.length;")) === count,
        PAGE_TIMEOUT_MS,
        `there are never ${count} tab(s)`,
      );
    },
    async expectSelectedUrl(page) {
      await driver.wait(
        async () =>
          String(await ctx.chrome("return gBrowser.selectedBrowser.currentURI.spec;")).endsWith(
            `/${page}`,
          ),
        PAGE_TIMEOUT_MS,
        `the tab in front never showed ${page}`,
      );
    },
    /**
     * Waits until the extension has exactly `count` notifications showing and returns them (id to
     * options). Runs in the current page, which must be an extension page.
     */
    async waitForNotifications(count) {
      let last;
      await driver
        .wait(async () => {
          last = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             browser.notifications.getAll().then(done);`,
          );
          return Object.keys(last).length === count;
        }, PAGE_TIMEOUT_MS)
        .catch(() => {
          throw new Error(`the extension has these notifications: ${JSON.stringify(last)}`);
        });
      return last;
    },
    async clearNotifications() {
      await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.notifications.getAll().then((all) =>
           Promise.all(Object.keys(all).map((id) => browser.notifications.clear(id)))).then(() => done());`,
      );
    },
    /** Fails if the extension has a notification, after giving a late one time to arrive. */
    async expectNoNotifications() {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const all = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.notifications.getAll().then(done);`,
      );
      if (Object.keys(all).length > 0) {
        throw new Error(`a notification was made: ${JSON.stringify(all)}`);
      }
    },
    /** Fails unless the element's computed font is `family` (its first name) at `px` pixels. */
    async expectFont(id, { family, px }) {
      const found = await driver.executeScript(
        `const style = getComputedStyle(document.getElementById(arguments[0]));
         return { family: style.fontFamily, size: parseFloat(style.fontSize) };`,
        id,
      );
      if (!found.family.startsWith(family) || Math.abs(found.size - px) > 0.05) {
        throw new Error(
          `#${id} uses ${found.family} at ${found.size}px, expected ${family} at ${px}px`,
        );
      }
    },
    /** Fails unless the element's content is taller than its box, so that it scrolls. */
    async expectOverflows(id) {
      const overflows = await driver.executeScript(
        "const e = document.getElementById(arguments[0]); return e.scrollHeight > e.clientHeight + 20;",
        id,
      );
      if (!overflows)
        throw new Error(`#${id} does not overflow, so the scroll position proves nothing`);
    },
    /**
     * Fails unless the page is in its narrow layout: the right column is under the editor, and
     * both fill the width.
     */
    async expectNarrowLayout() {
      const found = await driver.executeScript(
        `const rect = (id) => document.getElementById(id).getBoundingClientRect();
         const editor = rect("editor-box");
         const side = rect("side");
         return { editorBottom: editor.bottom, sideTop: side.top, editorWidth: editor.width,
                  sideWidth: side.width, page: window.innerWidth };`,
      );
      if (found.sideTop < found.editorBottom - 1 || found.sideWidth < found.page - 2) {
        throw new Error(`the layout is not narrow: ${JSON.stringify(found)}`);
      }
    },
    /** The two pane sizes as percentages: the editor's share of the width, the issues' share of the column. */
    async paneSizes() {
      return driver.executeScript(
        `const rect = (id) => document.getElementById(id).getBoundingClientRect();
         const panes = rect("panes");
         const side = rect("side");
         return { editor: rect("editor-box").width / panes.width * 100,
                  issues: rect("issues-pane").height / side.height * 100 };`,
      );
    },
    /** Drags a divider by (dx, dy) pixels with the mouse. */
    async dragDivider(id, dx, dy) {
      const handle = await driver.findElement(By.id(id));
      await driver
        .actions({ async: true })
        .move({ origin: handle })
        .press()
        .move({ origin: handle, x: dx, y: dy })
        .release()
        .perform();
    },
    /**
     * Fails unless the extension has a menu entry with each of these ids. The page asks the
     * browser to make one with the same id, which it refuses ("already exists") if it is there.
     */
    async expectBackgroundMenus(ids) {
      const answers = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         const ids = arguments[0];
         Promise.all(ids.map((id) => new Promise((resolve) =>
           browser.menus.create({ id, title: "probe", contexts: ["tools_menu"] },
             () => resolve(String(browser.runtime.lastError?.message ?? "made")))))).then(done);`,
        ids,
      );
      const missing = ids.filter((_, i) => !answers[i].includes("already exists"));
      if (missing.length > 0) throw new Error(`the menu entries ${missing.join(", ")} are missing`);
    },
    /** Closes the open context menu without choosing anything. */
    async closeMenu() {
      await driver.setContext(firefox.Context.CHROME);
      try {
        await driver.executeScript('document.getElementById("contentAreaContextMenu").hidePopup()');
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    /** Replaces the editor's text through the keyboard-free route of the page: types it. */
    async editorValue() {
      return driver.executeScript('return document.getElementById("editor").value');
    },
    async editorSelection() {
      return driver.executeScript(
        `const e = document.getElementById("editor");
         return { start: e.selectionStart, end: e.selectionEnd, focused: document.activeElement === e };`,
      );
    },
    /** Fails unless the alternatives panel lists exactly these rows. */
    async expectAlternativeRows(expected) {
      await driver.wait(
        async () => {
          const rows = await driver.executeScript(
            'return [...document.querySelectorAll("#alt-list .alt-row")].map((r) => r.textContent)',
          );
          return JSON.stringify(rows) === JSON.stringify(expected);
        },
        PAGE_TIMEOUT_MS,
        `the alternatives never were ${JSON.stringify(expected)}`,
      );
    },
    async waitForEditorValue(expected) {
      let last;
      await driver
        .wait(async () => {
          last = await ctx.editorValue();
          return last === expected;
        }, PAGE_TIMEOUT_MS)
        .catch(() => {
          throw new Error(
            `the editor holds ${JSON.stringify(last)}, not ${JSON.stringify(expected)}`,
          );
        });
    },
    /** The ids of the rows of the issues list, in order. */
    async rowIds() {
      return driver.executeScript(
        'return [...document.querySelectorAll("#issues .issue-row")].map((r) => r.dataset.id)',
      );
    },
    /**
     * Fails unless the clipboard holds `text`: it is pasted into a scratch text box that the
     * harness adds and removes (the page's own editor is not touched).
     */
    async expectClipboardPasted(text) {
      await driver.executeScript(
        `const box = document.createElement("textarea");
         box.id = "scratch-paste";
         document.body.append(box);
         box.focus();`,
      );
      await driver.findElement(By.id("scratch-paste")).sendKeys(Key.chord(Key.CONTROL, "v"));
      const pasted = await driver.findElement(By.id("scratch-paste")).getAttribute("value");
      await driver.executeScript('document.getElementById("scratch-paste").remove()');
      if (pasted !== text) {
        throw new Error(
          `the clipboard holds ${JSON.stringify(pasted)}, not ${JSON.stringify(text)}`,
        );
      }
    },
    /**
     * Fails unless the open menu is the editor's: the browser's own entries (Undo, Cut, Copy,
     * Paste, Select All) and **Alternative** followed by **Check**. Where they stand among the
     * browser's entries is the browser's choice (Firefox lists an extension's entries first).
     * `checkDisabled`: Check is greyed out. `absent`: neither of our entries shows.
     */
    expectEditorMenu(menu, { checkDisabled = false, absent = false } = {}) {
      const labels = menu.map((e) => e.label);
      const describe = () => JSON.stringify(menu);
      // The web page menu of the background script is for web pages, not for the tutor page.
      if (labels.includes("English Tutor")) {
        throw new Error(`the web page submenu shows in the editor menu: ${describe()}`);
      }
      if (absent) {
        if (labels.includes("Alternative") || labels.includes("Check")) {
          throw new Error(`the menu shows our entries: ${describe()}`);
        }
        return;
      }
      const at = (label) => labels.indexOf(label);
      // The browser's own entries are all there (spell check and Search come and go).
      const missing = ["Undo", "Cut", "Copy", "Paste", "Select All"].filter((l) => at(l) < 0);
      if (missing.length > 0) {
        throw new Error(
          `the menu lacks the browser's entries ${missing.join(", ")}: ${describe()}`,
        );
      }
      const alt = at("Alternative");
      const check = at("Check");
      if (alt < 0 || check !== alt + 1) {
        throw new Error(`Alternative and Check are not together, in that order: ${describe()}`);
      }
      if (menu[alt].disabled) throw new Error(`Alternative is disabled: ${describe()}`);
      if (menu[check].disabled !== checkDisabled) {
        throw new Error(`Check is ${menu[check].disabled ? "disabled" : "enabled"}: ${describe()}`);
      }
      if (menu[alt].submenu || menu[check].submenu) {
        throw new Error(`our entries are in a submenu: ${describe()}`);
      }
    },
    async scrollTo(id) {
      await driver.executeScript("document.getElementById(arguments[0]).scrollIntoView()", id);
    },
    /** Writes a test file into the temporary `files` folder and returns its path. */
    async writeTestFile(fileName, content) {
      const path = join(folders.files, fileName);
      await writeFile(path, content);
      return path;
    },
    /**
     * Chooses a file in the page's hidden file input, as the browser's chooser does: the path is
     * sent to the input element, so no native dialog opens.
     */
    async chooseFile(path) {
      await driver.findElement(By.id("file-input")).sendKeys(path);
    },
    /** The page's tab title (the window title of the tab). */
    async expectTitle(expected) {
      await driver.wait(
        async () => (await driver.getTitle()) === expected,
        PAGE_TIMEOUT_MS,
        `the tab title never became ${JSON.stringify(expected)}`,
      );
    },
    /**
     * Waits for a finished download in the temporary downloads folder (no `.part` file left) and
     * returns its bytes. The file is removed, so the next download of the same name is not renamed.
     */
    async takeDownload(fileName) {
      let found;
      await driver.wait(
        async () => {
          const names = await readdir(folders.downloads);
          if (names.some((n) => n.endsWith(".part"))) return false;
          found = names.includes(fileName);
          return found;
        },
        PAGE_TIMEOUT_MS,
        `${fileName} was never downloaded (the folder holds: ${(await readdir(folders.downloads)).join(", ") || "nothing"})`,
      );
      const path = join(folders.downloads, fileName);
      const bytes = await readFile(path);
      await rm(path);
      return bytes;
    },
    /**
     * Reloads the tab. A page with unsaved changes asks the browser's "leave this page?" question
     * (beforeunload), which the harness accepts, as a user pressing "Leave Page" does.
     */
    async reload() {
      try {
        await driver.navigate().refresh();
      } catch (err) {
        if (err?.name !== "UnexpectedAlertOpenError") throw err;
        await driver.switchTo().alert().accept();
      }
      await waitForPage(driver, "tutor.html");
    },
    async expectNoBanner() {
      if (await driver.findElement(By.id("banner")).isDisplayed()) {
        throw new Error(`the banner shows: ${await textOf(driver, "banner")}`);
      }
    },
    async waitForDialog(id) {
      await driver.wait(
        () =>
          driver.executeScript(
            "const d = document.getElementById(arguments[0]); return d !== null && d.open;",
            id,
          ),
        PAGE_TIMEOUT_MS,
        `the dialog #${id} never opened`,
      );
    },
    // Page mode (SPEC section 4.11)

    /**
     * Turns page mode on the way a user does: ticks "Check text boxes on websites" on the options
     * page (the optional-permission preference grants `<all_urls>` without a prompt), and waits
     * until the background script has registered the content script. The pause of the automatic
     * check is set to one second (the shortest) so that scenarios do not wait for three.
     */
    async turnOnPageMode({ delay = 1 } = {}) {
      await driver.wait(until.elementLocated(By.id("page-mode")), PAGE_TIMEOUT_MS);
      await ctx.click("page-mode");
      await driver.wait(
        async () =>
          (await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             browser.scripting.getRegisteredContentScripts({ ids: ["page-mode"] }).then(
               (found) => done(found.length), () => done(-1));`,
          )) === 1,
        PAGE_TIMEOUT_MS,
        `the page-mode content script was never registered. Options page: ${await driver
          .executeScript(
            `return JSON.stringify({ checked: document.getElementById("page-mode").checked,
               error: document.getElementById("page-mode-error").textContent,
               banner: document.getElementById("options-error").textContent })`,
          )
          .catch(() => "?")}`,
      );
      if (await driver.findElement(By.id("page-mode-error")).isDisplayed()) {
        throw new Error(`page mode failed: ${await textOf(driver, "page-mode-error")}`);
      }
      // The delay is used by page mode, so its field is enabled now.
      await ctx.fill("auto-check-delay", String(delay), Key.TAB);
    },
    /**
     * Opens a test page of the fake server in a new tab, and waits until the page-mode content
     * script has started on it (its host element, a `div` directly in `<html>`, is there).
     */
    async openPageModePage(name) {
      await ctx.openWebPage(name);
      await driver.wait(
        () =>
          driver.executeScript(
            "return [...document.documentElement.children].some((c) => c.tagName === 'DIV')",
          ),
        PAGE_TIMEOUT_MS,
        `page mode never started on ${name}`,
      );
    },
    /** Clicks a text box of the page, as the user does to start writing in it. */
    async focusBox(id = "box") {
      await driver.findElement(By.id(id)).click();
    },
    /** The window coordinates of the middle of the badge of the box with this id (SPEC section 4.11). */
    async badgeCenter(id = "box") {
      return driver.executeScript(
        `const box = document.getElementById(arguments[0]);
         const rect = box.getBoundingClientRect();
         const style = getComputedStyle(box);
         const px = (v) => parseFloat(v) || 0;
         const sx = Math.max(0, box.offsetWidth - box.clientWidth - px(style.borderLeftWidth) - px(style.borderRightWidth));
         const sy = Math.max(0, box.offsetHeight - box.clientHeight - px(style.borderTopWidth) - px(style.borderBottomWidth));
         return {
           x: Math.round(rect.right - px(style.borderRightWidth) - sx - 22 - 4) + 11,
           y: Math.round(rect.bottom - px(style.borderBottomWidth) - sy - 22 - 4) + 11,
         };`,
        id,
      );
    },
    /** The colour of the picture at a point: a fresh screenshot, so what the user sees. */
    async pixelAt(x, y) {
      const png = Buffer.from(await driver.takeScreenshot(), "base64");
      return decodePng(png).pixel(x, y);
    },
    /**
     * Waits until the badge of the box shows `kind` (`grammar`, `syntax` and `vocabulary` for a
     * count in that colour, `check`, `warning`, `icon` or `spinner`), read from the pixels a user
     * sees, 7 px above the badge's middle (clear of its glyph).
     */
    async waitForBadge(kind, id = "box") {
      const { x, y } = await ctx.badgeCenter(id);
      const deadline = Date.now() + PAGE_TIMEOUT_MS;
      for (;;) {
        const pixel = await ctx.pixelAt(x, y - 7);
        if (closeTo(pixel, BADGE_COLORS[kind])) return;
        if (Date.now() > deadline) {
          throw new Error(
            `the badge of #${id} never showed ${kind} (the pixel at ${x},${y - 7} is ${String(pixel)})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    /** Fails if the badge of the box shows anything but the page behind it (white) or the box. */
    async expectNoBadge(id = "box") {
      const { x, y } = await ctx.badgeCenter(id);
      const pixel = await ctx.pixelAt(x, y - 7);
      if (
        Object.values(BADGE_COLORS).some((c) => !closeTo(c, [255, 255, 255]) && closeTo(pixel, c))
      ) {
        throw new Error(`#${id} has a badge (the pixel at ${x},${y - 7} is ${String(pixel)})`);
      }
    },
    /** The number of requests the fake LLM has received since the scenario began. */
    llmRequests() {
      return llm.requests.length;
    },
    /** Waits until the fake LLM has received `count` requests. */
    async waitForLLMRequests(count) {
      await driver.wait(
        () => llm.requests.length >= count,
        PAGE_TIMEOUT_MS,
        `the fake LLM got ${llm.requests.length} requests, not ${count}`,
      );
    },
    /** Types into a text box of the page, after its text, as a user does. */
    async typeInBox(text, id = "box") {
      // After the text that is there, wherever the click put the caret.
      const field = await driver.findElement(By.id(id));
      await field.sendKeys(Key.chord(Key.CONTROL, Key.END));
      await field.sendKeys(text);
    },
    /** Clicks the window coordinates with the mouse (the badge is in a shadow root Selenium cannot reach). */
    async clickAt(x, y) {
      await driver.actions({ async: true }).move({ x, y, origin: "viewport" }).click().perform();
    },
    /**
     * Waits until the picture has a block of pixels of this colour and returns its centre (the
     * middle of the pixels of that colour), for a click on a control inside a shadow root.
     */
    async waitForColor(rgb) {
      let found;
      await driver.wait(
        async () => {
          const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
          let sumX = 0;
          let sumY = 0;
          let n = 0;
          for (let y = 0; y < png.height; y++) {
            for (let x = 0; x < png.width; x++) {
              if (closeTo(png.pixel(x, y), rgb, 3)) {
                sumX += x;
                sumY += y;
                n++;
              }
            }
          }
          if (n < 200) return false;
          found = { x: Math.round(sumX / n), y: Math.round(sumY / n) };
          return true;
        },
        PAGE_TIMEOUT_MS,
        `no pixels of the colour ${String(rgb)} ever showed`,
      );
      return found;
    },
    /** Fails if page mode recorded a mistake: the check of a text box is automatic, which is never counted. */
    async expectNoRecordedMistakes() {
      await ctx.open("options.html");
      const count = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         const open = indexedDB.open("english-tutor");
         open.onsuccess = () => {
           const count = open.result.transaction("error_events").objectStore("error_events").count();
           count.onsuccess = () => { open.result.close(); done(count.result); };
         };`,
      );
      if (count !== 0) throw new Error(`${count} mistakes were recorded by an automatic check`);
    },
    /**
     * Types `text` into the text box right after the first `before` in its text (the caret is put
     * there with a script, which is not typing; the keys are the user's).
     */
    async typeAt(before, text, offset = 0, id = "box") {
      await driver.executeScript(
        `const box = document.getElementById(arguments[1]);
         const at = box.value.indexOf(arguments[0]) + arguments[0].length + arguments[2];
         box.focus();
         box.setSelectionRange(at, at);`,
        before,
        id,
        offset,
      );
      await driver.findElement(By.id(id)).sendKeys(text);
    },
    /** Whether the page's overlay host (a `div` directly in `<html>`) is there. */
    async pageModeHostPresent() {
      return driver.executeScript(
        "return [...document.documentElement.children].some((c) => c.tagName === 'DIV')",
      );
    },
    async waitForPageModeHost() {
      await driver.wait(
        () => ctx.pageModeHostPresent(),
        PAGE_TIMEOUT_MS,
        "page mode never started",
      );
    },
    async waitForNoPageModeHost() {
      await driver.wait(
        async () => !(await ctx.pageModeHostPresent()),
        PAGE_TIMEOUT_MS,
        "page mode never removed its overlay",
      );
    },
    /** Waits until the background script has this many registered content scripts. Needs an extension page. */
    async waitForRegisteredScripts(count) {
      await driver.wait(
        async () =>
          (await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             browser.scripting.getRegisteredContentScripts().then((f) => done(f.length), () => done(-1));`,
          )) === count,
        PAGE_TIMEOUT_MS,
        `there were never ${count} registered content scripts`,
      );
    },
    async hasAllUrlsPermission() {
      return driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.permissions.contains({ origins: ["<all_urls>"] }).then(done);`,
      );
    },
    /**
     * Opens the context menu of the toolbar button (put on the toolbar first, as a headless
     * browser keeps it in the extensions panel) and returns the labels of its visible entries.
     * The extension's entries are asked to update in `menus.onShown`, so it waits for the entry
     * of page mode to have a label.
     */
    async openToolbarMenu() {
      await ctx.chrome(
        `const id = "english-tutor_rm4n0s_dev-browser-action";
         CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR);
         await new Promise((r) => setTimeout(r, 300));`,
      );
      await driver.setContext(firefox.Context.CHROME);
      try {
        const node = await driver.findElement(By.id("english-tutor_rm4n0s_dev-browser-action"));
        await driver.actions({ async: true }).contextClick(node).perform();
        let labels = [];
        await driver.wait(
          async () => {
            labels = await driver.executeScript(TOOLBAR_MENU_LABELS);
            return labels.some((label) => label.startsWith("Turn o"));
          },
          PAGE_TIMEOUT_MS,
          `the toolbar menu never offered page mode for the site (it shows ${JSON.stringify(labels)})`,
        );
        return labels;
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    async chooseToolbarMenuItem(label) {
      await driver.setContext(firefox.Context.CHROME);
      try {
        const chosen = await driver.executeScript(
          `const popup = document.getElementById("toolbar-context-menu");
           const item = [...popup.children].find((m) => m.localName === "menuitem" && !m.hidden && m.label === arguments[0]);
           if (item === undefined || item.disabled) return "no enabled entry " + arguments[0];
           item.doCommand();
           popup.hidePopup();
           return "ok";`,
          label,
        );
        if (chosen !== "ok") throw new Error(chosen);
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    async closeToolbarMenu() {
      await driver.setContext(firefox.Context.CHROME);
      try {
        await driver.executeScript('document.getElementById("toolbar-context-menu").hidePopup()');
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
      }
    },
    async waitForNoDialog(id) {
      await driver.wait(
        () =>
          driver.executeScript(
            "const d = document.getElementById(arguments[0]); return d === null || !d.open;",
            id,
          ),
        PAGE_TIMEOUT_MS,
        `the dialog #${id} never closed`,
      );
    },
  };
  return ctx;
}

/** Scenario names to run (all when none), and the write policy of the PNGs. */
function parseArgs(args) {
  const wanted = [];
  const policy = { updateAll: false, update: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--update-all") policy.updateAll = true;
    else if (arg === "--update") policy.update.add(args[++i] ?? "");
    else wanted.push(arg);
  }
  return { wanted, policy };
}

async function main() {
  const { wanted, policy } = parseArgs(process.argv.slice(2));
  const names = wanted.length > 0 ? wanted : Object.keys(SCENARIOS);
  const unknown = [...names, ...policy.update].filter((name) => !(name in SCENARIOS));
  if (unknown.length > 0) {
    console.error(
      `unknown scenario: ${unknown.join(", ")}. Known: ${Object.keys(SCENARIOS).join(", ")}`,
    );
    return 1;
  }

  const zipPath = await buildAndZip();
  const llm = new FakeLLMServer();
  try {
    await llm.start(FAKE_LLM_PORT);
  } catch (err) {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  // Temporary folders, outside the repository: where the browser saves downloads, and the test
  // files that the scenarios open. They are removed at the end of the run.
  const scratch = await mkdtemp(join(tmpdir(), "english-tutor-screenshots-"));
  const folders = { downloads: join(scratch, "downloads"), files: join(scratch, "files") };
  await mkdir(folders.downloads);
  await mkdir(folders.files);
  const failures = [];
  try {
    // The colour scheme is a per-profile preference, so each theme gets its own browser.
    for (const theme of ["light", "dark"]) {
      const group = names.filter((name) => SCENARIOS[name].theme === theme);
      if (group.length === 0) continue;
      let driver;
      try {
        driver = await startBrowser(theme, zipPath, folders.downloads);
      } catch (err) {
        for (const name of group) failures.push({ name, err });
        continue;
      }
      try {
        for (const name of group) {
          console.log(`scenario ${name}`);
          llm.reset();
          try {
            const ctx = makeContext(name, SCENARIOS[name], driver, llm, policy, folders);
            await resetData(ctx);
            await SCENARIOS[name].run(ctx);
          } catch (err) {
            failures.push({ name, err });
          }
        }
      } finally {
        await driver.quit();
      }
    }
  } finally {
    await llm.stop();
    await rm(scratch, { recursive: true, force: true });
  }

  for (const { name, err } of failures) {
    console.error(
      `FAILED ${name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
  if (failures.length > 0) return 1;
  console.log(`${names.length} scenario(s) passed`);
  return 0;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    console.error(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  },
);
