// Screenshot harness (docs/IMPLEMENTATION.md, "Screenshot harness").
//
//   npm run screenshots              all scenarios
//   npm run screenshots -- <name>    one scenario
//
// It builds dist/, zips it with web-ext, starts a fake LLM server on 127.0.0.1, starts headless
// Firefox through selenium-webdriver (Selenium Manager fetches geckodriver), installs the zip as a
// temporary add-on, and runs each scenario. A scenario drives the real pages and saves a 1280x800
// PNG under docs/screenshots/. The run exits with 1, after printing the reason, if one fails.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Browser, Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { FakeLLMServer } from "./fake-llm.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

const GECKO_ID = "english-tutor@rm4n0s.dev";
// A fixed internal UUID, so that the pages have known moz-extension:// addresses.
const EXTENSION_UUID = "7b1f3c2e-5d0a-4c8e-9b61-2f4e8a1d6c35";
const ZIP_NAME = "english-tutor-screenshots.zip";
const WIDTH = 1280;
const HEIGHT = 800;
const PAGE_TIMEOUT_MS = 15_000;

// `layout.css.prefers-color-scheme.content-override`: 0 = dark, 1 = light, 2 = follow the system.
// Verified in Firefox 159 by the "dark" scenarios, which fail unless the page matches the dark scheme.
const COLOR_SCHEME_PREF = { light: 1, dark: 0 };

/**
 * Scenarios. `theme` picks the browser session (the preference is per profile), `dir` is the folder
 * under docs/screenshots/, and `run(ctx)` brings the page to its state and calls `ctx.screenshot()`.
 * The context has: `driver`, `llm` (the FakeLLMServer, to choose replies), `open(page)`, `screenshot()`
 * and `expectTheme()`.
 */
const SCENARIOS = {
  "tutor-empty": {
    theme: "light",
    dir: "step-02-skeleton",
    async run(ctx) {
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "tutor-empty-dark": {
    theme: "dark",
    dir: "step-02-skeleton",
    async run(ctx) {
      await ctx.open("tutor.html");
      await ctx.driver.wait(until.elementLocated(By.id("editor")), PAGE_TIMEOUT_MS);
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
  "options-empty": {
    theme: "light",
    dir: "step-02-skeleton",
    async run(ctx) {
      await ctx.open("options.html");
      await ctx.driver.wait(until.elementLocated(By.id("llms")), PAGE_TIMEOUT_MS);
      await ctx.expectTheme();
      await ctx.screenshot();
    },
  },
};

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

function makeContext(name, scenario, driver, llm) {
  return {
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
      const dir = `${root}docs/screenshots/${scenario.dir}`;
      await mkdir(dir, { recursive: true });
      await writeFile(`${dir}/${name}.png`, png);
      console.log(`  wrote docs/screenshots/${scenario.dir}/${name}.png`);
    },
  };
}

async function main() {
  const wanted = process.argv.slice(2).filter((arg) => arg !== "--");
  const names = wanted.length > 0 ? wanted : Object.keys(SCENARIOS);
  const unknown = names.filter((name) => !(name in SCENARIOS));
  if (unknown.length > 0) {
    console.error(
      `unknown scenario: ${unknown.join(", ")}. Known: ${Object.keys(SCENARIOS).join(", ")}`,
    );
    return 1;
  }

  const zipPath = await buildAndZip();
  const llm = new FakeLLMServer();
  await llm.start();
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
            await SCENARIOS[name].run(makeContext(name, SCENARIOS[name], driver, llm));
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
