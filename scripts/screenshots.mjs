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
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Browser, Builder, By, Key, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { FakeLLMServer, OK_REPLY } from "./fake-llm.mjs";

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
};

/** In the browser's own code: the visible entries of the open page context menu. */
const ROW_MENU_LABELS = `
  const popup = document.getElementById("contentAreaContextMenu");
  if (popup === null || popup.state !== "open") return [];
  return [...popup.children].filter((m) => m.localName === "menuitem" && !m.hidden).map((m) => m.label);
`;

/** Keys that put the caret at the start of a short text (the sample wraps to two lines). */
const TO_START = Key.ARROW_UP.repeat(6) + Key.HOME;

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

async function startBrowser(theme, zipPath) {
  const options = new firefox.Options();
  options.addArguments("-headless");
  options.setPreference(
    "extensions.webextensions.uuids",
    JSON.stringify({ [GECKO_ID]: EXTENSION_UUID }),
  );
  options.setPreference("extensions.webextOptionalPermissionPrompts", false);
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

/** Sizes the window so that the page area, which a screenshot captures, is WIDTH x HEIGHT. */
async function sizeViewport(driver) {
  const window = driver.manage().window();
  await window.setRect({ width: WIDTH, height: HEIGHT });
  const [innerWidth, innerHeight] = await driver.executeScript(
    "return [window.innerWidth, window.innerHeight]",
  );
  const rect = await window.getRect();
  await window.setRect({
    width: rect.width + (WIDTH - innerWidth),
    height: rect.height + (HEIGHT - innerHeight),
  });
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

function makeContext(name, scenario, driver, llm, policy) {
  const ctx = {
    driver,
    llm,
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
      await sizeViewport(driver);
      await driver.wait(
        async () => (await driver.executeScript("return document.readyState")) === "complete",
        PAGE_TIMEOUT_MS,
      );
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
    async screenshot() {
      const png = Buffer.from(await driver.takeScreenshot(), "base64");
      const { width, height } = pngSize(png);
      if (width !== WIDTH || height !== HEIGHT) {
        throw new Error(`the screenshot is ${width}x${height}, not ${WIDTH}x${HEIGHT}`);
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
      await sizeViewport(driver);
      await driver.wait(
        async () => (await driver.executeScript("return document.readyState")) === "complete",
        PAGE_TIMEOUT_MS,
      );
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
    async scrollTo(id) {
      await driver.executeScript("document.getElementById(arguments[0]).scrollIntoView()", id);
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
  const failures = [];
  try {
    // The colour scheme is a per-profile preference, so each theme gets its own browser.
    for (const theme of ["light", "dark"]) {
      const group = names.filter((name) => SCENARIOS[name].theme === theme);
      if (group.length === 0) continue;
      let driver;
      try {
        driver = await startBrowser(theme, zipPath);
      } catch (err) {
        for (const name of group) failures.push({ name, err });
        continue;
      }
      try {
        for (const name of group) {
          console.log(`scenario ${name}`);
          llm.reset();
          try {
            const ctx = makeContext(name, SCENARIOS[name], driver, llm, policy);
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
  }

  for (const { name, err } of failures) {
    console.error(`FAILED ${name}: ${err instanceof Error ? err.message : String(err)}`);
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
