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
};

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

/** The sample text after a finished check (five issues, three categories). */
async function checkedSample(ctx) {
  ctx.llm.setReplies(CHECK_REPLY);
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
    async stabilise() {
      await driver.executeScript(
        `if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
         for (const animation of document.getAnimations()) {
           animation.pause();
           animation.currentTime = 0;
         }`,
      );
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
