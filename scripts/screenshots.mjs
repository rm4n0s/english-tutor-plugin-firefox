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
      await ctx.expectText("page-mode-note", "asks on each site before it reads anything there");
      await ctx.expectText("page-mode-note", "is checked by");
      await ctx.expectText("page-mode-note", "on this computer");
      await ctx.expectHidden("page-mode-error");
      await ctx.scrollTo("page-mode");
      await ctx.expectTheme();
      // The browser fades the checkbox's focus ring out of its own accord (it is not a CSS
      // animation that could be paused), so blur it and wait until the fade is over.
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
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
      // The page's policy is `sandbox`: the frame's script cannot run, so after 5 seconds the badge
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
      // The control, a plain text box on the same page, is checked: page mode does run here.
      await ctx.focusBox("control");
      await ctx.waitForLLMRequests(1);
      await ctx.waitForBadge("grammar", "control");
      // Blur the control (its badge stays on a box with issues): its caret blinks, and a screenshot
      // would catch it on or off. The focus ring fades out of its own accord, so wait until it is
      // gone. The picture shows the five excluded fields with no badge and the control with its count.
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.waitForBadge("grammar", "control");
      for (const id of excluded) await ctx.expectNoBadge(id);
      if (ctx.llmRequests() !== 1) throw new Error("text of an excluded field was sent");
      await ctx.screenshot();
    },
  },
  "toolbar-menu-site": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // The toolbar button's menu names the site of the tab in front and follows its states (SPEC
      // section 4.11): Turn on for a site with no choice, Turn off for a site that is on, Turn on
      // again for a site that is off. The native menu cannot be photographed (a screenshot is of the
      // page only), so the entries are read from the browser, the entries are chosen, and the
      // options page's list of sites shows the result.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      const options = await ctx.driver.getWindowHandle();
      await ctx.openWebPage("textarea.html");
      const page = await ctx.driver.getWindowHandle();
      const first = await ctx.openToolbarMenu(`Turn on on ${TEST_HOST}`);
      for (const wanted of ["New tutor tab", "Preferences", `Turn on on ${TEST_HOST}`]) {
        if (!first.includes(wanted)) {
          throw new Error(`the toolbar menu has ${JSON.stringify(first)}, not ${wanted}`);
        }
      }
      await ctx.chooseToolbarMenuItem(`Turn on on ${TEST_HOST}`);
      // The open page starts at once: its overlay shows, and the text box is checked.
      await ctx.waitForPageModeHost();
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
      const checked = ctx.llmRequests();
      const second = await ctx.openToolbarMenu(`Turn off on ${TEST_HOST}`);
      if (!second.includes(`Turn off on ${TEST_HOST}`)) {
        throw new Error(`the toolbar menu has ${JSON.stringify(second)}, not Turn off`);
      }
      await ctx.chooseToolbarMenuItem(`Turn off on ${TEST_HOST}`);
      // The open page stops at once: its overlay goes, and a text box is no longer checked.
      await ctx.waitForNoPageModeHost();
      await ctx.driver.executeScript("document.activeElement.blur()");
      await ctx.focusBox();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (ctx.llmRequests() !== checked) {
        throw new Error("text was checked on a site that is turned off");
      }
      // The menu now offers the opposite.
      const later = await ctx.openToolbarMenu(`Turn on on ${TEST_HOST}`);
      if (!later.includes(`Turn on on ${TEST_HOST}`)) {
        throw new Error(`the toolbar menu has ${JSON.stringify(later)}, not Turn on`);
      }
      await ctx.closeToolbarMenu();
      // The options page lists the site, off.
      await ctx.driver.switchTo().window(options);
      await ctx.waitForText("page-mode-sites", TEST_HOST);
      await ctx.expectText("page-mode-sites", "Off");
      await ctx.scrollTo("page-mode");
      await ctx.expectTheme();
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
      // A new page load on that site is left alone too, and Remove makes it asked again.
      await ctx.driver.switchTo().window(page);
      await ctx.driver.navigate().refresh();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await ctx.waitForNoPageModeHost();
      await ctx.driver.switchTo().window(options);
      await ctx.click("page-mode-sites", ".host-remove");
      await ctx.waitForCount("#page-mode-sites li", 0);
      await ctx.driver.switchTo().window(page);
      await ctx.driver.navigate().refresh();
      await ctx.focusUntilPrompt();
      await ctx.clickPrompt("on");
      await ctx.waitForBadge("grammar");
    },
  },
  "page-mode-off": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // Turning the switch off and on again, as a user does it on the options page. The switch
      // only stores the setting and tells the open pages (step 19): the access to websites and the
      // content script of the manifest stay as they are.
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
      await ctx.waitForSetting("page_mode", false);
      if (!(await ctx.hasAllUrlsPermission()))
        throw new Error("the access to websites was removed");
      if ((await ctx.registeredScripts()) !== 0) throw new Error("a script was registered");
      // The open page removed its badge and everything else at once.
      await ctx.driver.switchTo().window(page);
      await ctx.waitForNoPageModeHost();
      await ctx.expectNoBadge();

      // A new load of the page: the script of the manifest runs, is told `off`, and does nothing.
      const checked = ctx.llmRequests();
      await ctx.driver.navigate().refresh();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await ctx.focusBox();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await ctx.waitForNoPageModeHost();
      await ctx.expectNoBadge();
      if (ctx.llmRequests() !== checked) throw new Error("text was checked with the switch off");

      // On again: the open page asks again, and works without a reload.
      await ctx.driver.switchTo().window(options);
      await ctx.click("page-mode");
      await ctx.waitForSetting("page_mode", true);
      await ctx.driver.switchTo().window(page);
      await ctx.driver.executeScript("document.activeElement.blur()");
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
  "page-made-frame": {
    theme: "light",
    dir: "step-13-page-mode",
    async run(ctx) {
      // A web page can make an iframe of page-ui.html itself (the address is the extension's own,
      // and the page may even know it), choosing the fragment and the id of its port. The frame
      // must not start: it asks the background script, which never registered that id (SPEC
      // section 4.11), so the page cannot use the user's LLM.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("textarea.html");
      const outcome = await ctx.driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         const [uuid, text] = [arguments[0], arguments[1]];
         const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
         const id = hex(8) + "-" + hex(4) + "-4" + hex(3) + "-8" + hex(3) + "-" + hex(12);
         const iframe = document.createElement("iframe");
         const seen = { loaded: false, answered: [] };
         iframe.addEventListener("load", () => {
           seen.loaded = true;
           const channel = new MessageChannel();
           channel.port1.onmessage = (event) => seen.answered.push(JSON.stringify(event.data));
           iframe.contentWindow.postMessage(
             { type: "english-tutor-page-ui", id },
             "moz-extension://" + uuid,
             [channel.port2],
           );
           channel.port1.postMessage({
             type: "focus", box: 1, source: "session:page", revision: 0, text,
           });
         });
         iframe.src = "moz-extension://" + uuid + "/page-ui.html#" + id;
         document.body.append(iframe);
         setTimeout(() => done(seen), 4000);`,
        EXTENSION_UUID,
        PAGE_MODE_TEXT,
      );
      if (!outcome.loaded)
        throw new Error("the page's own frame did not even load: nothing was tested");
      if (outcome.answered.length !== 0) {
        throw new Error(`the page's own frame answered: ${outcome.answered.join(" ")}`);
      }
      if (ctx.llmRequests() !== 0)
        throw new Error("a page used the user's LLM through its own frame");
      // The page's own frame did not disturb the real one: the text box is still checked.
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
  // Step 15: underlines in the text boxes of web pages, and the explanation popover (SPEC section
  // 4.11). The overlay lives in a closed shadow root, so the harness reads where the underlines are
  // from the pixels of the picture and compares them with the words measured in the page itself.
  "underlines-textarea": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      await checkedBox(ctx, "textarea.html");
      await ctx.expectUnderline("I seen", "grammar");
      await ctx.expectUnderline("He go", "grammar");
      await ctx.expectUnderline("make a photo", "vocabulary");
      await ctx.screenshot();
    },
  },
  "underlines-textarea-dark": {
    theme: "dark",
    dir: "step-15-page-underlines",
    async run(ctx) {
      await checkedBox(ctx, "textarea-dark.html");
      await ctx.expectTheme();
      await ctx.expectUnderline("I seen", "grammar", { dark: true });
      await ctx.expectUnderline("He go", "grammar", { dark: true });
      await ctx.expectUnderline("make a photo", "vocabulary", { dark: true });
      await ctx.screenshot();
    },
  },
  "underlines-input": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      await checkedBox(ctx, "input.html");
      await ctx.expectUnderline("I seen", "grammar");
      await ctx.expectUnderline("He go", "grammar");
      await ctx.screenshot();
    },
  },
  "underlines-contenteditable": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      await checkedBox(ctx, "contenteditable.html");
      await ctx.expectUnderline("I seen", "grammar");
      await ctx.expectUnderline("He go", "grammar");
      await ctx.expectUnderline("make a photo", "vocabulary");
      await ctx.screenshot();
    },
  },

  "popover-loading": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // The explanation is held, so the card stays in its loading state.
      const card = await openedPopover(ctx, "He go", {
        explain: { ...EXPLAIN_REPLY, delayMs: 120_000 },
      });
      await ctx.waitForLLMRequests(2);
      await ctx.expectSelectedBackground("He go", "grammar");
      await ctx.expectBoxFocused();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
      if (card.bounds.top < card.anchor.bottom)
        throw new Error("the card is not below the underline");
    },
  },
  "popover-ready": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      await openedPopover(ctx, "He go", { explain: EXPLAIN_REPLY });
      await ctx.waitForLLMRequests(2);
      await ctx.expectSelectedBackground("He go", "grammar");
      await ctx.expectBoxFocused();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await ctx.screenshot();
    },
  },
  "popover-above": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // The text box is at the bottom of the window: there is no room below the underline, so
      // the card goes above it.
      const card = await openedPopover(ctx, "I seen", {
        page: "textarea-bottom.html",
        explain: explanationFor,
      });
      if (card.bounds.side !== "above") throw new Error("the card is not above the underline");
      await ctx.waitForLLMRequests(2);
      // The card's shadow darkens the word next to it a little, so the colour is judged loosely.
      await ctx.expectSelectedBackground("I seen", "grammar", { tolerance: 40 });
      await ctx.expectBoxFocused();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await ctx.screenshot();
    },
  },
  "underlines-input-scrolled": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // No PNG. A one-line input whose text is longer than the box, scrolled to its end: the
      // underlines follow the text inside the input.
      await checkedBox(ctx, "input.html");
      await ctx.driver.executeScript(
        `const box = document.getElementById("box");
         box.focus();
         box.setSelectionRange(box.value.length, box.value.length);
         box.scrollLeft = box.scrollWidth;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const scrolled = await ctx.driver.executeScript(
        "return document.getElementById('box').scrollLeft",
      );
      if (!(scrolled > 20)) throw new Error(`the input did not scroll (${scrolled})`);
      await ctx.expectUnderline("make a photo", "vocabulary");
      await ctx.expectNoUnderlineUnder("Yesterday", "grammar");
    },
  },
  "page-underlines-scrolled": {
    theme: "light",
    dir: "step-15-page-underlines",
    // Its PNG is `underlines-scrolled.png` (the Step 6 scenario of that name keeps its own folder).
    file: "underlines-scrolled",
    async run(ctx) {
      // A long text in a box of five lines, scrolled halfway: the underlines follow the text, and
      // the box's edge cuts them off with it.
      await checkedBox(ctx, "textarea-long.html", { reply: LONG_REPLY });
      await ctx.driver.executeScript(
        `const box = document.getElementById("box");
         box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) / 2);`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      await ctx.expectUnderline("sister seen", "grammar");
      await ctx.expectUnderline("father tell", "grammar");
      // "make a photo" is below the box's edge: the overlay does not draw outside the box.
      await ctx.expectNoUnderlineUnder("make a photo", "vocabulary");
      await ctx.screenshot();
      // The overlay follows the page's own scrolling too.
      await ctx.driver.executeScript("window.scrollTo(0, 40)");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await ctx.expectUnderline("father tell", "grammar");
    },
  },
  "underlines-after-edit": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // Typing moves and removes the underlines at once, before the frame answers: the answer to
      // the next check is held, so what the picture shows is what the edits did.
      await checkedBox(ctx, "textarea-still.html");
      ctx.llm.setReplies({ ...CHECK_REPLY, delayMs: 120_000 });
      // Words at the start of the text move every issue (and wrap the first line differently).
      await ctx.typeAt("", "So, ");
      // Words inside "He go" remove that issue and only that one.
      await ctx.typeAt("He ", "so ");
      await ctx.waitForBadge("spinner");
      await ctx.expectUnderline("I seen", "grammar");
      await ctx.expectUnderline("make a photo", "vocabulary");
      await ctx.expectNoUnderlineUnder("He so go", "grammar");
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "popover-behaviour": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // No PNG. What the popover does with the keyboard and the mouse (SPEC section 4.11): the box
      // keeps the focus; Regenerate asks again; Escape in the card closes it and gives the focus
      // back; a click elsewhere closes it; the caret moving to another issue switches it, and out
      // of every issue closes it; typing closes it; Not an error removes the underline and puts
      // the pair in the ignore set under the box's source.
      const card = await openedPopover(ctx, "He go", { explain: explanationFor });
      const page = await ctx.driver.getWindowHandle();
      const options = (await ctx.driver.getAllWindowHandles()).find((h) => h !== page);
      const heGo = card.anchor;
      const [iSeen] = await ctx.wordRects("I seen");
      const [photo] = await ctx.wordRects("make a photo");
      await ctx.waitForLLMRequests(2);
      await ctx.expectBoxFocused();
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Regenerate, with the keyboard inside the card (Tab: the text, its link, Not an error,
      // Regenerate).
      let requests = ctx.llmRequests();
      await ctx.clickCardHeader(card.bounds, heGo);
      await ctx.pressKeys(Key.TAB, Key.TAB, Key.TAB, Key.TAB, Key.ENTER);
      await ctx.waitForLLMRequests(requests + 1);
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Escape in the card closes it, and the box has the focus again.
      await ctx.pressKeys(Key.ESCAPE);
      await ctx.waitForNoPopover(heGo);
      await ctx.expectBoxFocused();
      await ctx.expectNoSelectedBackground("He go", "grammar");

      // Another issue, then a click elsewhere in the page.
      await ctx.clickWord("I seen");
      await ctx.waitForPopover(iSeen);
      await ctx.expectSelectedBackground("I seen", "grammar", { tolerance: 40 });
      await ctx.clickAt(1000, 600);
      await ctx.waitForNoPopover(iSeen);

      // The caret moves with the keys: from one issue to another (the card switches), and out of
      // every issue (the card closes). The keyboard focus never left the box.
      await ctx.clickWord("I seen");
      await ctx.waitForPopover(iSeen);
      await ctx.setCaretAfter("He g");
      await ctx.pressKeys(Key.ARROW_LEFT);
      await ctx.waitForPopover(heGo);
      await ctx.waitForNoPopover(iSeen, { left: Math.min(Math.max(iSeen.left, 8), WIDTH - 368) });
      await ctx.expectBoxFocused();
      await ctx.pressKeys(Key.HOME);
      await ctx.waitForNoPopover(heGo);

      // Typing closes it, and the underline of the issue typed into goes at once.
      await ctx.clickWord("He go");
      await ctx.waitForPopover(heGo);
      requests = ctx.llmRequests();
      await ctx.pressKeys("x");
      await ctx.waitForNoPopover(heGo);
      // The pause in typing starts a new check; its result (new issues, new ids) comes before
      // anything else is done here. "Hex go" is no longer found in the text by the locator.
      await ctx.waitForLLMRequests(requests + 1);
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Not an error (Tab: the text, Not an error).
      await ctx.clickWord("make a photo");
      const bounds = await ctx.waitForPopover(photo);
      await ctx.waitForLLMRequests(ctx.llmRequests());
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.clickCardHeader(bounds, photo);
      await ctx.pressKeys(Key.TAB, Key.TAB, Key.ENTER);
      await ctx.waitForNoPopover(photo);
      await ctx.expectNoUnderlineUnder("make a photo", "vocabulary");
      await ctx.driver.switchTo().window(options);
      const ignored = await ctx.sessionKeys("ignore:session:");
      if (ignored.length !== 1) throw new Error(`the ignore set holds ${JSON.stringify(ignored)}`);
      await ctx.expectNoRecordedMistakes();
    },
  },
  "popover-editable": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // No PNG. The popover of an issue in editable content: the click point is found from the
      // rectangles of the Range, the card is next to the line, and typing closes it.
      const card = await openedPopover(ctx, "He go", {
        page: "contenteditable.html",
        explain: explanationFor,
      });
      await ctx.waitForLLMRequests(2);
      await ctx.expectBoxFocused();
      await ctx.expectSelectedBackground("He go", "grammar");
      await ctx.pressKeys("x");
      await ctx.waitForNoPopover(card.anchor);
    },
  },
  "popover-input": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // No PNG. The popover of an issue in a one-line input.
      const card = await openedPopover(ctx, "I seen", {
        page: "input.html",
        explain: explanationFor,
      });
      await ctx.waitForLLMRequests(2);
      await ctx.expectBoxFocused();
      await ctx.pressKeys(Key.ESCAPE);
      await ctx.waitForNoPopover(card.anchor);
    },
  },
  "popover-link": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // No PNG. A link in the explanation never navigates anything: it asks first (inside the card),
      // and opens in a new tab only after Open link.
      const card = await openedPopover(ctx, "He go", { explain: EXPLAIN_REPLY });
      await ctx.waitForLLMRequests(2);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const tabs = (await ctx.driver.getAllWindowHandles()).length;
      await ctx.clickCardHeader(card.bounds, card.anchor);
      // Tab: the text, then the link in it, which is scrolled into view.
      await ctx.pressKeys(Key.TAB, Key.TAB, Key.ENTER);
      await new Promise((resolve) => setTimeout(resolve, 600));
      if ((await ctx.driver.getAllWindowHandles()).length !== tabs) {
        throw new Error("the link opened before it was confirmed");
      }
      // The card grew to hold the confirmation; Open link has the focus.
      await ctx.pressKeys(Key.ENTER);
      await ctx.driver.wait(
        async () => (await ctx.driver.getAllWindowHandles()).length === tabs + 1,
        PAGE_TIMEOUT_MS,
        "the confirmed link never opened in a new tab",
      );
    },
  },
  "underlines-sites-not-on": {
    theme: "light",
    dir: "step-15-page-underlines",
    async run(ctx) {
      // No PNG. A site that is not on never gets underlines or a frame, whatever the user types:
      // not a site that is off, and not a site that has not been asked yet.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: { [TEST_HOST]: "off" } });
      const options = await ctx.driver.getWindowHandle();
      await ctx.watchFrameRegistrations();

      await ctx.openWebPage("textarea.html");
      const page = await ctx.driver.getWindowHandle();
      await ctx.focusBox();
      await ctx.typeInBox(" and some more words to write");
      await ctx.clickWord("I seen");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await ctx.expectNoUnderlines();
      if (await ctx.pageModeHostPresent()) throw new Error("an off site has a page-mode element");
      if (ctx.llmRequests() !== 0) throw new Error("text was sent from an off site");

      // A site with no choice yet: the card asks, and until Turn on there is no frame, no check
      // and no underline.
      await ctx.driver.switchTo().window(options);
      await ctx.seedSites({});
      await ctx.driver.switchTo().window(page);
      await ctx.driver.navigate().refresh();
      await ctx.driver.executeScript("document.activeElement.blur()");
      await ctx.focusUntilPrompt();
      await ctx.typeInBox(" and some more words to write");
      await ctx.clickWord("I seen");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await ctx.expectNoUnderlines();
      if (ctx.llmRequests() !== 0) throw new Error("text was sent before Turn on");
      await ctx.driver.switchTo().window(options);
      if ((await ctx.frameRegistrations()) !== 0)
        throw new Error("a frame was made before Turn on");
    },
  },
  // Step 14: page mode asks on each site (SPEC section 4.11). The prompt card lives in a closed
  // shadow root, so the harness finds its buttons from the pixels of the picture.
  welcome: {
    theme: "light",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      await expectInstallWelcome(ctx);
      await ctx.open("options.html#welcome");
      await ctx.waitForVisible("welcome");
      // The fragment goes at once, so that a reload does not show the block again.
      await ctx.expectCleanAddress();
      await ctx.expectText("welcome", "Welcome to English Tutor");
      await ctx.expectText("welcome-page-mode", "click the grey English Tutor icon in a text box");
      await ctx.expectText("welcome-page-mode", "reads nothing on a site until you do");
      // Nothing to allow: Firefox granted the access at the installation.
      await ctx.expectNoElement("welcome-allow");
      await ctx.expectNoElement("welcome-later");
      await ctx.expectTheme();
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "welcome-dark": {
    theme: "dark",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      await expectInstallWelcome(ctx);
      await ctx.open("options.html#welcome");
      await ctx.waitForVisible("welcome");
      await ctx.expectCleanAddress();
      await ctx.expectTheme();
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "welcome-actions": {
    theme: "light",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      // No PNG: what the Welcome block does. A reload does not show the block again.
      await ctx.open("options.html#welcome");
      await ctx.waitForVisible("welcome");
      await ctx.driver.navigate().refresh();
      await waitForPage(ctx.driver, "options.html");
      await ctx.waitForVisible("llm-add");
      if ((await ctx.driver.findElements(By.id("welcome"))).length !== 0) {
        throw new Error("the Welcome block came back after a reload");
      }
      // Add an LLM opens the Add form of the LLMs section, and the block stays.
      await ctx.open("options.html#welcome");
      await ctx.waitForVisible("welcome");
      await ctx.click("welcome-add-llm");
      await ctx.waitForVisible("llm-form");
      await ctx.waitForVisible("welcome");
      // The only button is Add an LLM; opening the page changed nothing (step 19).
      const buttons = await ctx.driver.executeScript(
        "return [...document.querySelectorAll('#welcome button')].map((b) => b.textContent)",
      );
      if (canonicalJson(buttons) !== canonicalJson(["Add an LLM"])) {
        throw new Error(`the Welcome block has the buttons ${JSON.stringify(buttons)}`);
      }
      await ctx.expectChecked("page-mode");
      await ctx.expectHidden("page-mode-access");
      if ((await ctx.registeredScripts()) !== 0) throw new Error("a script was registered");
    },
  },
  "site-prompt": {
    theme: "light",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      // A site with no choice: the focus of a text box shows the dimmed badge, and a click on it
      // opens the card under the box (step 18: icon first). The LLM is on another computer, so the
      // note names its server.
      await ctx.configureFakeLLM({
        name: "Remote LLM",
        baseUrl: "https://llm.example.com/v1",
      });
      await ctx.turnOnPageMode({ sites: {} });
      await ctx.expectSiteConfig(TEST_HOST, {
        state: "ask",
        llm: { server: "llm.example.com", local: false },
      });
      const options = await ctx.driver.getWindowHandle();
      await ctx.watchFrameRegistrations();
      // The page whose caret does not blink: the box keeps the focus while the card is open (the
      // badge and the card go when it loses it).
      await ctx.openWebPage("textarea-still.html");
      await ctx.focusUntilPrompt();
      // The card did not take the focus from the text box, and nothing was sent.
      await ctx.expectFocus("box");
      if (ctx.llmRequests() !== 0) throw new Error("a request was sent before Turn on");
      // The box's focus ring fades out of its own accord: wait for it.
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!(await ctx.promptShowing())) throw new Error("the card went away by itself");
      await ctx.screenshot();
      await ctx.driver.switchTo().window(options);
      if ((await ctx.frameRegistrations()) !== 0)
        throw new Error("a frame was made before Turn on");
    },
  },
  "site-prompt-local": {
    theme: "light",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      // The LLM is a server on this computer: the note says the text is checked there.
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      await ctx.expectSiteConfig(TEST_HOST, {
        state: "ask",
        llm: { server: new URL(ctx.llm.baseUrl).host, local: true },
      });
      await ctx.openWebPage("textarea-still.html");
      await ctx.focusUntilPrompt();
      await ctx.expectFocus("box");
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!(await ctx.promptShowing())) throw new Error("the card went away by itself");
      await ctx.screenshot();
    },
  },
  "site-prompt-no-llm": {
    theme: "light",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      // No LLM is set up yet: the card says so and points to the options.
      await ctx.open("options.html");
      await ctx.turnOnPageMode({ sites: {} });
      await ctx.expectSiteConfig(TEST_HOST, { state: "ask", llm: null });
      await ctx.openWebPage("textarea-still.html");
      await ctx.focusUntilPrompt();
      await ctx.expectFocus("box");
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!(await ctx.promptShowing())) throw new Error("the card went away by itself");
      await ctx.screenshot();
    },
  },
  "site-turned-on": {
    theme: "light",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      // Turn on: the card goes, the text box the user is in is checked at once (without a second
      // click) and keeps its focus, and the badge shows the count.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      await ctx.openWebPage("textarea.html");
      await ctx.focusUntilPrompt();
      if (ctx.llmRequests() !== 0) throw new Error("a request was sent before Turn on");
      await ctx.clickPrompt("on");
      await ctx.waitForBadge("grammar");
      await ctx.expectFocus("box");
      await ctx.waitForLLMRequests(1);
      if (await ctx.promptShowing()) throw new Error("the card stayed after Turn on");
      await ctx.stabilise({ keepFocus: true });
      await ctx.screenshot();
      // The choice is kept: the site is on after a reload, with no card.
      await ctx.driver.navigate().refresh();
      await ctx.waitForPageModeHost();
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
      if (await ctx.promptShowing()) throw new Error("the card came back on a site that is on");
    },
  },
  "options-sites": {
    theme: "light",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      // A site is the exact host name: the same server under another name is asked on its own.
      // The options page lists both, with their state and Remove.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      const options = await ctx.driver.getWindowHandle();
      await ctx.openWebPage("textarea.html");
      await ctx.focusUntilPrompt();
      await ctx.clickPrompt("on");
      await ctx.waitForBadge("grammar");
      await ctx.openWebPage("textarea.html", { host: OTHER_HOST });
      await ctx.focusUntilPrompt();
      await ctx.clickPrompt("off");
      await ctx.driver.switchTo().window(options);
      await ctx.waitForText("page-mode-sites", OTHER_HOST);
      await ctx.waitForCount("#page-mode-sites li", 2);
      const rows = await ctx.driver.executeScript(
        `return [...document.querySelectorAll("#page-mode-sites li")].map((li) => li.innerText.replace(/\\s+/g, " ").trim())`,
      );
      if (
        JSON.stringify(rows) !==
        JSON.stringify([`${TEST_HOST} On Remove`, `${OTHER_HOST} Off Remove`])
      ) {
        throw new Error(`the list of sites is ${JSON.stringify(rows)}`);
      }
      await ctx.scrollTo("page-mode");
      await ctx.expectTheme();
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "sites-not-asked": {
    theme: "light",
    dir: "step-14-page-mode-sites",
    async run(ctx) {
      // No PNG. On a site that is off, the content script shows no badge and no card, makes no
      // frame, reads no text and sends nothing. A site answered Not now (version 0.2.0's `later`,
      // which the card no longer offers) behaves like a site with no choice: the dimmed badge.
      // An excluded field never gets a badge.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: { [TEST_HOST]: "off" } });
      // The options page shows the seeded site after it is loaded again.
      await ctx.driver.navigate().refresh();
      await waitForPage(ctx.driver, "options.html");
      await ctx.waitForText("page-mode-sites", TEST_HOST);
      const options = await ctx.driver.getWindowHandle();
      await ctx.watchFrameRegistrations();

      // Never on this site (off): nothing shows, even when the user types.
      await ctx.openWebPage("textarea.html");
      const page = await ctx.driver.getWindowHandle();
      await ctx.expectNoPrompt();
      await ctx.typeInBox(" and some more words");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (await ctx.pageModeHostPresent()) throw new Error("an off site has a page-mode element");
      if (ctx.llmRequests() !== 0) throw new Error("text was sent from an off site");

      // Remove on the options page: the site is asked again (the open page hears it), and the
      // focus now shows the dimmed badge.
      await ctx.driver.switchTo().window(options);
      await ctx.click("page-mode-sites", ".host-remove");
      await ctx.waitForCount("#page-mode-sites li", 0);
      await ctx.driver.switchTo().window(page);
      await ctx.driver.executeScript("document.activeElement.blur()");
      await ctx.focusUntilPrompt();

      // Escape closes the card without a choice: the badge stays, and nothing was stored.
      await ctx.driver.findElement(By.id("box")).sendKeys(Key.ESCAPE);
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await ctx.promptShowing()) throw new Error("Escape did not close the card");
      if (!(await ctx.badgeShows("dimmed"))) throw new Error("Escape took the badge away");
      await ctx.driver.switchTo().window(options);
      if ((await ctx.sessionKeys("page-mode-later:")).length !== 0) {
        throw new Error("closing the card stored Not now");
      }
      if (
        (await ctx.driver.executeScript(
          "return document.getElementById('page-mode-sites').hidden",
        )) !== true
      ) {
        throw new Error("closing the card was stored as a choice");
      }

      // A site answered Not now by version 0.2.0 (`storage.session` holds its key) is still
      // understood, and shows the dimmed badge like a site with no choice.
      await ctx.driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.storage.session.set({ ["page-mode-later:" + arguments[0]]: true })
           .then(() => browser.tabs.query({}))
           .then((tabs) => Promise.all(tabs.map((t) =>
             browser.tabs.sendMessage(t.id, { type: "settings-changed" }).catch(() => undefined))))
           .then(() => done());`,
        TEST_HOST,
      );
      await ctx.expectSiteConfig(TEST_HOST, {
        state: "later",
        llm: { server: new URL(ctx.llm.baseUrl).host, local: true },
      });
      await ctx.driver.switchTo().window(page);
      await ctx.driver.executeScript("document.activeElement.blur()");
      await ctx.focusUntilBadge();
      await ctx.driver.navigate().refresh();
      await ctx.focusUntilBadge();
      if (ctx.llmRequests() !== 0) throw new Error("text was sent from a later site");

      // An excluded field never gets the badge, on a page that is asked about; the plain text box
      // does.
      await ctx.driver.switchTo().window(options);
      await ctx.clearLater();
      await ctx.openWebPage("excluded.html");
      const excluded = ["password", "email", "nospell", "card", "optout"];
      for (const id of excluded) await ctx.expectNoPrompt(id, id === excluded[0] ? 2500 : 800);
      await ctx.focusUntilBadge("control");
      if (ctx.llmRequests() !== 0) throw new Error("text was sent before Turn on");
      await ctx.driver.switchTo().window(options);
      if ((await ctx.frameRegistrations()) !== 0)
        throw new Error("a frame was made without Turn on");
    },
  },
  // Step 16: the issues dialog of page mode (SPEC section 4.11). It lives in the extension's frame
  // inside the page, so the harness finds it, its rows and its buttons from the pixels of the
  // picture, and reads the box itself with scripts.
  "dialog-issues": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // The badge opens the dialog: the issues of the automatic check on top, the idle explanation
      // panel below, and the buttons. Nothing is selected, and nothing was recorded.
      const { bounds, options, tab } = await openedDialog(ctx);
      const rows = await ctx.dialogRows(bounds);
      if (rows.length !== 3) throw new Error(`the dialog lists ${rows.length} issues, not 3`);
      await ctx.dialogButtons(bounds);
      await ctx.expectNoSelectedBackground("He go", "grammar");
      await ctx.expectBoxFocused();
      if ((await recordedIn(ctx, options, tab)).length !== 0) {
        throw new Error("opening the dialog recorded mistakes");
      }
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "dialog-explanation": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // A click on a row selects the issue: it is highlighted in the box (the selected background)
      // and its explanation streams into the panel. The caret of the box does not move.
      const { bounds } = await openedDialog(ctx, { explain: explanationFor });
      const caret = await boxSelection(ctx);
      await ctx.clickDialogRow(bounds, 1);
      await ctx.waitForLLMRequests(2);
      await ctx.expectSelectedBackground("He go", "grammar", { tolerance: 40 });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const after = await boxSelection(ctx);
      if (after.start !== caret.start || after.end !== caret.end) {
        throw new Error(
          `the caret moved from ${JSON.stringify(caret)} to ${JSON.stringify(after)}`,
        );
      }
      await ctx.waitForPageDialog();
      await ctx.screenshot();
    },
  },
  "dialog-dark": {
    theme: "dark",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // The dialog in the dark theme, over a dark page.
      const { bounds } = await openedDialog(ctx, {
        page: "textarea-dark.html",
        explain: explanationFor,
        dark: true,
      });
      await ctx.expectTheme();
      await ctx.clickDialogRow(bounds, 1, { dark: true });
      await ctx.waitForLLMRequests(2);
      await ctx.expectSelectedBackground("He go", "grammar", { dark: true, tolerance: 40 });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await ctx.waitForPageDialog({ dark: true });
      await ctx.screenshot();
    },
  },
  "dialog-checking": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // Check in the dialog: the answer is held, so the footer says Checking... and the button is
      // Cancel. The old rows stay until the result arrives. Cancel then ends it.
      const { bounds } = await openedDialog(ctx);
      ctx.llm.setReplies({ ...CHECK_REPLY, delayMs: 120_000 });
      const requests = ctx.llmRequests();
      await ctx.clickDialogButton(bounds, 0);
      await ctx.waitForLLMRequests(requests + 1);
      // The picture shows the busy state: Cancel is the button now (still the accent colour).
      await ctx.waitForBadge("spinner");
      if ((await ctx.dialogRows(bounds)).length !== 3) throw new Error("the old rows went");
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
      // Cancel: the old issues stay, nothing is recorded, and the badge has its count again.
      await ctx.clickDialogButton(bounds, 0);
      await ctx.waitForBadge("grammar");
      if ((await ctx.dialogRows(bounds)).length !== 3) throw new Error("Cancel removed the rows");
    },
  },
  "dialog-no-llm": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // No LLM is configured: the badge shows `!`, and the dialog says so, with a link that opens
      // the options page (the frame cannot do that itself: the background script does).
      await ctx.open("options.html");
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("textarea-still.html");
      await ctx.focusBox();
      await ctx.waitForBadge("warning");
      const { x, y } = await ctx.badgeCenter();
      await ctx.clickAt(x, y);
      const bounds = await ctx.waitForPageDialog();
      if (ctx.llmRequests() !== 0) throw new Error("a request was sent without an LLM");
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
      // The link in the panel opens the options page (the background script does it).
      const link = await ctx.colorCenterIn(
        {
          left: bounds.left + 1,
          top: bounds.top + 200,
          right: bounds.left + bounds.width - 1,
          bottom: bounds.top + 260,
        },
        LINK_COLOR.light,
      );
      const tabs = (await ctx.driver.getAllWindowHandles()).length;
      await ctx.clickAt(link.x, link.y);
      // The options page is already open in a tab: Firefox brings that tab to the front.
      await ctx.expectSelectedUrl("options.html");
      await ctx.expectTabCount(tabs);
    },
  },
  "dialog-open-in-tutor": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // Open in English Tutor: a new tutor tab, right after the page's tab, holds the text of the
      // box and checks it (the hand-off of SPEC section 4.1). Nothing is written back to the page.
      const { bounds, tab } = await openedDialog(ctx);
      const before = await ctx.driver.getAllWindowHandles();
      await ctx.clickDialogButton(bounds, 1);
      await ctx.switchToNewTab(before);
      await waitForPage(ctx.driver, "tutor.html");
      await ctx.waitForEditorValue(PAGE_MODE_TEXT);
      await ctx.waitForText("llm-select", "Fake LLM");
      await ctx.waitForText("status-state", "3 issues · 2 issues could not be placed");
      await ctx.expectHandoffEntries(0);
      await ctx.expectTheme();
      await ctx.stabilise();
      await ctx.screenshot();
      // The page's text box has the text it had, and the dialog is still there.
      await ctx.driver.switchTo().window(tab);
      const value = await ctx.driver.executeScript("return document.getElementById('box').value");
      if (value !== PAGE_MODE_TEXT) throw new Error("the text of the page's box changed");
      await ctx.waitForPageDialog();
    },
  },
  "dialog-check-recorded": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // No PNG. The dialog's Check is a manual check: its issues are recorded under the box's
      // `session:` source, with the LLM's name. The automatic checks before it recorded nothing,
      // and neither does the next one, and checking the same text again counts nothing twice.
      const { bounds, options, tab } = await openedDialog(ctx);
      if ((await recordedIn(ctx, options, tab)).length !== 0) {
        throw new Error("an automatic check recorded mistakes");
      }
      const requests = ctx.llmRequests();
      await ctx.clickDialogButton(bounds, 0);
      await ctx.waitForLLMRequests(requests + 1);
      await ctx.waitForBadge("grammar");
      const first = await waitForRecorded(ctx, options, tab, 3);
      const sources = new Set(first.map((m) => m.source));
      if (sources.size !== 1 || ![...sources][0].startsWith("session:")) {
        throw new Error(`the mistakes are recorded under ${[...sources]}`);
      }
      if (first.some((m) => m.llm !== "Fake LLM")) throw new Error("the LLM's name is missing");
      if (
        first
          .map((m) => m.type)
          .sort()
          .join() !== "collocation,subject_verb_agreement,verb_form"
      ) {
        throw new Error(`the types are ${first.map((m) => m.type)}`);
      }
      // The rows now have their counts ("x1"): the badge of a manual check's issue.
      await ctx.stabilise({ keepFocus: true });
      // The same text again: nothing is counted twice.
      await ctx.clickDialogButton(bounds, 0);
      await ctx.waitForLLMRequests(requests + 2);
      await ctx.waitForBadge("grammar");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if ((await recordedIn(ctx, options, tab)).length !== 3) throw new Error("counted twice");
      // An automatic check (the pause in typing) records nothing either.
      await ctx.typeInBox(" And more words here.");
      await ctx.waitForLLMRequests(requests + 3);
      await ctx.waitForBadge("grammar");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if ((await recordedIn(ctx, options, tab)).length !== 3) {
        throw new Error("an automatic check recorded mistakes");
      }
    },
  },
  "dialog-not-an-error": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // No PNG. Not an error in the dialog (SPEC section 5.7): after the dialog's Check recorded the
      // three mistakes, marking "make a photo" deletes its event and puts the pair in the ignore set
      // under the box's source; its row and its underline go at once, and checking the same text
      // again does not record it a second time.
      const { bounds, options, tab } = await openedDialog(ctx, { explain: explanationFor });
      const requests = ctx.llmRequests();
      await ctx.clickDialogButton(bounds, 0);
      await ctx.waitForLLMRequests(requests + 1);
      await waitForRecorded(ctx, options, tab, 3);
      await ctx.waitForBadge("grammar");
      await ctx.clickDialogRow(bounds, 2);
      await ctx.waitForLLMRequests(requests + 2);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // Tab from the list: the explanation's text, then Not an error.
      await ctx.pressKeys(Key.TAB, Key.TAB, Key.ENTER);
      await ctx.driver.wait(
        async () => (await ctx.dialogRows(bounds)).length === 2,
        PAGE_TIMEOUT_MS,
        "the row of the issue never went",
      );
      await ctx.expectNoUnderlineUnder("make a photo", "vocabulary");
      await waitForRecorded(ctx, options, tab, 2);
      await ctx.driver.switchTo().window(options);
      const ignored = await ctx.sessionKeys("ignore:session:");
      await ctx.driver.switchTo().window(tab);
      if (ignored.length !== 1) throw new Error(`the ignore set holds ${JSON.stringify(ignored)}`);
      // The same text again: the ignored mistake is not recorded, the other two are not counted twice.
      await ctx.clickDialogButton(bounds, 0);
      await ctx.waitForLLMRequests(requests + 3);
      await ctx.waitForBadge("grammar");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const recorded = await recordedIn(ctx, options, tab);
      if (recorded.length !== 2 || recorded.some((m) => m.type === "collocation")) {
        throw new Error(`the recorded mistakes are ${JSON.stringify(recorded)}`);
      }
    },
  },
  "dialog-close": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // No PNG. Close, Escape (with the focus in the box and in the dialog), and the badge close
      // it, and the box keeps or gets back its focus.
      const { bounds } = await openedDialog(ctx);
      // The Close button.
      await ctx.clickDialogButton(bounds, 2);
      await ctx.waitForNoPageDialog();
      await ctx.expectBoxFocused();
      // The badge opens it again, and closes it again.
      const badge = await ctx.badgeCenter();
      await ctx.clickAt(badge.x, badge.y);
      await ctx.waitForPageDialog();
      await ctx.clickAt(badge.x, badge.y);
      await ctx.waitForNoPageDialog();
      // Escape while the focus is in the box.
      await ctx.clickAt(badge.x, badge.y);
      await ctx.waitForPageDialog();
      await ctx.expectBoxFocused();
      await ctx.pressKeys(Key.ESCAPE);
      await ctx.waitForNoPageDialog();
      await ctx.expectBoxFocused();
      // Escape while the focus is in the dialog (a row was clicked): the box gets the focus back.
      await ctx.clickAt(badge.x, badge.y);
      await ctx.waitForPageDialog();
      await ctx.clickDialogRow(bounds, 0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await ctx.pressKeys(Key.ESCAPE);
      await ctx.waitForNoPageDialog();
      await ctx.expectBoxFocused();
      await ctx.expectNoSelectedBackground("I seen", "grammar");
    },
  },
  "dialog-row-scrolls": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // No PNG. A box of five lines with twelve lines of text: selecting the row of an issue that
      // is below the box's edge scrolls the box to it, selecting one above scrolls back, and the
      // caret and the selection of the box stay where they were.
      const { bounds } = await openedDialog(ctx, {
        page: "textarea-long.html",
        reply: LONG_REPLY,
        explain: explanationFor,
      });
      await ctx.driver.executeScript(
        `const box = document.getElementById("box");
         box.setSelectionRange(5, 9);
         box.scrollTop = 0;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const caret = await boxSelection(ctx);
      if ((await boxScrollTop(ctx)) !== 0) throw new Error("the box did not start at its top");
      // "make a photo" is the third row, below the box's edge.
      await ctx.expectNoUnderlineUnder("make a photo", "vocabulary");
      await ctx.clickDialogRow(bounds, 2);
      await ctx.driver.wait(
        async () => (await boxScrollTop(ctx)) > 20,
        PAGE_TIMEOUT_MS,
        "the box never scrolled",
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      // The dashed underline can end a few pixels short of the word (the last dash), so what is
      // checked is the selected background, which is drawn behind the whole word.
      await ctx.expectSelectedBackground("make a photo", "vocabulary", { tolerance: 40 });
      await expectWordInBox(ctx, "make a photo");
      // The first row: back to the top.
      const scrolled = await boxScrollTop(ctx);
      await ctx.clickDialogRow(bounds, 0);
      await ctx.driver.wait(
        async () => (await boxScrollTop(ctx)) < scrolled,
        PAGE_TIMEOUT_MS,
        "the box never scrolled back",
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expectWordInBox(ctx, "sister seen");
      const after = await boxSelection(ctx);
      if (after.start !== caret.start || after.end !== caret.end) {
        throw new Error(
          `the selection moved from ${JSON.stringify(caret)} to ${JSON.stringify(after)}`,
        );
      }
    },
  },
  "dialog-all-issues": {
    theme: "light",
    dir: "step-16-page-dialog",
    async run(ctx) {
      // No PNG. All issues in the popover closes the card and opens the dialog with the same issue
      // selected; and a click in an underline closes the dialog and opens the card (only one of the
      // two is open at a time).
      ctx.llm.setReplies((request) =>
        isExplainRequest(request) ? explanationFor(request) : CHECK_REPLY,
      );
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("textarea-still.html");
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
      const [heGo] = await ctx.wordRects("He go");
      const [iSeen] = await ctx.wordRects("I seen");
      await ctx.clickWord("He go");
      const card = await ctx.waitForPopover(heGo);
      await ctx.waitForLLMRequests(2);
      await new Promise((resolve) => setTimeout(resolve, 800));
      // The card's keyboard order: the text, its link, Not an error, Regenerate, All issues.
      await ctx.clickCardHeader(card, heGo);
      await ctx.pressKeys(Key.TAB, Key.TAB, Key.TAB, Key.TAB, Key.TAB, Key.ENTER);
      const bounds = await ctx.waitForPageDialog();
      await ctx.waitForNoPopover(heGo);
      // The issue of the card is selected in the dialog and in the box.
      await ctx.expectSelectedBackground("He go", "grammar", { tolerance: 40 });
      const rows = await ctx.dialogRows(bounds);
      if (rows.length !== 3) throw new Error(`the dialog lists ${rows.length} issues`);
      // A click in another underline: the card opens, the dialog closes.
      await ctx.clickWord("I seen");
      await ctx.waitForPopover(iSeen);
      await ctx.waitForNoPageDialog();
    },
  },

  // Step 18: page mode, icon first, and editors as real sites build them (SPEC section 4.11).
  // The badge, the card and the underlines are in a closed shadow root, so the harness finds them
  // from the pixels of the picture, as in the earlier steps.
  "badge-dimmed": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // A site with no choice: the focused text box has the dimmed badge at its bottom right
      // corner. No card opens by itself, nothing is read, and nothing is sent.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      const options = await ctx.driver.getWindowHandle();
      await ctx.watchFrameRegistrations();
      await ctx.openWebPage("textarea-still.html");
      await ctx.focusUntilBadge();
      await ctx.expectFocus("box");
      // It stays dimmed, and nothing else shows by itself.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (await ctx.promptShowing()) throw new Error("a card opened by itself");
      if (!(await ctx.badgeShows("dimmed"))) throw new Error("the dimmed badge went away");
      if (ctx.llmRequests() !== 0) throw new Error("a request was sent before Turn on");
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
      await ctx.driver.switchTo().window(options);
      if ((await ctx.frameRegistrations()) !== 0)
        throw new Error("a frame was made before Turn on");
    },
  },
  "badge-dimmed-card": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // A click on the dimmed badge opens the card under the box (the LLM is on this computer).
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      await ctx.openWebPage("textarea-still.html");
      await ctx.focusUntilPrompt();
      await ctx.expectFocus("box");
      if (ctx.llmRequests() !== 0) throw new Error("a request was sent before Turn on");
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!(await ctx.promptShowing())) throw new Error("the card went away by itself");
      await ctx.screenshot();
    },
  },
  "off-no-badge": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // No PNG. A site that is off (Never on this site) has no badge, no card, no element in the
      // page, no frame and no request, on a text box and on editable content.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: { [TEST_HOST]: "off" } });
      const options = await ctx.driver.getWindowHandle();
      await ctx.watchFrameRegistrations();
      for (const name of ["textarea.html", "contenteditable.html"]) {
        await ctx.openWebPage(name);
        await ctx.expectNoPrompt("box", 2500);
        await ctx.typeInBox(" and some more words to write");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await ctx.expectNoBadge("box");
        if (await ctx.pageModeHostPresent()) throw new Error(`${name} has a page-mode element`);
      }
      if (ctx.llmRequests() !== 0) throw new Error("text was sent from an off site");
      await ctx.driver.switchTo().window(options);
      if ((await ctx.frameRegistrations()) !== 0)
        throw new Error("a frame was made on an off site");
    },
  },
  "ask-sends-nothing": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // No PNG. On a site with no choice the dimmed badge, the card and typing send nothing: no
      // frame is made, no request goes out, nothing is underlined. Never on this site then takes
      // the badge away.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      const options = await ctx.driver.getWindowHandle();
      await ctx.watchFrameRegistrations();
      await ctx.openWebPage("textarea.html");
      await ctx.focusUntilPrompt();
      await ctx.typeInBox(" and some more words to write");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await ctx.expectNoUnderlines();
      if (ctx.llmRequests() !== 0) throw new Error("text was sent before Turn on");
      // The card is still open (leaving the tab would blur the box, and the card goes with it).
      // Never on this site: the badge and the card go, and nothing of page mode is left.
      await ctx.clickPrompt("off");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await ctx.promptShowing()) throw new Error("the card stayed after Never");
      if (await ctx.badgeShows("dimmed")) throw new Error("the badge stayed after Never");
      if (await ctx.pageModeHostPresent()) throw new Error("Never left a page-mode element");
      await ctx.driver.switchTo().window(options);
      if ((await ctx.frameRegistrations()) !== 0)
        throw new Error("a frame was made before Turn on");
      await ctx.expectSiteConfig(TEST_HOST, { state: "off" });
      if (ctx.llmRequests() !== 0) throw new Error("text was sent");
    },
  },
  // Step 19: page mode works like LanguageTool (SPEC sections 3.2 and 4.11). The manifest declares
  // the content script and `<all_urls>`, which Firefox grants at the installation.
  "install-welcome": {
    theme: "light",
    dir: "step-19-like-languagetool",
    async run(ctx) {
      // The page that installing the add-on opens: what English Tutor does, Add an LLM, and how
      // page mode works. There is nothing to allow: the access came with the installation.
      await expectInstallWelcome(ctx);
      await ctx.open("options.html#welcome");
      await ctx.waitForVisible("welcome");
      await ctx.expectCleanAddress();
      await ctx.expectText("welcome-page-mode", "click the grey English Tutor icon in a text box");
      await ctx.expectNoElement("welcome-allow");
      if (!(await ctx.hasAllUrlsPermission())) {
        throw new Error("the installation did not grant access to all websites");
      }
      if ((await ctx.registeredScripts()) !== 0) throw new Error("a script was registered");
      await ctx.expectTheme();
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "options-page-mode-switch": {
    theme: "light",
    dir: "step-19-like-languagetool",
    file: "options-page-mode",
    async run(ctx) {
      // The global switch, on by default, with its new label and no notice about access.
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.expectChecked("page-mode");
      await ctx.expectText(
        "page-mode-sites-empty",
        "a grey icon appears on a text box you click into",
      );
      await ctx.expectText("page-mode-note", "asks on each site before it reads anything there");
      const label = await ctx.driver.executeScript(
        "return document.getElementById('page-mode').closest('label').textContent.trim()",
      );
      if (label !== "Show the English Tutor icon in text boxes on websites") {
        throw new Error(`the switch is labelled "${label}"`);
      }
      await ctx.expectHidden("page-mode-access");
      await ctx.expectHidden("page-mode-error");
      await ctx.scrollTo("page-mode");
      await ctx.expectTheme();
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "options-permission-withdrawn": {
    theme: "light",
    dir: "step-19-like-languagetool",
    async run(ctx) {
      // The user took the access to all websites away: the options page says so at once (no
      // reload) and offers a button that asks for it again. The switch stays as it was.
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.expectHidden("page-mode-access");
      await ctx.withdrawAccess();
      await ctx.waitForVisible("page-mode-access");
      await ctx.expectText("page-mode-access", "does not have access to all websites any more");
      await ctx.expectText("page-mode-access-button", "Allow access to all websites");
      await ctx.expectChecked("page-mode");
      await ctx.scrollTo("page-mode");
      await ctx.expectTheme();
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "access-withdrawn": {
    theme: "light",
    dir: "step-19-like-languagetool",
    async run(ctx) {
      // No PNG. With the access to websites withdrawn nothing runs: a page that is open stops at
      // once (the background script answers `off` for a site it cannot reach), a new page gets
      // no script, and no text is sent. The options page says so. Giving access to one site only
      // starts the script there and nowhere else, and the button of the options page gives all of
      // it back: the page that was loaded meanwhile starts without a reload.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: { [TEST_HOST]: "on", [OTHER_HOST]: "on" } });
      const options = await ctx.driver.getWindowHandle();
      await ctx.openPageModePage("textarea.html");
      const open = await ctx.driver.getWindowHandle();
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");

      await ctx.driver.switchTo().window(options);
      await ctx.withdrawAccess();
      await ctx.waitForVisible("page-mode-access");
      // The page that was open stops: no overlay, no badge, no more checks.
      await ctx.driver.switchTo().window(open);
      await ctx.waitForNoPageModeHost();
      await ctx.expectNoBadge();
      const checked = ctx.llmRequests();

      // A new page gets no content script, whatever the site's choice is.
      const none = async (host) => {
        await ctx.openWebPage("textarea.html", { host });
        await ctx.focusBox();
        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (await ctx.pageModeHostPresent()) throw new Error(`page mode ran on ${host}`);
        await ctx.expectNoBadge();
        if (ctx.llmRequests() !== checked) throw new Error(`text was checked on ${host}`);
        return ctx.driver.getWindowHandle();
      };
      await none(TEST_HOST);
      await ctx.driver.switchTo().window(options);
      await ctx.seedSites({});
      await none(TEST_HOST);

      // Access to one site only: the script runs there, not on the other.
      await ctx.grantSiteOnly(`http://${TEST_HOST}/*`);
      await ctx.openWebPage("textarea.html", { host: TEST_HOST });
      await ctx.focusUntilBadge();
      const withoutAccess = await none(OTHER_HOST);
      await ctx.driver.switchTo().window(options);
      await ctx.waitForVisible("page-mode-access");

      // The button asks for all of it again (a real click: Firefox wants a user gesture).
      await ctx.click("page-mode-access-button");
      await ctx.waitForHidden("page-mode-access");
      if (!(await ctx.hasAllUrlsPermission())) throw new Error("the access was not given back");
      // The page loaded while the access was gone has the script now, without a reload.
      await ctx.driver.switchTo().window(withoutAccess);
      await ctx.driver.executeScript("document.activeElement.blur()");
      await ctx.focusUntilBadge();
    },
  },
  "options-page-auto-check": {
    theme: "light",
    dir: "step-19-like-languagetool",
    async run(ctx) {
      // The box under the switch, unticked: automatic checks in text boxes on websites are off.
      // The pause field follows (neither the editor's Auto-check nor this box is on).
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.expectChecked("page-mode-auto-check");
      await ctx.click("page-mode-auto-check");
      await ctx.waitForSetting("page_mode_auto_check", false);
      const label = await ctx.driver.executeScript(
        "return document.getElementById('page-mode-auto-check').closest('label').textContent.trim()",
      );
      if (label !== "Check automatically while typing in text boxes on websites") {
        throw new Error(`the box is labelled "${label}"`);
      }
      if (await ctx.driver.findElement(By.id("page-mode-auto-check")).isSelected()) {
        throw new Error("the box is still ticked");
      }
      await ctx.expectDisabled("auto-check-delay");
      await ctx.scrollTo("page-mode");
      await ctx.expectTheme();
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "badge-not-checked": {
    theme: "light",
    dir: "step-19-like-languagetool",
    async run(ctx) {
      // A site that is on, automatic checks off: the focused box has its text and the icon badge,
      // no underlines, and nothing was sent.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.click("page-mode-auto-check");
      await ctx.waitForSetting("page_mode_auto_check", false);
      await ctx.openPageModePage("textarea-still.html");
      await ctx.focusBox();
      await ctx.waitForBadge("icon");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await ctx.waitForBadge("icon");
      if (ctx.llmRequests() !== 0) throw new Error("text was checked by itself");
      await ctx.expectNoUnderlines("box", { ignoreBadge: true });
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
  "auto-check-off": {
    theme: "light",
    dir: "step-19-like-languagetool",
    async run(ctx) {
      // No PNG. With automatic checks off, focusing and typing send nothing; the dialog's Check
      // does, and is recorded; edits after it move the underlines and start no check; and a change
      // of the setting applies on the next focus, with no reload.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      const options = await ctx.driver.getWindowHandle();
      await ctx.click("page-mode-auto-check");
      await ctx.waitForSetting("page_mode_auto_check", false);
      await ctx.openPageModePage("textarea-still.html");
      const tab = await ctx.driver.getWindowHandle();
      const quiet = async (what) => {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (ctx.llmRequests() !== 0) throw new Error(`text was sent ${what}`);
      };
      await ctx.focusBox();
      await quiet("on focus");
      await ctx.typeInBox(" and some more words to write");
      await quiet("after the typing pause");
      await ctx.waitForBadge("icon");
      // The badge opens the dialog; Check there is a manual check.
      await new Promise((resolve) => setTimeout(resolve, 800));
      const { x, y } = await ctx.badgeCenter();
      await ctx.clickAt(x, y);
      const bounds = await ctx.waitForPageDialog();
      if (ctx.llmRequests() !== 0) throw new Error("opening the dialog sent text");
      await ctx.clickDialogButton(bounds, 0);
      await ctx.waitForLLMRequests(1);
      await ctx.waitForBadge("grammar");
      if ((await recordedIn(ctx, options, tab)).length === 0) {
        throw new Error("the dialog's Check was not recorded");
      }
      // An edit starts no check.
      await ctx.typeInBox(" again");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (ctx.llmRequests() !== 1) throw new Error("an edit started a check");
      // The setting is read on the next focus: ticked again, the next edit is checked by itself.
      await ctx.driver.switchTo().window(options);
      await ctx.click("page-mode-auto-check");
      await ctx.waitForSetting("page_mode_auto_check", true);
      await ctx.driver.switchTo().window(tab);
      await ctx.driver.executeScript("document.activeElement.blur()");
      await ctx.focusBox();
      await ctx.typeInBox(" once more");
      await ctx.waitForLLMRequests(2);
    },
  },
  "switch-off-nothing": {
    theme: "light",
    dir: "step-19-like-languagetool",
    async run(ctx) {
      // No PNG. With the switch off the content script of the manifest runs and does nothing,
      // anywhere: on a site that is on, on a site with no choice, and in an iframe. No badge, no
      // frame, no request.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: { [TEST_HOST]: "on" } });
      const options = await ctx.driver.getWindowHandle();
      await ctx.click("page-mode");
      await ctx.waitForSetting("page_mode", false);
      await ctx.watchFrameRegistrations();
      for (const sites of [{ [TEST_HOST]: "on" }, {}]) {
        await ctx.driver.switchTo().window(options);
        await ctx.seedSites(sites);
        await ctx.openWebPage("textarea.html");
        await ctx.focusBox();
        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (await ctx.pageModeHostPresent()) throw new Error("page mode showed something");
        await ctx.expectNoBadge();
        if (ctx.llmRequests() !== 0) throw new Error("text was sent with the switch off");
      }
      await ctx.openWebPage("iframes.html");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (await ctx.pageModeHostPresent()) throw new Error("page mode showed something in a frame");
      await ctx.driver.switchTo().window(options);
      if ((await ctx.frameRegistrations()) !== 0) throw new Error("a frame was made");
      await ctx.expectSiteConfig(TEST_HOST, { state: "off" });
    },
  },
  "dimmed-badge-blur": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // No PNG. The dimmed badge is on the focused box only: it goes when the box loses the focus,
      // when the focus moves to a field that is never read, and with the card that it opened.
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      await ctx.openWebPage("excluded.html");
      await ctx.focusUntilBadge("control");
      await ctx.driver.executeScript("document.activeElement.blur()");
      await ctx.waitForNoDimmedBadge("control");
      if (await ctx.pageModeHostPresent()) throw new Error("the badge left its element behind");
      // The focus moves from the text box to a password field: the badge goes.
      await ctx.focusUntilBadge("control");
      await ctx.focusBox("password");
      await ctx.waitForNoDimmedBadge("control");
      await ctx.expectNoBadge("password");
      // The card goes with the badge when the box is left.
      await ctx.focusUntilPrompt("control");
      await ctx.focusBox("password");
      await ctx.waitForNoPrompt();
      await ctx.waitForNoDimmedBadge("control");
      if (await ctx.pageModeHostPresent()) throw new Error("the card left its element behind");
    },
  },
  "focused-at-start": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // No PNG. A text box that is already focused when the content script starts (`autofocus`)
      // is taken up without another click: the dimmed badge on a site with no choice, and the
      // checked badge on a site that is on.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      const options = await ctx.driver.getWindowHandle();
      await ctx.openWebPage("autofocus.html");
      await ctx.expectFocus("box");
      await ctx.waitForBadgeKind("dimmed");
      if (ctx.llmRequests() !== 0) throw new Error("a request was sent before Turn on");
      // The same page on a site that is on: checked at once.
      await ctx.driver.switchTo().window(options);
      await ctx.seedSites({ [TEST_HOST]: "on" });
      await ctx.openWebPage("autofocus.html");
      await ctx.expectFocus("box");
      await ctx.waitForBadge("grammar");
      await ctx.waitForLLMRequests(1);
    },
  },
  "editor-rules": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // No PNG. Which editors count (SPEC section 4.11): a prose editor with spellcheck="false"
      // does, and so does one inside a form with it; CodeMirror, Monaco, Ace, a native textarea
      // with spellcheck off and an editable pre are left alone.
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: {} });
      await ctx.openWebPage("editors.html");
      for (const id of ["prose", "form"]) {
        await ctx.focusUntilBadge(id);
        await ctx.driver.executeScript("document.activeElement.blur()");
        await ctx.waitForNoDimmedBadge(id);
      }
      for (const id of ["cm6", "cm5", "monaco", "ace", "native", "pre"]) {
        await ctx.expectNoPrompt(id, id === "cm6" ? 1500 : 800);
      }
    },
  },
  "page-already-open": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // No PNG. The content script runs once per page frame, whichever way it got there: the
      // manifest's copy runs in every page that loads, and the background script runs the file
      // once more in the tabs that are open when the extension is installed or updated, or when
      // access comes back (`badge-dimmed-open-tab` and `access-withdrawn` show that a page with no
      // script gets one without a reload). A second run in a page that has the script stops at
      // once (`claimPageSlot`).
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      const options = await ctx.driver.getWindowHandle();
      await ctx.openWebPage("textarea.html");
      const page = await ctx.driver.getWindowHandle();
      await ctx.driver.switchTo().window(options);
      await ctx.turnOnPageMode({ sites: {} });
      await ctx.driver.switchTo().window(page);
      await ctx.focusUntilBadge();
      if ((await ctx.pageModeHostCount()) !== 1) throw new Error("page mode started twice");
      // After a reload the manifest's script starts, and still only one.
      await ctx.driver.navigate().refresh();
      await ctx.focusUntilBadge();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if ((await ctx.pageModeHostCount()) !== 1) throw new Error("page mode started twice");
      // The script is run in the page once more, as the background script does for the open tabs
      // (here the manifest's copy is running already): the second copy stops at once.
      await ctx.driver.switchTo().window(options);
      await ctx.driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.tabs.query({ url: ["http://*/*"] }).then((tabs) => Promise.all(tabs.map((t) =>
           browser.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["page.js"] }))))
           .then(() => done("ok"), (e) => done("failed: " + e));`,
      );
      await ctx.driver.switchTo().window(page);
      await ctx.driver.executeScript("document.activeElement.blur()");
      await ctx.focusUntilBadge();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if ((await ctx.pageModeHostCount()) !== 1)
        throw new Error("a second copy of the script started");
    },
  },
  "quill-editor": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // A Quill editor (LinkedIn's post composer) that the page inserts into a modal after load
      // and focuses by script while the modal is still growing into place: it is found without a
      // click, checked, and underlined, though the modal says spellcheck="false".
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("quill.html");
      await ctx.waitForElement("box");
      // The modal grows into place for a third of a second; the harness measures the box after it.
      await ctx.waitForStillBox("box");
      await ctx.waitForBadge("grammar");
      await ctx.waitForLLMRequests(1);
      // The modal's own transition has ended by now. (The harness's `stabilise` would reset it:
      // it pauses every animation at its start. The editor has no caret and no focus ring.)
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.waitForBadge("grammar");
      await ctx.expectUnderline("I seen", "grammar");
      await ctx.expectUnderline("He go", "grammar");
      await ctx.expectUnderline("make a photo", "vocabulary");
      await ctx.screenshot();
    },
  },
  "spa-message-box": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // A message box that a single-page app adds to the page later: a contenteditable div with
      // role="textbox", `<p><br></p>` when it is empty, inside a form with spellcheck="false". The
      // empty box has the icon; what the user types is checked and underlined.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("spa-message.html");
      await ctx.waitForElement("box");
      await ctx.focusBox();
      await ctx.waitForBadge("icon");
      if (ctx.llmRequests() !== 0) throw new Error("an empty box was checked");
      await ctx.typeInBox(PAGE_MODE_TEXT);
      await ctx.waitForBadge("grammar");
      await ctx.waitForLLMRequests(1);
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.waitForBadge("grammar");
      await ctx.expectUnderline("I seen", "grammar");
      await ctx.expectUnderline("He go", "grammar");
      await ctx.expectUnderline("make a photo", "vocabulary");
      await ctx.screenshot();
    },
  },
  "shadow-editor": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // An editor inside an open shadow root (a Lit or other web component): the focus is found
      // through the event's composed path, the badge sits on the editor, and it is underlined.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode();
      await ctx.openPageModePage("shadow.html");
      await ctx.focusBox();
      await ctx.waitForBadge("grammar");
      await ctx.waitForLLMRequests(1);
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.waitForBadge("grammar");
      // The picture has underlines of both categories inside the component, besides the badge.
      const rect = await ctx.driver.executeScript(
        `const r = document.getElementById("box").getBoundingClientRect();
         return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };`,
      );
      const badge = await ctx.badgeCenter();
      for (const category of ["grammar", "vocabulary"]) {
        const n = await ctx.underlinePixels(rect, category, badge);
        if (n < 60) throw new Error(`only ${n} ${category} underline pixels in the component`);
      }
      await ctx.screenshot();
    },
  },
  "iframe-editor": {
    theme: "light",
    dir: "step-18-page-icon",
    async run(ctx) {
      // Editors in iframes: one that the page wrote into an about:blank document (TinyMCE and
      // CKEditor 4 do this), one in a srcdoc iframe, and one from another origin. The script runs
      // in each (`matchOriginAsFallback`), and each frame is a site of its own: the same server
      // under the name localhost is turned on next to 127.0.0.1.
      ctx.llm.setReplies(CHECK_REPLY);
      await ctx.configureFakeLLM({ name: "Fake LLM" });
      await ctx.turnOnPageMode({ sites: { [TEST_HOST]: "on", [OTHER_HOST]: "on" } });
      await ctx.openWebPage("iframes.html");
      for (const frame of ["blank", "srcdoc", "cross"]) {
        await ctx.focusUntilFrameBadge(frame, "grammar");
      }
      await ctx.waitForLLMRequests(3);
      // Blur the frames' boxes (their carets do not blink, and the badges stay on boxes with
      // issues), and wait for the focus rings to fade.
      await ctx.stabilise();
      await new Promise((resolve) => setTimeout(resolve, 800));
      for (const frame of ["blank", "srcdoc", "cross"]) {
        await ctx.waitForFrameBadge(frame, "grammar");
        const rect = await ctx.frameRect(frame);
        const badge = await ctx.frameBadgeCenter(frame);
        for (const category of ["grammar", "vocabulary"]) {
          const n = await ctx.underlinePixels(rect, category, badge);
          if (n < 120)
            throw new Error(`only ${n} ${category} underline pixels in the ${frame} frame`);
        }
      }
      await ctx.screenshot();
    },
  },
  "badge-dimmed-open-tab": {
    theme: "light",
    dir: "step-19-like-languagetool",
    async run(ctx) {
      // A tab that was open before the add-on was installed gets the icon without a reload: the
      // background script runs the content script in the tabs that are open (the manifest's script
      // reaches only pages that load afterwards). The add-on is taken out, the page is loaded with
      // none, and the add-on is installed again.
      // A tab of the web must be there to keep the window open when the options tab goes.
      await ctx.openWebPage("textarea-still.html");
      const page = await ctx.driver.getWindowHandle();
      await ctx.driver.uninstallAddon(GECKO_ID);
      await ctx.driver.switchTo().window(page);
      await ctx.driver.navigate().refresh();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (await ctx.pageModeHostPresent()) {
        throw new Error("the page has page mode before the install");
      }
      // Uninstalling forgets the add-on's fixed address (the `uuids` preference): it is put back
      // before the installation, so that the pages of the other scenarios are found again.
      await ctx.chrome(
        `Services.prefs.setStringPref("extensions.webextensions.uuids", arguments[0]);`,
        JSON.stringify({ [GECKO_ID]: EXTENSION_UUID }),
      );
      const before = await ctx.driver.getAllWindowHandles();
      await ctx.driver.installAddon(ctx.driver.zipPath, true);
      // The installation opens the welcome page in a tab of its own; the page stays as it was.
      const welcome = await ctx.switchToNewTab(before);
      await ctx.driver.close();
      await ctx.driver.switchTo().window(page);
      ctx.driver.installWelcome = { welcome: true, hash: "" };
      if ((await ctx.driver.getCurrentUrl()).endsWith("textarea-still.html") === false) {
        throw new Error(
          `the page tab is ${await ctx.driver.getCurrentUrl()} (welcome tab ${welcome})`,
        );
      }
      // No reload: the box is clicked, and the dimmed badge shows.
      await ctx.focusUntilBadge();
      if (await ctx.promptShowing()) throw new Error("a card opened by itself");
      if (ctx.llmRequests() !== 0) throw new Error("a request was sent");
      await ctx.stabilise({ keepFocus: true });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await ctx.screenshot();
    },
  },
};

/** The colour of the link in the explanation panel and the no-LLM hint (`--accent`, light). */
const LINK_COLOR = { light: [0x0b, 0x5c, 0xad] };

/**
 * A page-mode text box that has been checked, with the issues dialog opened from its badge.
 * `reply` is the answer to the check, `explain` the answer to an explanation request. Returns where
 * the dialog is, and the handles of the options tab (which has the database) and the page's tab.
 */
async function openedDialog(
  ctx,
  { page = "textarea-still.html", reply = CHECK_REPLY, explain = EXPLAIN_REPLY, dark = false } = {},
) {
  ctx.llm.setReplies((request) =>
    isExplainRequest(request)
      ? typeof explain === "function"
        ? explain(request)
        : explain
      : reply,
  );
  await ctx.configureFakeLLM({ name: "Fake LLM" });
  await ctx.turnOnPageMode();
  const options = await ctx.driver.getWindowHandle();
  await ctx.openPageModePage(page);
  const tab = await ctx.driver.getWindowHandle();
  await ctx.focusBox();
  await ctx.waitForBadge("grammar");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const { x, y } = await ctx.badgeCenter();
  await ctx.clickAt(x, y);
  const bounds = await ctx.waitForPageDialog({ dark });
  return { bounds, options, tab };
}

/** The recorded mistakes, read from the options tab; the page's tab is selected again after. */
async function recordedIn(ctx, options, tab) {
  await ctx.driver.switchTo().window(options);
  try {
    return await ctx.recordedMistakes();
  } finally {
    await ctx.driver.switchTo().window(tab);
  }
}

/** Waits until `count` mistakes are recorded, and returns them. */
async function waitForRecorded(ctx, options, tab, count) {
  let found = [];
  await ctx.driver.wait(
    async () => {
      found = await recordedIn(ctx, options, tab);
      return found.length === count;
    },
    PAGE_TIMEOUT_MS,
    "the mistakes were never recorded",
  );
  return found;
}

/** The selection of the text box of the page (`{ start, end }`). */
async function boxSelection(ctx, id = "box") {
  return ctx.driver.executeScript(
    "const b = document.getElementById(arguments[0]); return { start: b.selectionStart, end: b.selectionEnd };",
    id,
  );
}

async function boxScrollTop(ctx, id = "box") {
  return ctx.driver.executeScript("return document.getElementById(arguments[0]).scrollTop", id);
}

/** Fails unless the first line of `snippet` is inside the text box's visible area. */
async function expectWordInBox(ctx, snippet, id = "box") {
  const [rect] = await ctx.wordRects(snippet, id);
  const box = await ctx.driver.executeScript(
    `const r = document.getElementById(arguments[0]).getBoundingClientRect();
     return { top: r.top, bottom: r.bottom };`,
    id,
  );
  if (rect === undefined || rect.top < box.top || rect.bottom > box.bottom) {
    throw new Error(`"${snippet}" is not inside the box: ${JSON.stringify({ rect, box })}`);
  }
}

/** The fake LLM's answer when the text has no mistake. */
const NO_ISSUES_REPLY = {
  content: JSON.stringify({ issues: [] }),
  usage: { prompt_tokens: 60, completion_tokens: 8 },
};

/** JSON with the keys of every object in order, so that two values compare whatever their key order. */
function canonicalJson(value) {
  return JSON.stringify(value, (_, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * Fails unless installing the add-on opened the welcome page (`options.html#welcome`, on
 * `runtime.onInstalled` with reason `install`) and it showed the Welcome block with the fragment
 * cleared. `startBrowser` looked at that tab and closed it.
 */
async function expectInstallWelcome(ctx) {
  const found = ctx.driver.installWelcome;
  if (found?.welcome !== true) {
    throw new Error(
      `installing the add-on did not show the Welcome block: ${JSON.stringify(found)}`,
    );
  }
  if (found.hash !== "") throw new Error(`the welcome address kept its fragment: ${found.hash}`);
}

/** The colour of the Open in English Tutor button of the blocked badge's card (#0b5cad). */
const BLOCKED_CARD_BUTTON = [0x0b, 0x5c, 0xad];

/**
 * What the buttons of the site prompt look like (SPEC section 4.11): the card lives in a closed
 * shadow root that Selenium cannot reach, so the harness finds a button from the pixels of the
 * screenshot, as it does for the badge. Turn on is filled blue, and Never on this site has a red
 * border (the card has no Not now: the dimmed badge opens it, and its close button and Escape
 * dismiss it).
 */
const PROMPT_COLORS = {
  on: [0x0b, 0x5c, 0xad],
  off: [0xb3, 0x26, 0x1e],
};

/** The site the test pages are on, and another that is the same server under another name. */
const TEST_HOST = "127.0.0.1";
const OTHER_HOST = "localhost";

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

/** The canned check of `LONG_TEXT`: a mistake in its fourth, sixth and tenth lines. */
const LONG_REPLY = {
  content: JSON.stringify({
    issues: [
      {
        text: "sister seen",
        error_type: "verb_form",
        message: "Use the past tense: sister saw.",
        context_before: "My ",
        context_after: " a deer",
      },
      {
        text: "father tell",
        error_type: "subject_verb_agreement",
        message: "Use tells with father.",
        context_before: "My ",
        context_after: " us old",
      },
      {
        text: "make a photo",
        error_type: "collocation",
        message: "Say take a photo.",
        context_before: "My brother ",
        context_after: " of the whole",
      },
    ],
  }),
  usage: { prompt_tokens: 600, completion_tokens: 90 },
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

/**
 * The page-mode test page `name` with its text box focused, checked (the canned reply), and then
 * left, so that no caret or focus ring shows: the underlines and the badge of a box that has issues
 * stay. Returns after the badge has its count.
 */
async function checkedBox(ctx, name, { reply = CHECK_REPLY, id = "box" } = {}) {
  ctx.llm.setReplies(reply);
  await ctx.configureFakeLLM({ name: "Fake LLM" });
  await ctx.turnOnPageMode();
  await ctx.openPageModePage(name);
  await ctx.focusBox(id);
  await ctx.waitForBadge("grammar", id);
  await ctx.stabilise();
  // The focus ring of the box fades out of its own accord.
  await new Promise((resolve) => setTimeout(resolve, 800));
}

/**
 * Page-mode text box with a check done, then a click on `snippet`: the popover opens for it. Uses
 * the page whose caret does not blink, because the box keeps the focus. `explain` is the reply to
 * the explanation request. Returns where the underline is and where the card is (its border rows).
 */
async function openedPopover(
  ctx,
  snippet,
  { page = "textarea-still.html", explain = EXPLAIN_REPLY, dark = false } = {},
) {
  ctx.llm.setReplies((request) =>
    isExplainRequest(request)
      ? typeof explain === "function"
        ? explain(request)
        : explain
      : CHECK_REPLY,
  );
  await ctx.configureFakeLLM({ name: "Fake LLM" });
  await ctx.turnOnPageMode();
  await ctx.openPageModePage(page);
  await ctx.focusBox();
  await ctx.waitForBadge("grammar");
  const [anchor] = await ctx.wordRects(snippet);
  await ctx.clickWord(snippet);
  const bounds = await ctx.waitForPopover(anchor, { dark });
  return { anchor, bounds };
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
    driver.zipPath = zipPath;
    await driver.installAddon(zipPath, true);
    // Installing the add-on is an installation (`runtime.onInstalled`, reason `install`, which a
    // temporary add-on reports too), so the background script opens the welcome page in a new tab.
    // It is looked at and closed here, so that no scenario meets an extra tab, and the `welcome`
    // scenario can say that the installation did open it.
    driver.installWelcome = await takeInstallWelcomeTab(driver);
  } catch (err) {
    await driver.quit();
    throw err;
  }
  return driver;
}

/**
 * Waits for the tab that installing the add-on opens (`options.html#welcome`), reports what it
 * shows (the Welcome block, and that the fragment was cleared from the address), and closes it.
 */
async function takeInstallWelcomeTab(driver) {
  const original = await driver.getWindowHandle();
  let welcome;
  await driver.wait(
    async () => {
      welcome = (await driver.getAllWindowHandles()).find((h) => h !== original);
      return welcome !== undefined;
    },
    PAGE_TIMEOUT_MS,
    "installing the add-on never opened the welcome page (runtime.onInstalled with reason install?)",
  );
  await driver.switchTo().window(welcome);
  await waitForPage(driver, "options.html");
  await driver.wait(until.elementLocated(By.id("welcome")), PAGE_TIMEOUT_MS);
  const found = await driver.executeScript(
    "return { welcome: document.getElementById('welcome') !== null, hash: location.hash }",
  );
  await driver.close();
  await driver.switchTo().window(original);
  return found;
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
  // The dimmed badge of a site that is not on: #6b7785 at 60% opacity over a white page.
  dimmed: [166, 173, 182],
};

/** The colours of the underlines (src/content/style.ts), for a light and a dark page. */
const UNDERLINE_PALETTE = {
  light: {
    grammar: [0xd5, 0x5e, 0x00],
    vocabulary: [0x00, 0x72, 0xb2],
    syntax: [0x00, 0x9e, 0x73],
  },
  dark: { grammar: [0xff, 0x8a, 0x4c], vocabulary: [0x56, 0xb4, 0xe9], syntax: [0x2f, 0xd3, 0xa2] },
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
  // Page mode starts from a fresh installation too: nothing in `storage.session` (the sites
  // answered Not now), and the access to all websites that Firefox grants at the installation
  // (`host_permissions`). A scenario that withdrew it gives it back through the options page's
  // button (a real click: Firefox accepts `permissions.request` only from a user gesture).
  await ctx.driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     browser.storage.session.clear().then(() => done("cleared"), (e) => done("failed: " + e));`,
  );
  if (!(await ctx.hasAllUrlsPermission())) {
    await ctx.waitForVisible("page-mode-access");
    await ctx.click("page-mode-access-button");
    await ctx.driver.wait(
      () => ctx.hasAllUrlsPermission(),
      PAGE_TIMEOUT_MS,
      "access to all websites could not be given back",
    );
  }
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
      const relative = `${scenario.dir}/${scenario.file ?? name}.png`;
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
    /** Waits until the element with this id is not displayed. */
    async waitForHidden(id) {
      const element = await driver.findElement(By.id(id));
      await driver.wait(until.elementIsNotVisible(element), PAGE_TIMEOUT_MS, `#${id} never went`);
    },
    async expectNoElement(id) {
      if ((await driver.findElements(By.id(id))).length !== 0) {
        throw new Error(`#${id} is on the page`);
      }
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
    async openWebPage(name, { host = TEST_HOST } = {}) {
      const before = await driver.getAllWindowHandles();
      await driver.setContext(firefox.Context.CHROME);
      try {
        await driver.executeScript(
          `const tab = gBrowser.addTab(arguments[0], {
             triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
           });
           gBrowser.selectedTab = tab;`,
          llm.pageUrl(name).replace(TEST_HOST, host),
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
     * Checks that page mode is on the way a fresh installation has it (the switch "Show the
     * English Tutor icon in text boxes on websites" is ticked, and Firefox granted access to all
     * websites when the add-on was installed: nothing is clicked or allowed), sets the pause of
     * the automatic check to one second (the shortest) so that scenarios do not wait for three,
     * and seeds the site choices.
     *
     * Page mode is off on every site until the user turns a site on (SPEC section 4.11), so the
     * scenarios that are not about the icon seed the test site as `on` (`sites`, host to `on` or
     * `off`; `{}` leaves every site to be asked). That is a test-only write of the setting.
     */
    async turnOnPageMode({ delay = 1, sites = { [TEST_HOST]: "on" } } = {}) {
      await driver.wait(until.elementLocated(By.id("page-mode")), PAGE_TIMEOUT_MS);
      await ctx.expectChecked("page-mode");
      if (!(await ctx.hasAllUrlsPermission())) {
        throw new Error("the installation did not grant access to all websites");
      }
      // The delay is used by page mode, so its field is enabled.
      await ctx.fill("auto-check-delay", String(delay), Key.TAB);
      await ctx.seedSites(sites);
    },
    /** The stored value of a setting, or undefined when it has none (the default applies). Run on an extension page. */
    async readSetting(key) {
      return driver
        .executeAsyncScript(
          `const done = arguments[arguments.length - 1];
         const open = indexedDB.open("english-tutor");
         open.onsuccess = () => {
           const get = open.result.transaction("settings").objectStore("settings").get(arguments[0]);
           get.onsuccess = () => { open.result.close(); done(get.result ? { value: get.result.value } : { value: undefined }); };
           get.onerror = () => done({ error: true });
         };`,
          key,
        )
        .then((found) => {
          if (found.error === true) throw new Error(`could not read the setting ${key}`);
          return found.value;
        });
    },
    /** Waits until the stored setting has this value. Run on an extension page. */
    async waitForSetting(key, value) {
      await driver.wait(
        async () => canonicalJson(await ctx.readSetting(key)) === canonicalJson(value),
        PAGE_TIMEOUT_MS,
        `the setting ${key} never became ${JSON.stringify(value)}`,
      );
    },
    /** Test only: stores the site choices (`page_mode_sites`) from the options page. */
    async seedSites(sites) {
      const stored = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         const open = indexedDB.open("english-tutor");
         open.onsuccess = () => {
           const tx = open.result.transaction("settings", "readwrite");
           tx.objectStore("settings").put({ key: "page_mode_sites", value: arguments[0] });
           tx.oncomplete = () => { open.result.close(); done("stored"); };
           tx.onerror = () => done("failed");
         };`,
        sites,
      );
      if (stored !== "stored") throw new Error("could not store the site choices");
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
    /**
     * The rectangles (window coordinates, one per line) of the first `snippet` in a text box of the
     * page, measured in the page itself, without the extension: for a textarea or an input, with a
     * hidden copy of its text (same font, padding, width and scroll position), for editable content
     * with a `Range` over the text. The underlines must sit on exactly these.
     */
    async wordRects(snippet, id = "box") {
      return driver.executeScript(
        `const box = document.getElementById(arguments[1]);
         const snippet = arguments[0];
         const out = (rects) => [...rects].map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
         if (box.isContentEditable) {
           const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
           for (let node = walker.nextNode(); node; node = walker.nextNode()) {
             const at = node.data.indexOf(snippet);
             if (at < 0) continue;
             const range = document.createRange();
             range.setStart(node, at);
             range.setEnd(node, at + snippet.length);
             return out(range.getClientRects());
           }
           return [];
         }
         const at = box.value.indexOf(snippet);
         if (at < 0) return [];
         const style = getComputedStyle(box);
         const px = (v) => parseFloat(v) || 0;
         const rect = box.getBoundingClientRect();
         const copy = document.createElement("div");
         for (const name of ["font", "line-height", "letter-spacing", "word-spacing", "text-indent",
           "white-space", "overflow-wrap", "word-break", "tab-size", "text-align", "padding"]) {
           copy.style.setProperty(name, style.getPropertyValue(name));
         }
         if (box.tagName === "INPUT") copy.style.setProperty("white-space", "pre");
         copy.style.cssText += ";position:fixed;visibility:hidden;box-sizing:border-box;margin:0;border:0;";
         copy.style.width = box.clientWidth + "px";
         const before = document.createTextNode(box.value.slice(0, at));
         const span = document.createElement("span");
         span.textContent = snippet;
         copy.append(before, span, document.createTextNode(box.value.slice(at + snippet.length)));
         document.body.append(copy);
         let top = rect.top + px(style.borderTopWidth) - box.scrollTop;
         const left = rect.left + px(style.borderLeftWidth) - box.scrollLeft;
         if (box.tagName === "INPUT") top += (box.clientHeight - copy.getBoundingClientRect().height) / 2;
         copy.style.left = left + "px";
         copy.style.top = top + "px";
         const rects = out(span.getClientRects());
         copy.remove();
         return rects;`,
        snippet,
        id,
      );
    },
    /**
     * Fails unless the underline of `snippet` (the first one in the box) is drawn on every line it
     * covers, in the colour of `category` (`dark` for a dark page), from its first character to its
     * last, a little below the text. The colours are read from the picture, as a user sees it.
     * Returns the rectangles. A wavy, dashed or dotted line has gaps, so only a share of the
     * pixels of a line have its colour.
     */
    async expectUnderline(snippet, category, { id = "box", dark = false } = {}) {
      const rects = await ctx.wordRects(snippet, id);
      if (rects.length === 0) throw new Error(`"${snippet}" is not in #${id}`);
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const color = UNDERLINE_PALETTE[dark ? "dark" : "light"][category];
      for (const rect of rects) {
        let first = Infinity;
        let last = -Infinity;
        let count = 0;
        const top = Math.round(rect.bottom) - 5;
        const bottom = Math.round(rect.bottom) + 5;
        for (let y = Math.max(0, top); y <= bottom; y++) {
          for (let x = Math.round(rect.left) - 6; x <= Math.round(rect.right) + 6; x++) {
            if (!closeTo(png.pixel(x, y), color, 40)) continue;
            count++;
            first = Math.min(first, x);
            last = Math.max(last, x);
          }
        }
        const width = rect.right - rect.left;
        if (count < width * 0.3) {
          throw new Error(
            `no ${category} underline under "${snippet}" at ${Math.round(rect.left)},${Math.round(rect.bottom)}: ${count} pixels`,
          );
        }
        // From its first character to its last: within three pixels of the word's rectangle.
        if (
          first < rect.left - 3 ||
          last > rect.right + 3 ||
          first > rect.left + 6 ||
          last < rect.right - 6
        ) {
          throw new Error(
            `the ${category} underline of "${snippet}" spans ${first}..${last}, the word is ${Math.round(rect.left)}..${Math.round(rect.right)}`,
          );
        }
      }
      return rects;
    },
    /** The card is gone: no border rows next to the underline `anchor`, above or below it. */
    async waitForNoPopover(anchor, { left } = {}) {
      const at = left ?? Math.min(Math.max(anchor.left, 8), WIDTH - 360 - 8);
      await driver.wait(
        async () =>
          (await ctx.popoverBounds(at, [anchor.bottom, Math.min(HEIGHT, anchor.bottom + 360)])) ===
            undefined &&
          (await ctx.popoverBounds(at, [Math.max(0, anchor.top - 360), anchor.top])) === undefined,
        PAGE_TIMEOUT_MS,
        "the popover never closed",
      );
    },
    /** Clicks the header line of the card (inside it, on text): the card's page has the focus. */
    async clickCardHeader(bounds, anchor) {
      const left = Math.min(Math.max(anchor.left, 8), WIDTH - 360 - 8);
      await ctx.clickAt(Math.round(left + 40), bounds.top + 16);
    },
    /** Presses keys where the keyboard focus is (a text box of the page, or inside the card). */
    async pressKeys(...keys) {
      const actions = driver.actions({ async: true });
      for (const key of keys) actions.sendKeys(key);
      await actions.perform();
    },
    /** Puts the caret right after the first `before` of the box, with a script (the keys are the user's). */
    async setCaretAfter(before, id = "box") {
      await driver.executeScript(
        `const box = document.getElementById(arguments[1]);
         const at = box.value.indexOf(arguments[0]) + arguments[0].length;
         box.focus();
         box.setSelectionRange(at, at);`,
        before,
        id,
      );
    },
    /** Fails if the first line of `snippet` still has the background of a selected issue. */
    async expectNoSelectedBackground(snippet, category, { id = "box" } = {}) {
      const [rect] = await ctx.wordRects(snippet, id);
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const color = UNDERLINE_PALETTE.light[category];
      const expected = color.map((c) => Math.round(255 * 0.8 + c * 0.2));
      const y = Math.round(rect.top) + 1;
      for (let x = Math.round(rect.left) + 1; x < Math.round(rect.right) - 1; x++) {
        if (closeTo(png.pixel(x, y), expected, 10))
          throw new Error(`"${snippet}" is still selected`);
      }
    },
    /** Fails if `snippet` has an underline of `category` under it (it was removed by an edit). */
    async expectNoUnderlineUnder(snippet, category, { id = "box", dark = false } = {}) {
      const rects = await ctx.wordRects(snippet, id);
      if (rects.length === 0) throw new Error(`"${snippet}" is not in #${id}`);
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const color = UNDERLINE_PALETTE[dark ? "dark" : "light"][category];
      for (const rect of rects) {
        for (let y = Math.round(rect.bottom) - 5; y <= Math.round(rect.bottom) + 5; y++) {
          for (let x = Math.round(rect.left) + 2; x < Math.round(rect.right) - 2; x++) {
            if (closeTo(png.pixel(x, y), color, 25)) {
              throw new Error(`"${snippet}" is still underlined (${x},${y})`);
            }
          }
        }
      }
    },
    /** Fails if a pixel of the box has the colour of an underline, light or dark (the page has none of them). */
    async expectNoUnderlines(id = "box", { ignoreBadge = false } = {}) {
      const rect = await driver.executeScript(
        `const r = document.getElementById(arguments[0]).getBoundingClientRect();
         return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };`,
        id,
      );
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      for (let y = Math.round(rect.top); y < Math.round(rect.bottom); y++) {
        for (let x = Math.round(rect.left); x < Math.round(rect.right); x++) {
          // The badge, in the box's bottom right corner, has the colours of an underline too.
          if (ignoreBadge && x > rect.right - 34 && y > rect.bottom - 34) continue;
          const pixel = png.pixel(x, y);
          for (const palette of Object.values(UNDERLINE_PALETTE)) {
            for (const color of Object.values(palette)) {
              if (closeTo(pixel, color, 12)) {
                throw new Error(`#${id} has an underline-coloured pixel at ${x},${y}`);
              }
            }
          }
        }
      }
    },
    /**
     * Fails unless the first line of `snippet` has the selected-issue background: its category
     * colour at 20% over the page's colour (`page`, white by default), read along the top edge of
     * the word's rectangle, where there is no letter.
     */
    async expectSelectedBackground(
      snippet,
      category,
      { id = "box", dark = false, page, tolerance = 10 } = {},
    ) {
      const [rect] = await ctx.wordRects(snippet, id);
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const color = UNDERLINE_PALETTE[dark ? "dark" : "light"][category];
      const base = page ?? (dark ? [0x1e, 0x21, 0x27] : [255, 255, 255]);
      const expected = color.map((c, i) => Math.round(base[i] * 0.8 + c * 0.2));
      const y = Math.round(rect.top) + 1;
      let matching = 0;
      let total = 0;
      for (let x = Math.round(rect.left) + 1; x < Math.round(rect.right) - 1; x++) {
        total++;
        if (closeTo(png.pixel(x, y), expected, tolerance)) matching++;
      }
      if (matching < total * 0.8) {
        throw new Error(
          `"${snippet}" has no selected background: ${matching} of ${total} pixels at y=${y} are ${String(expected)}`,
        );
      }
    },
    /** Clicks the middle of the first line of `snippet` in a text box, as a user does. */
    async clickWord(snippet, id = "box", { dx = 0 } = {}) {
      const [rect] = await ctx.wordRects(snippet, id);
      if (rect === undefined) throw new Error(`"${snippet}" is not in #${id}`);
      await ctx.clickAt(
        Math.round((rect.left + rect.right) / 2) + dx,
        Math.round((rect.top + rect.bottom) / 2),
      );
    },
    /**
     * The border rows of the card of the popover: it is 360 px wide, starts at `left`, and its
     * border is the frame's border colour on a stretch clear of its rounded corners. Returns `{ top, bottom }`
     * (the first and the last row of the border), or undefined when there is no card.
     */
    async popoverBounds(left, between, { dark = false } = {}) {
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const border = dark ? [0x3d, 0x42, 0x4a] : [0xc9, 0xce, 0xd6];
      const rows = [];
      for (
        let y = Math.max(0, Math.round(between[0]));
        y < Math.min(HEIGHT, Math.round(between[1]));
        y++
      ) {
        // A border row is the border colour all along a stretch clear of the rounded corners.
        let run = true;
        for (let x = Math.round(left) + 30; x < Math.round(left) + 90 && run; x++) {
          run = closeTo(png.pixel(x, y), border, 6);
        }
        if (run) rows.push(y);
      }
      // The card has two border rows (top and bottom).
      return rows.length >= 2 ? { top: rows[0], bottom: rows[rows.length - 1], rows } : undefined;
    },
    /**
     * Waits until the popover's card is drawn next to the underline `anchor` (a rectangle from
     * `wordRects`): it is 360 px wide and starts at the underline's left edge, moved to stay in the
     * window, and is below it or above it. Returns its border rows and where it went.
     */
    async waitForPopover(anchor, { dark = false, side } = {}) {
      const left = Math.min(Math.max(anchor.left, 8), WIDTH - 360 - 8);
      let found;
      await driver.wait(
        async () => {
          const below = await ctx.popoverBounds(
            left,
            [anchor.bottom, Math.min(HEIGHT, anchor.bottom + 360)],
            { dark },
          );
          const above = await ctx.popoverBounds(left, [Math.max(0, anchor.top - 360), anchor.top], {
            dark,
          });
          const rows = side === "above" ? undefined : below;
          const upRows = side === "below" ? undefined : above;
          if (rows !== undefined) found = { ...rows, side: "below" };
          else if (upRows !== undefined) found = { ...upRows, side: "above" };
          else return false;
          return true;
        },
        PAGE_TIMEOUT_MS,
        "the popover never showed",
      );
      const gap = found.side === "below" ? found.top - anchor.bottom : anchor.top - found.bottom;
      if (gap < 3 || gap > 10) throw new Error(`the card is ${gap}px from the underline`);
      return found;
    },
    /**
     * Where the issues dialog should be for the text box with this id (SPEC section 4.11): 440 by
     * 520 px, to the right of the box with 8 px between them (these test pages have room there),
     * its top lined up with the box's and kept 8 px inside the window.
     */
    async expectedDialog(id = "box") {
      const rect = await driver.executeScript(
        `const r = document.getElementById(arguments[0]).getBoundingClientRect();
         return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };`,
        id,
      );
      const left = Math.round(rect.right + 8);
      const top = Math.round(Math.min(Math.max(rect.top, 8), HEIGHT - 520 - 8));
      return { left, top, width: 440, height: 520, box: rect };
    },
    /**
     * The dialog's border, read from the picture: the frame's border colour along its top and its
     * bottom row, clear of the rounded corners, 519 rows apart. Returns where it is, or undefined.
     */
    async dialogBounds({ id = "box", dark = false } = {}) {
      const expected = await ctx.expectedDialog(id);
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const border = dark ? [0x3d, 0x42, 0x4a] : [0xc9, 0xce, 0xd6];
      const rowIsBorder = (y) => {
        for (let x = expected.left + 40; x < expected.left + 120; x++) {
          if (!closeTo(png.pixel(x, y), border, 6)) return false;
        }
        return true;
      };
      return rowIsBorder(expected.top) && rowIsBorder(expected.top + expected.height - 1)
        ? expected
        : undefined;
    },
    /** Waits until the dialog is drawn where it belongs, and returns where that is. */
    async waitForPageDialog(options = {}) {
      let found;
      await driver.wait(
        async () => {
          found = await ctx.dialogBounds(options);
          return found !== undefined;
        },
        PAGE_TIMEOUT_MS,
        "the issues dialog never showed",
      );
      return found;
    },
    /** Waits until nothing is drawn where the dialog was. */
    async waitForNoPageDialog(options = {}) {
      await driver.wait(
        async () => (await ctx.dialogBounds(options)) === undefined,
        PAGE_TIMEOUT_MS,
        "the issues dialog never closed",
      );
    },
    /**
     * The centres of the rows of the dialog's list, found from the round category markers (22 px,
     * in the colour of the category) in the column where the markers are. Top to bottom.
     */
    async dialogRows(bounds, { dark = false } = {}) {
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const colors = Object.values(UNDERLINE_PALETTE[dark ? "dark" : "light"]);
      // A column near the edge of the circles, clear of the white letter in their middle.
      const x = bounds.left + 17;
      const rows = [];
      let start;
      for (let y = bounds.top; y < bounds.top + 280; y++) {
        const marker = colors.some((c) => closeTo(png.pixel(x, y), c, 6));
        if (marker && start === undefined) start = y;
        if (!marker && start !== undefined) {
          if (y - start >= 10) rows.push({ x: bounds.left + 24, y: Math.round((start + y) / 2) });
          start = undefined;
        }
      }
      return rows;
    },
    /** Clicks row `n` (from 0) of the dialog's list, as the user does. */
    async clickDialogRow(bounds, n, options = {}) {
      const rows = await ctx.dialogRows(bounds, options);
      const row = rows[n];
      if (row === undefined) throw new Error(`the dialog has ${rows.length} rows, not ${n + 1}`);
      await ctx.clickAt(row.x + 60, row.y);
    },
    /**
     * The centres of the three buttons of the dialog's footer (Check, Open in English Tutor, Close):
     * along the row of the buttons, a button is a stretch of pixels that are not the footer's own
     * colour, and the gap between two buttons is the footer's colour.
     */
    async dialogButtons(bounds, { dark = false } = {}) {
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const footer = dark ? [0x23, 0x26, 0x2b] : [0xf3, 0xf4, 0xf6];
      const y = bounds.top + bounds.height - 22;
      const segments = [];
      let start;
      for (let x = bounds.left + 4; x < bounds.left + bounds.width - 4; x++) {
        const inButton = !closeTo(png.pixel(x, y), footer, 3);
        if (inButton && start === undefined) start = x;
        if (!inButton && start !== undefined) {
          segments.push([start, x - 1]);
          start = undefined;
        }
      }
      // A pixel of a letter's edge can look like the footer: gaps narrower than the 6 px between
      // two buttons belong to the button.
      for (let i = segments.length - 1; i > 0; i--) {
        if (segments[i][0] - segments[i - 1][1] < 5) {
          segments[i - 1][1] = segments[i][1];
          segments.splice(i, 1);
        }
      }
      segments.splice(0, segments.length, ...segments.filter(([from, to]) => to - from >= 30));
      if (segments.length !== 3) {
        throw new Error(
          `the dialog's footer has ${segments.length} buttons, not 3: ${JSON.stringify(segments)}`,
        );
      }
      return segments.map(([from, to]) => ({ x: Math.round((from + to) / 2), y }));
    },
    /**
     * The middle of the pixels of this colour inside `region` (`{ left, top, right, bottom }`), for
     * a small control such as a link, whose text has fewer pixels than `waitForColor` wants.
     */
    async colorCenterIn(region, rgb, { tolerance = 30, minimum = 20 } = {}) {
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      let sumX = 0;
      let sumY = 0;
      let n = 0;
      for (let y = region.top; y < region.bottom; y++) {
        for (let x = region.left; x < region.right; x++) {
          if (closeTo(png.pixel(x, y), rgb, tolerance)) {
            sumX += x;
            sumY += y;
            n++;
          }
        }
      }
      if (n < minimum)
        throw new Error(`only ${n} pixels of ${String(rgb)} in ${JSON.stringify(region)}`);
      return { x: Math.round(sumX / n), y: Math.round(sumY / n) };
    },
    /** Clicks a footer button of the dialog: 0 is Check or Cancel, 1 Open in English Tutor, 2 Close. */
    async clickDialogButton(bounds, n, options = {}) {
      const button = (await ctx.dialogButtons(bounds, options))[n];
      await ctx.clickAt(button.x, button.y);
    },
    /** The recorded mistakes (the rows of `error_events`), read from the options page's database. */
    async recordedMistakes() {
      return driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         const open = indexedDB.open("english-tutor");
         open.onsuccess = () => {
           const all = open.result.transaction("error_events").objectStore("error_events").getAll();
           all.onsuccess = () => {
             open.result.close();
             done(all.result.map((e) => ({ source: e.source_key, type: e.error_type, llm: e.llm_name })));
           };
         };`,
      );
    },
    /** Fails unless the text box still has the keyboard focus (the popover never takes it). */
    async expectBoxFocused(id = "box") {
      const active = await driver.executeScript(
        "return document.activeElement?.id ?? document.activeElement?.tagName",
      );
      if (active !== id) throw new Error(`the focus is on ${active}, not on #${id}`);
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

    /** Waits until the page has an element with this id (a page that builds its editor later). */
    async waitForElement(id) {
      await driver.wait(until.elementLocated(By.id(id)), PAGE_TIMEOUT_MS);
    },
    /** Waits until the box has stopped moving (its rectangle is the same for 600 ms). */
    async waitForStillBox(id) {
      let last = "";
      let since = Date.now();
      await driver.wait(
        async () => {
          const now = await driver.executeScript(
            `const r = document.getElementById(arguments[0]).getBoundingClientRect();
             return [r.left, r.top, r.width, r.height].join();`,
            id,
          );
          if (now !== last) {
            last = now;
            since = Date.now();
          }
          return Date.now() - since > 600;
        },
        PAGE_TIMEOUT_MS,
        `#${id} never stopped moving`,
      );
    },
    /** How many elements the overlay has put directly into `<html>` (page mode makes one per frame). */
    async pageModeHostCount() {
      return driver.executeScript(
        "return [...document.documentElement.children].filter((c) => c.tagName === 'DIV').length",
      );
    },
    /** Waits until the badge of the box (default #box) shows `kind`, without clicking anything. */
    async waitForBadgeKind(kind, id = "box") {
      await driver.wait(
        () => ctx.badgeShows(kind, id),
        PAGE_TIMEOUT_MS,
        `the badge of #${id} never showed ${kind}`,
      );
    },
    /** Waits until the box has no dimmed badge any more. */
    async waitForNoDimmedBadge(id = "box") {
      await driver.wait(
        async () => !(await ctx.badgeShows("dimmed", id)),
        PAGE_TIMEOUT_MS,
        `the dimmed badge of #${id} never went`,
      );
    },
    /** Waits until no prompt card shows. */
    async waitForNoPrompt() {
      await driver.wait(
        async () => !(await ctx.promptShowing()),
        PAGE_TIMEOUT_MS,
        "the prompt never went",
      );
    },
    /**
     * How many pixels in `rect` (window coordinates) have the colour of the underlines of
     * `category`, leaving out the 26 px square round `except` (the badge, which has the colour of
     * the category too).
     */
    async underlinePixels(rect, category, except) {
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      const color = UNDERLINE_PALETTE.light[category];
      let n = 0;
      for (let y = Math.max(0, Math.round(rect.top)); y < Math.round(rect.bottom); y++) {
        for (let x = Math.max(0, Math.round(rect.left)); x < Math.round(rect.right); x++) {
          if (
            except !== undefined &&
            Math.abs(x - except.x) <= 13 &&
            Math.abs(y - except.y) <= 13
          ) {
            continue;
          }
          if (closeTo(png.pixel(x, y), color, 40)) n++;
        }
      }
      return n;
    },
    /** The rectangle of an iframe of the page, in window coordinates (inside its border). */
    async frameRect(frameId) {
      await driver.switchTo().defaultContent();
      return driver.executeScript(
        `const f = document.getElementById(arguments[0]);
         const r = f.getBoundingClientRect();
         return { left: r.left + f.clientLeft, top: r.top + f.clientTop,
                  right: r.left + f.clientLeft + f.clientWidth, bottom: r.top + f.clientTop + f.clientHeight };`,
        frameId,
      );
    },
    /** The middle of the badge of #box inside an iframe, in window coordinates. */
    async frameBadgeCenter(frameId) {
      const origin = await ctx.frameRect(frameId);
      await driver.switchTo().frame(await driver.findElement(By.id(frameId)));
      try {
        const inside = await ctx.badgeCenter("box");
        return { x: inside.x + origin.left, y: inside.y + origin.top };
      } finally {
        await driver.switchTo().defaultContent();
      }
    },
    /** Whether the badge in the iframe shows `kind`, from the pixels of the window. */
    async frameBadgeShows(frameId, kind) {
      const { x, y } = await ctx.frameBadgeCenter(frameId);
      return closeTo(await ctx.pixelAt(x, y - 7), BADGE_COLORS[kind]);
    },
    async waitForFrameBadge(frameId, kind) {
      await driver.wait(
        () => ctx.frameBadgeShows(frameId, kind),
        PAGE_TIMEOUT_MS,
        `the badge in the ${frameId} frame never showed ${kind}`,
      );
    },
    /**
     * Clicks into the editor of an iframe, until its badge shows `kind` (the content script of the
     * frame starts a moment after the frame has loaded).
     */
    async focusUntilFrameBadge(frameId, kind) {
      for (let attempt = 0; attempt < 8; attempt++) {
        await driver.switchTo().defaultContent();
        await driver.switchTo().frame(await driver.findElement(By.id(frameId)));
        try {
          await driver.findElement(By.id("box")).click();
        } finally {
          await driver.switchTo().defaultContent();
        }
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (await ctx.frameBadgeShows(frameId, kind)) return;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await driver.switchTo().frame(await driver.findElement(By.id(frameId)));
        try {
          await driver.executeScript("document.activeElement.blur()");
        } finally {
          await driver.switchTo().defaultContent();
        }
      }
      throw new Error(`the badge in the ${frameId} frame never showed ${kind}`);
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
    /** The content scripts registered with `scripting`: none, as the manifest declares the script. */
    async registeredScripts() {
      return driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.scripting.getRegisteredContentScripts().then((f) => done(f.length), () => done(-1));`,
      );
    },
    /**
     * The user withdraws the access to all websites (the extensions panel, about:addons): the
     * extension removes its own `host_permissions`, which Firefox allows. Run on an extension page.
     */
    async withdrawAccess() {
      const removed = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.permissions.remove({ origins: ["<all_urls>", "http://*/*", "https://*/*"] }).then(done, (e) => done("failed: " + e));`,
      );
      if (removed !== true) throw new Error(`the access could not be withdrawn: ${removed}`);
    },
    /**
     * Gives the extension access to one site only (what the user does in the extensions panel for
     * a site), through the browser's own permission store. Run from anywhere: it uses the chrome
     * context.
     */
    async grantSiteOnly(pattern) {
      const done = await ctx.chrome(
        `const { ExtensionPermissions } = ChromeUtils.importESModule(
           "resource://gre/modules/ExtensionPermissions.sys.mjs");
         const policy = WebExtensionPolicy.getByID(arguments[0]);
         await ExtensionPermissions.add(arguments[0], { permissions: [], origins: [arguments[1]] }, policy.extension);
         return "added";`,
        GECKO_ID,
        pattern,
      );
      if (done !== "added")
        throw new Error(`could not give access to ${pattern}: ${JSON.stringify(done)}`);
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
    async openToolbarMenu(wanted) {
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
            return labels.includes(wanted);
          },
          PAGE_TIMEOUT_MS,
          `the toolbar menu never offered ${wanted} (it shows ${JSON.stringify(labels)})`,
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
    // The site prompt (SPEC section 4.11): a card in the content script's closed shadow root, so
    // it is found, and its buttons clicked, from the pixels of the picture.

    /** How many pixels of the picture are (nearly) this colour. */
    async countColor(rgb, tolerance = 3) {
      const png = decodePng(Buffer.from(await driver.takeScreenshot(), "base64"));
      let n = 0;
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) if (closeTo(png.pixel(x, y), rgb, tolerance)) n++;
      }
      return n;
    },
    /** Whether the prompt card is on the page (its Turn on button is there). */
    async promptShowing() {
      return (await ctx.countColor(PROMPT_COLORS.on)) >= 200;
    },
    /** Waits for the prompt card to show. */
    async waitForPrompt() {
      await ctx.waitForColor(PROMPT_COLORS.on);
    },
    /**
     * Clicks the text box, as the user does to start writing in it, until its dimmed badge shows
     * (SPEC section 4.11, a site that is not on). The content script starts listening a moment
     * after the page has loaded (it asks the background script first), so a focus that comes too
     * early is repeated: the box is left and clicked again.
     */
    async focusUntilBadge(id = "box") {
      for (let attempt = 0; attempt < 8; attempt++) {
        await ctx.focusBox(id);
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          if (await ctx.badgeShows("dimmed", id)) return;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        await driver.executeScript("document.activeElement.blur()");
      }
      throw new Error(`the dimmed badge never showed on #${id}`);
    },
    /** Whether the badge of the box shows `kind` right now, read from the pixels of the picture. */
    async badgeShows(kind, id = "box") {
      const { x, y } = await ctx.badgeCenter(id);
      return closeTo(await ctx.pixelAt(x, y - 7), BADGE_COLORS[kind]);
    },
    /**
     * Focuses the box, and then clicks its dimmed badge until the prompt card shows. The badge
     * ignores clicks in its first 500 ms (SPEC section 4.11), so the harness waits a little longer.
     */
    async focusUntilPrompt(id = "box") {
      await ctx.focusUntilBadge(id);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const { x, y } = await ctx.badgeCenter(id);
      await ctx.clickAt(x, y);
      await ctx.waitForColor(PROMPT_COLORS.on);
    },
    /**
     * Focuses the box and fails if a dimmed badge or the prompt shows within `ms`; the box is left
     * again. For an excluded field, and for a site that is off.
     */
    async expectNoPrompt(id = "box", ms = 2500) {
      await ctx.focusBox(id);
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (await ctx.promptShowing()) throw new Error(`the prompt showed on #${id}`);
      if (await ctx.badgeShows("dimmed", id)) throw new Error(`a dimmed badge showed on #${id}`);
      await driver.executeScript("document.activeElement.blur()");
    },
    /**
     * Presses a button of the prompt (`on`, `later` or `off`). The card ignores clicks in its first
     * half second (SPEC section 4.11), so the harness waits for it to show and then a little longer.
     */
    async clickPrompt(choice) {
      const at = await ctx.waitForColor(PROMPT_COLORS[choice]);
      await new Promise((resolve) => setTimeout(resolve, 700));
      await ctx.clickAt(at.x, at.y);
    },
    /**
     * Fails unless the background script answers the content script's question for `host` with
     * `expected` (run on an extension page). The note of the prompt is made from this answer.
     */
    async expectSiteConfig(host, expected) {
      const answer = await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.runtime.sendMessage({ type: "page-mode-config", host: arguments[0] }).then(done);`,
        host,
      );
      if (canonicalJson(answer) !== canonicalJson(expected)) {
        throw new Error(
          `the site config is ${JSON.stringify(answer)}, not ${JSON.stringify(expected)}`,
        );
      }
    },
    /**
     * What a restart of the browser does to Not now: `storage.session` is emptied. The open pages
     * are then told, as they are by any change (run on an extension page).
     */
    async clearLater() {
      await driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.storage.session.clear()
           .then(() => browser.tabs.query({}))
           .then((tabs) => Promise.all(tabs.map((t) =>
             browser.tabs.sendMessage(t.id, { type: "settings-changed" }).catch(() => undefined))))
           .then(() => done());`,
      );
    },
    /** Starts recording the frames that content scripts register (run on an extension page). */
    async watchFrameRegistrations() {
      await driver.executeScript(
        `window.__frameKeys = [];
         browser.storage.session.onChanged.addListener((changes) => {
           for (const key of Object.keys(changes)) {
             if (key.startsWith("page-frame:")) window.__frameKeys.push(key);
           }
         });`,
      );
    },
    /** How many frames were registered since `watchFrameRegistrations` (run on the same page). */
    async frameRegistrations() {
      return driver.executeScript("return window.__frameKeys.length");
    },
    /** The keys of `storage.session` that start with `prefix` (run on an extension page). */
    async sessionKeys(prefix) {
      return driver.executeAsyncScript(
        `const done = arguments[arguments.length - 1];
         browser.storage.session.get(null).then(
           (all) => done(Object.keys(all).filter((k) => k.startsWith(arguments[0]))));`,
        prefix,
      );
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
            // What the browser showed when it failed, for the person who has to find out why.
            try {
              await mkdir(`${root}screenshots-out/failed`, { recursive: true });
              await writeFile(
                `${root}screenshots-out/failed/${name}.png`,
                Buffer.from(await driver.takeScreenshot(), "base64"),
              );
            } catch {
              // The browser is gone: there is nothing to show.
            }
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
