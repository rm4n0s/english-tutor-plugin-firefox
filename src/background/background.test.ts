import { describe, expect, it } from "vitest";
import { CountingRandom } from "../core/analysis/testing/helpers";
import { HANDOFF_MAX_AGE_MS, HandoffStore, parseHandoffFragment } from "../core/handoff";
import { Logger, type LogFields } from "../core/log";
import { FakeClock } from "../core/testing/fake-clock";
import { freshStore } from "../core/store/testing/db";
import { FakeChannelBus } from "../platform/testing/fake-channel";
import {
  FakeBackgroundMessages,
  FakeContentScripts,
  FakePageModePermission,
  FakePageTabs,
} from "../platform/testing/fake-page-mode";
import {
  FakeBackgroundMenus,
  FakeButton,
  FakeCommands,
  FakeLifecycle,
  FakeNotifier,
  FakeOptionsOpener,
  FakeTutorTabs,
} from "../platform/testing/fake-background";
import { FakeSessionStorage } from "../platform/testing/fake-session-storage";
import type { TutorTabInfo } from "../platform/tutor-tabs";
import {
  latestTutorTab,
  MENU_IDS,
  MENU_ITEMS,
  OPEN_TUTOR_COMMAND,
  startBackground,
} from "./background";
import { PageModeBackend } from "./page-mode";
import { FrameClaims } from "../core/page-mode/frame-claims";
import { ignoreKey, SessionIgnoreSet } from "../platform/ignore-set";

const NOW = 1_000_000;

function tab(tabId: number, overrides: Partial<TutorTabInfo> = {}): TutorTabInfo {
  return { tabId, windowId: tabId * 10, focusedAt: 0, dirty: false, ...overrides };
}

/** Everything the background script gets, as fakes. Calling it again is a restart of the event page. */
function setup(
  shared: {
    session?: FakeSessionStorage;
    clock?: FakeClock;
    store?: ReturnType<typeof freshStore>;
    permission?: FakePageModePermission;
    scripts?: FakeContentScripts;
  } = {},
) {
  const session = shared.session ?? new FakeSessionStorage();
  const clock = shared.clock ?? new FakeClock(NOW);
  const button = new FakeButton();
  const commands = new FakeCommands();
  const menus = new FakeBackgroundMenus();
  const tabs = new FakeTutorTabs();
  const notifier = new FakeNotifier();
  const lifecycle = new FakeLifecycle();
  const options = new FakeOptionsOpener();
  const logged: { message: string; fields: LogFields | undefined }[] = [];
  const record = (message: string, fields?: LogFields) => {
    logged.push({ message, fields });
  };
  const log = new Logger({ debug: record, info: record, warn: record, error: record });
  const handoff = new HandoffStore(session, clock, new CountingRandom());
  // Page mode: a store that is opened when first needed, as the real script does.
  const stored = shared.store ?? freshStore();
  const permission = shared.permission ?? new FakePageModePermission();
  const scripts = shared.scripts ?? new FakeContentScripts();
  const pageTabs = new FakePageTabs();
  const bus = new FakeChannelBus();
  const messageBus = new FakeBackgroundMessages();
  const pageMode = new PageModeBackend({
    settings: async () => (await stored).store,
    permission,
    scripts,
    tabs: pageTabs,
    session,
    channel: bus.connect(),
    log,
  });
  startBackground({
    button,
    commands,
    menus,
    tabs,
    handoff,
    notifier,
    lifecycle,
    options,
    pageMode,
    frameClaims: new FrameClaims(session, clock),
    ignore: new SessionIgnoreSet(session),
    permission,
    messages: messageBus,
    log,
  });
  return {
    session,
    clock,
    button,
    commands,
    menus,
    tabs,
    notifier,
    lifecycle,
    options,
    logged,
    stored,
    permission,
    scripts,
    pageTabs,
    messageBus,
  };
}

const messages = (logged: { message: string }[]) =>
  logged.map((l) => l.message.replace(/^\[english-tutor\] /, ""));

/** Lets the promises of the listeners finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("registering the listeners", () => {
  it("registers them all synchronously, with nothing awaited, and keeps no state between runs", async () => {
    const first = setup();
    // Right after the call, before any promise settled: every event is already handled.
    first.button.click();
    first.commands.press(OPEN_TUTOR_COMMAND);
    first.lifecycle.install();
    first.menus.choose(MENU_IDS.preferences);
    first.notifier.click("check-1");
    first.lifecycle.updateAvailable();
    await settle();
    expect(first.tabs.pings).toBeGreaterThan(0);
    expect(first.menus.installs).toBe(1);
    expect(first.options.opened).toBe(1);

    // The event page was stopped and starts again: a hand-off stored by the first run is there.
    first.menus.choose(MENU_IDS.webCheck, { selectionText: "Some text." });
    await settle();
    const second = setup({ session: first.session, clock: first.clock });
    expect([...second.session.values.keys()].filter((k) => k.startsWith("handoff:"))).toHaveLength(
      1,
    );
  });
});

describe("latestTutorTab", () => {
  it.each([
    { name: "no tabs", tabs: [], expected: undefined },
    { name: "one tab", tabs: [tab(4, { focusedAt: 5 })], expected: 4 },
    {
      name: "the one focused last",
      tabs: [tab(1, { focusedAt: 300 }), tab(2, { focusedAt: 900 }), tab(3, { focusedAt: 100 })],
      expected: 2,
    },
    {
      name: "the higher tab id on a tie",
      tabs: [tab(9, { focusedAt: 50 }), tab(3, { focusedAt: 50 })],
      expected: 9,
    },
    { name: "tabs never focused", tabs: [tab(2), tab(5)], expected: 5 },
  ])("picks $name", ({ tabs, expected }) => {
    expect(latestTutorTab(tabs)?.tabId).toBe(expected);
  });
});

describe("the toolbar button and the open-tutor command", () => {
  const trigger = {
    "the toolbar button": (s: ReturnType<typeof setup>) => {
      s.button.click();
    },
    "the open-tutor command": (s: ReturnType<typeof setup>) => {
      s.commands.press(OPEN_TUTOR_COMMAND);
    },
  };

  describe.each(Object.entries(trigger))("%s", (_, fire) => {
    it("opens a tutor tab when none is open", async () => {
      const s = setup();
      fire(s);
      await settle();
      expect(s.tabs.opened).toEqual([{}]);
      expect(s.tabs.focused).toEqual([]);
    });

    it("focuses the tab and the window of the tutor tab focused last, and opens nothing", async () => {
      const s = setup();
      s.tabs.pages = [
        tab(1, { focusedAt: 100, windowId: 11 }),
        tab(2, { focusedAt: 900, windowId: 22 }),
        tab(3, { focusedAt: 500, windowId: 11 }),
      ];
      fire(s);
      await settle();
      expect(s.tabs.focused).toEqual([{ tabId: 2, windowId: 22 }]);
      expect(s.tabs.opened).toEqual([]);
    });

    it("logs a failure to ask the tabs instead of leaving a rejected promise", async () => {
      const s = setup();
      s.tabs.pingFails = new Error("no window");
      fire(s);
      await settle();
      expect(s.logged).toHaveLength(1);
      expect(s.logged[0]?.fields).toEqual({ err: { name: "Error", message: "no window" } });
    });
  });

  it("ignores other commands", async () => {
    const s = setup();
    s.commands.press("something-else");
    await settle();
    expect(s.tabs.pings).toBe(0);
  });
});

describe("menus", () => {
  it.each([
    {
      event: "the extension is installed or updated",
      fire: (s: ReturnType<typeof setup>) => {
        s.lifecycle.install();
      },
    },
    {
      event: "the browser starts",
      fire: (s: ReturnType<typeof setup>) => {
        s.lifecycle.startBrowser();
      },
    },
  ])("makes the entries when $event", async ({ fire }) => {
    const s = setup();
    expect(s.menus.entries.size).toBe(0);
    fire(s);
    await settle();
    expect([...s.menus.entries.keys()]).toEqual(MENU_ITEMS.map((item) => item.id));
  });

  it("makes the web page submenu and the button's entries", () => {
    expect(
      MENU_ITEMS.map((item) => [item.id, item.title, item.contexts.join(), item.parentId]),
    ).toEqual([
      [MENU_IDS.webParent, "English Tutor", "selection", undefined],
      [MENU_IDS.webCheck, "Check with English Tutor", "selection", MENU_IDS.webParent],
      [
        MENU_IDS.webAlternatives,
        "Alternatives with English Tutor",
        "selection",
        MENU_IDS.webParent,
      ],
      [MENU_IDS.newTab, "New tutor tab", "action", undefined],
      [MENU_IDS.preferences, "Preferences", "action", undefined],
      [MENU_IDS.pageModeSite, "Page mode on this site", "action", undefined],
    ]);
  });

  it("logs a failure to make the entries", async () => {
    const s = setup();
    s.menus.failWith = new Error("menus broke");
    s.lifecycle.install();
    await settle();
    expect(messages(s.logged)).toEqual(["could not make the menus"]);
  });

  it("New tutor tab opens a tab even when one exists, and Preferences opens the options page", async () => {
    const s = setup();
    s.tabs.pages = [tab(1, { focusedAt: 5 })];
    s.menus.choose(MENU_IDS.newTab);
    s.menus.choose(MENU_IDS.preferences);
    await settle();
    expect(s.tabs.opened).toEqual([{}]);
    expect(s.tabs.focused).toEqual([]);
    expect(s.options.opened).toBe(1);
  });

  it("ignores the entries of the tutor pages", async () => {
    const s = setup();
    s.menus.choose("editor-check-7", { selectionText: "Some text." });
    s.menus.choose("row-not-error-7");
    await settle();
    expect(s.tabs.opened).toEqual([]);
    expect(s.session.values.size).toBe(0);
  });
});

describe("the web page menu", () => {
  it("is limited to web pages, so that it does not show in the tutor page's own menu", () => {
    const selection = MENU_ITEMS.filter((item) => item.contexts.includes("selection"));
    expect(selection).toHaveLength(3);
    for (const item of selection) {
      expect(item.documentUrlPatterns).toEqual(["http://*/*", "https://*/*", "file:///*"]);
      expect(item.documentUrlPatterns?.some((p) => p.startsWith("moz-extension"))).toBe(false);
    }
    // The button's entries have no page.
    expect(
      MENU_ITEMS.filter((item) => item.contexts.includes("action")).map(
        (item) => item.documentUrlPatterns,
      ),
    ).toEqual([undefined, undefined, undefined]);
  });

  describe.each([
    { entry: MENU_IDS.webCheck, action: "check" },
    { entry: MENU_IDS.webAlternatives, action: "alternatives" },
  ])("choosing $entry", ({ entry, action }) => {
    it("stores the text in storage.session and opens a tutor tab next to the page with only the key in the address", async () => {
      const s = setup();
      const text = "I has a idea about the plan & it's good #1.";
      s.menus.choose(entry, { selectionText: text, tab: { tabId: 3, windowId: 8, index: 4 } });
      await settle();
      expect(s.tabs.opened).toHaveLength(1);
      const opened = s.tabs.opened[0];
      expect(opened?.after).toEqual({ windowId: 8, index: 4 });
      const key = parseHandoffFragment(opened?.fragment ?? "");
      expect(key).toBeDefined();
      expect(opened?.fragment).not.toContain("idea");
      expect([...s.session.values.entries()]).toEqual([
        [`handoff:${key ?? ""}`, { text, action, at: NOW }],
      ]);
    });

    it.each([undefined, "", "   \n\t"])("does nothing for the selection %j", async (selection) => {
      const s = setup();
      s.menus.choose(entry, { selectionText: selection });
      await settle();
      expect(s.tabs.opened).toEqual([]);
      expect(s.session.values.size).toBe(0);
    });

    it("hands over a long selection too: the menu cannot know its length, and the tutor page says so for Alternatives", async () => {
      const s = setup();
      const text = Array.from({ length: 700 }, () => "word").join(" ");
      s.menus.choose(entry, { selectionText: text });
      await settle();
      expect(s.tabs.opened).toHaveLength(1);
      expect([...s.session.values.values()]).toEqual([{ text, action, at: NOW }]);
    });

    it("opens the tab where the browser decides when the page's tab is unknown", async () => {
      const s = setup();
      s.menus.choose(entry, { selectionText: "Some text." });
      await settle();
      expect(s.tabs.opened).toHaveLength(1);
      expect(s.tabs.opened[0]?.after).toBeUndefined();
    });

    it("opens no tab and logs when the text cannot be stored", async () => {
      const s = setup();
      s.session.failWith = new Error("storage broke");
      s.menus.choose(entry, { selectionText: "Some text." });
      await settle();
      expect(s.tabs.opened).toEqual([]);
      expect(messages(s.logged)).toContain("could not send the selection to the tutor page");
      expect(JSON.stringify(s.logged)).not.toContain("Some text");
    });
  });
});

describe("hand-off expiry", () => {
  const entry = (at: number) => ({ text: "T", action: "check", at });

  it("deletes the entries older than 5 minutes when the background script runs, and only those", async () => {
    const session = new FakeSessionStorage();
    session.values.set("handoff:old", entry(NOW - HANDOFF_MAX_AGE_MS - 1));
    session.values.set("handoff:edge", entry(NOW - HANDOFF_MAX_AGE_MS));
    session.values.set("handoff:new", entry(NOW - 1000));
    session.values.set("handoff:broken", { text: 1 });
    session.values.set("ignore:session:a|ff", true);
    setup({ session });
    await settle();
    expect([...session.values.keys()].sort()).toEqual([
      "handoff:edge",
      "handoff:new",
      "ignore:session:a|ff",
    ]);
  });

  it("deletes them on every start of the event page", async () => {
    const session = new FakeSessionStorage();
    const clock = new FakeClock(NOW);
    session.values.set("handoff:a", entry(NOW));
    setup({ session, clock });
    await settle();
    expect(session.values.has("handoff:a")).toBe(true);
    clock.advance(HANDOFF_MAX_AGE_MS + 1);
    setup({ session, clock });
    await settle();
    expect(session.values.has("handoff:a")).toBe(false);
  });

  it("logs a storage failure", async () => {
    const session = new FakeSessionStorage();
    session.failWith = new Error("storage broke");
    const s = setup({ session });
    await settle();
    expect(messages(s.logged)).toEqual([
      "could not delete old hand-off entries",
      "could not delete old page-mode frame entries",
    ]);
  });
});

describe("notification clicks", () => {
  it("focuses the tab and the window of the finished check and clears the notification", async () => {
    const s = setup();
    s.tabs.pages = [tab(5, { windowId: 50 }), tab(6, { windowId: 60 })];
    s.notifier.shown.set("check-6", { title: "Check finished", message: "3 issues" });
    s.notifier.click("check-6");
    await settle();
    expect(s.tabs.focused).toEqual([{ tabId: 6, windowId: 60 }]);
    expect(s.notifier.cleared).toEqual(["check-6"]);
  });

  it("focuses nothing when the tab is gone, and still clears the notification", async () => {
    const s = setup();
    s.tabs.pages = [tab(5)];
    s.notifier.click("check-9");
    await settle();
    expect(s.tabs.focused).toEqual([]);
    expect(s.notifier.cleared).toEqual(["check-9"]);
  });

  it.each(["other-9", "check-", "check-x", "xcheck-4"])(
    "ignores the notification %j",
    async (id) => {
      const s = setup();
      s.tabs.pages = [tab(4)];
      s.notifier.click(id);
      await settle();
      expect(s.tabs.pings).toBe(0);
      expect(s.tabs.focused).toEqual([]);
    },
  );

  it("logs a failure", async () => {
    const s = setup();
    s.tabs.pingFails = new Error("no tabs");
    s.notifier.click("check-1");
    await settle();
    expect(messages(s.logged)).toEqual(["could not show the tab of the finished check"]);
  });
});

describe("updates", () => {
  it.each([
    { name: "there are no tutor tabs", pages: [] },
    { name: "no tutor tab has unsaved changes", pages: [tab(1), tab(2, { focusedAt: 9 })] },
  ])("reloads the extension when $name", async ({ pages }) => {
    const s = setup();
    s.tabs.pages = pages;
    s.lifecycle.updateAvailable();
    await settle();
    expect(s.lifecycle.reloads).toBe(1);
  });

  it.each([
    { name: "one of two tabs has unsaved changes", pages: [tab(1), tab(2, { dirty: true })] },
    { name: "the only tab has unsaved changes", pages: [tab(1, { dirty: true })] },
  ])("waits when $name", async ({ pages }) => {
    const s = setup();
    s.tabs.pages = pages;
    s.lifecycle.updateAvailable();
    await settle();
    expect(s.lifecycle.reloads).toBe(0);
    expect(messages(s.logged)).toEqual(["an update waits for the tutor tabs with unsaved changes"]);
  });

  it("waits, and logs, when the tutor pages cannot be asked", async () => {
    const s = setup();
    s.tabs.pingFails = new Error("no tabs");
    s.lifecycle.updateAvailable();
    await settle();
    expect(s.lifecycle.reloads).toBe(0);
    expect(messages(s.logged)).toEqual(["could not ask the tutor pages about the update"]);
  });
});

describe("page mode", () => {
  const SITE = "https://www.Example.com/some/page?x=1";

  /** Page mode on, with the permission, as the options page leaves it. */
  async function turnedOn(s: ReturnType<typeof setup>): Promise<void> {
    (await s.stored).store.setSetting("page_mode", true).catch(() => undefined);
    await settle();
    s.permission.granted = true;
  }

  const settings = async (s: ReturnType<typeof setup>) => (await s.stored).store;

  describe("keeping the registration in step with the setting and the permission", () => {
    describe.each([
      {
        event: "the extension is installed",
        fire: (s: ReturnType<typeof setup>) => {
          s.lifecycle.install();
        },
      },
      {
        event: "the browser starts",
        fire: (s: ReturnType<typeof setup>) => {
          s.lifecycle.startBrowser();
        },
      },
    ])("when $event", ({ fire }) => {
      it.each([
        {
          name: "page mode on with the permission registers the script",
          on: true,
          granted: true,
          registered: false,
          expected: ["register"],
        },
        {
          name: "an already registered script is left alone",
          on: true,
          granted: true,
          registered: true,
          expected: [],
        },
        {
          name: "page mode off unregisters a script that is there",
          on: false,
          granted: true,
          registered: true,
          expected: ["unregister"],
        },
        {
          name: "page mode off with no script does nothing",
          on: false,
          granted: false,
          registered: false,
          expected: [],
        },
      ])("$name", async ({ on, granted, registered, expected }) => {
        const s = setup();
        await (await settings(s)).setSetting("page_mode", on);
        s.permission.granted = granted;
        s.scripts.registered = registered;
        fire(s);
        await settle();
        await settle();
        expect(s.scripts.calls).toEqual(expected);
        // Nobody is told at start-up: no page has the script yet.
        expect(s.pageTabs.sent).toEqual([]);
      });

      it("switches page mode off when the permission was withdrawn while the browser was closed", async () => {
        const s = setup();
        await (await settings(s)).setSetting("page_mode", true);
        s.permission.granted = false;
        s.scripts.registered = true;
        fire(s);
        await settle();
        await settle();
        expect(await (await settings(s)).getSetting("page_mode")).toBe(false);
        expect(s.scripts.registered).toBe(false);
      });
    });

    it("on permissions.onRemoved switches page mode off and tells the open pages", async () => {
      const s = setup();
      await turnedOn(s);
      s.scripts.registered = true;
      s.permission.withdraw();
      await settle();
      await settle();
      expect(await (await settings(s)).getSetting("page_mode")).toBe(false);
      expect(s.scripts.calls).toEqual(["unregister"]);
      expect(s.pageTabs.sent).toEqual(["page-mode-off"]);
    });

    it("logs a failed registration instead of leaving a rejected promise", async () => {
      const s = setup();
      await turnedOn(s);
      s.scripts.failWith = new Error("no scripting");
      s.lifecycle.install();
      await settle();
      await settle();
      expect(messages(s.logged)).toContain("could not bring page mode in step with its setting");
    });
  });

  describe("the options page's request to apply the setting", () => {
    it("registers the script and tells the pages to ask again when page mode is on", async () => {
      const s = setup();
      await turnedOn(s);
      const reply = await s.messageBus.send({ type: "page-mode-apply" });
      expect(reply).toEqual({ answered: true, answer: { ok: true } });
      expect(s.scripts.calls).toEqual(["register"]);
      expect(s.pageTabs.sent).toEqual(["settings-changed"]);
    });

    it("unregisters the script and sends page-mode-off when it is off", async () => {
      const s = setup();
      s.scripts.registered = true;
      s.permission.granted = true;
      await s.messageBus.send({ type: "page-mode-apply" });
      expect(s.scripts.calls).toEqual(["unregister"]);
      expect(s.pageTabs.sent).toEqual(["page-mode-off"]);
    });

    it("is answered only for the extension's own senders", async () => {
      const s = setup();
      await turnedOn(s);
      const reply = await s.messageBus.send({ type: "page-mode-apply" }, { ownExtension: false });
      expect(reply.answered).toBe(false);
      expect(s.scripts.calls).toEqual([]);
    });
  });

  describe("the content script's questions", () => {
    const FAKE_SERVER = { server: "api.example.com", local: false };

    async function addLLM(
      s: ReturnType<typeof setup>,
      name: string,
      baseUrl: string,
      select = false,
    ): Promise<void> {
      const store = await settings(s);
      const saved = await store.createConfig({
        name,
        provider: "openai-compatible",
        model: "m",
        base_url: baseUrl,
        api_key: "SECRET-KEY",
        temperature: null,
        timeout_seconds: null,
        max_parallel: 1,
        no_thinking: true,
      });
      if (select) await store.setSetting("selected_llm_id", saved.id);
    }

    it.each([
      {
        name: "page mode not offered",
        offered: false,
        sites: {},
        host: "example.com",
        state: "off",
      },
      {
        name: "page mode not offered, whatever the site says",
        offered: false,
        sites: { "example.com": "on" },
        host: "example.com",
        state: "off",
      },
      {
        name: "a site with no choice",
        offered: true,
        sites: {},
        host: "example.com",
        state: "ask",
      },
      {
        name: "a site that is on",
        offered: true,
        sites: { "example.com": "on" },
        host: "example.com",
        state: "on",
      },
      {
        name: "a site that is off",
        offered: true,
        sites: { "example.com": "off" },
        host: "example.com",
        state: "off",
      },
      {
        name: "the host compared in lower case",
        offered: true,
        sites: { "example.com": "on" },
        host: "EXAMPLE.com",
        state: "on",
      },
      {
        name: "a subdomain of a site that is on (a site is the exact host)",
        offered: true,
        sites: { "example.com": "on" },
        host: "www.example.com",
        state: "ask",
      },
      {
        name: "the parent of a site that is on",
        offered: true,
        sites: { "www.example.com": "on" },
        host: "example.com",
        state: "ask",
      },
      { name: "no host (a file)", offered: true, sites: {}, host: "", state: "off" },
    ])("answers $state for $name", async ({ offered, sites, host, state }) => {
      const s = setup();
      const store = await settings(s);
      await store.setSetting("page_mode", offered);
      await store.setSetting("page_mode_sites", sites as Record<string, "on" | "off">);
      const reply = await s.messageBus.send({ type: "page-mode-config", host });
      expect(reply.answered).toBe(true);
      expect((reply.answer as { state: string }).state).toBe(state);
    });

    it("answers later for a site answered Not now, and ask for another one", async () => {
      const s = setup();
      await (await settings(s)).setSetting("page_mode", true);
      s.session.values.set("page-mode-later:example.com", true);
      expect(
        (await s.messageBus.send({ type: "page-mode-config", host: "example.com" })).answer,
      ).toEqual({ state: "later" });
      expect(
        (await s.messageBus.send({ type: "page-mode-config", host: "other.org" })).answer,
      ).toEqual({ state: "ask", llm: null });
    });

    it("a choice on the site wins over Not now", async () => {
      const s = setup();
      const store = await settings(s);
      await store.setSetting("page_mode", true);
      await store.setSetting("page_mode_sites", { "example.com": "off" });
      s.session.values.set("page-mode-later:example.com", true);
      expect(
        (await s.messageBus.send({ type: "page-mode-config", host: "example.com" })).answer,
      ).toEqual({ state: "off" });
    });

    it.each([
      { name: "no LLM yet", llms: [], selected: undefined, expected: null },
      {
        name: "the only LLM",
        llms: [["A", "https://api.example.com/v1"]],
        selected: undefined,
        expected: FAKE_SERVER,
      },
      {
        name: "the first LLM by name when none is selected",
        llms: [
          ["Zeta", "https://zeta.example.com/v1"],
          ["Alpha", "https://alpha.example.com:8443/v1"],
        ],
        selected: undefined,
        expected: { server: "alpha.example.com:8443", local: false },
      },
      {
        name: "the selected LLM",
        llms: [
          ["Zeta", "https://zeta.example.com/v1"],
          ["Alpha", "https://alpha.example.com:8443/v1"],
        ],
        selected: "Zeta",
        expected: { server: "zeta.example.com", local: false },
      },
      {
        name: "a server on this computer",
        llms: [["Local", "http://localhost:11434/v1"]],
        selected: undefined,
        expected: { server: "localhost:11434", local: true },
      },
    ])(
      "tells the prompt the server of $name, and never a key or a path",
      async ({ llms, selected, expected }) => {
        const s = setup();
        await (await settings(s)).setSetting("page_mode", true);
        for (const [name, url] of llms as [string, string][])
          await addLLM(s, name, url, name === selected);
        const reply = await s.messageBus.send({ type: "page-mode-config", host: "example.com" });
        expect(reply.answer).toEqual({ state: "ask", llm: expected });
        expect(JSON.stringify(reply.answer)).not.toContain("SECRET-KEY");
        expect(JSON.stringify(reply.answer)).not.toContain("/v1");
      },
    );

    it("tells no server for a site that is not asked about", async () => {
      const s = setup();
      const store = await settings(s);
      await store.setSetting("page_mode", true);
      await store.setSetting("page_mode_sites", { "example.com": "on" });
      await addLLM(s, "A", "https://api.example.com/v1");
      const reply = await s.messageBus.send({ type: "page-mode-config", host: "example.com" });
      expect(reply.answer).toEqual({ state: "on" });
    });

    it.each([
      { name: "no host", message: { type: "page-mode-config" } },
      { name: "a host that is not a string", message: { type: "page-mode-config", host: 5 } },
      {
        name: "a host that is too long",
        message: { type: "page-mode-config", host: "x".repeat(254) },
      },
    ])("leaves $name unanswered", async ({ message }) => {
      const s = setup();
      expect((await s.messageBus.send(message)).answered).toBe(false);
    });

    it.each([
      { name: "tutor-ping", message: { type: "tutor-ping" } },
      { name: "a string", message: "page-mode-config" },
      { name: "null", message: null },
      { name: "an unknown type", message: { type: "something" } },
    ])("never answers $name", async ({ message }) => {
      const s = setup();
      expect((await s.messageBus.send(message)).answered).toBe(false);
    });
  });

  describe("the choice of the prompt", () => {
    const TAB = { id: 7, windowId: 4, index: 2 };
    const send = (
      s: ReturnType<typeof setup>,
      choice: unknown,
      overrides: { host?: string; url?: string | undefined; tab?: typeof TAB | undefined } = {},
    ) =>
      s.messageBus.send(
        { type: "page-mode-site", host: overrides.host ?? "www.example.com", choice },
        {
          url: "url" in overrides ? overrides.url : SITE,
          tab: "tab" in overrides ? overrides.tab : TAB,
        },
      );

    async function offered(s: ReturnType<typeof setup>): Promise<void> {
      await (await settings(s)).setSetting("page_mode", true);
    }

    it.each([
      { choice: "on", expected: { "www.example.com": "on" } },
      { choice: "off", expected: { "www.example.com": "off" } },
    ])("stores $choice, announces it and tells the open pages", async ({ choice, expected }) => {
      const s = setup();
      await offered(s);
      const reply = await send(s, choice);
      expect(reply).toEqual({ answered: true, answer: { ok: true } });
      expect(await (await settings(s)).getSetting("page_mode_sites")).toEqual(expected);
      expect(s.pageTabs.sent).toEqual(["settings-changed"]);
    });

    it("keeps the other sites' choices", async () => {
      const s = setup();
      await offered(s);
      await (await settings(s)).setSetting("page_mode_sites", { "other.org": "off" });
      await send(s, "on");
      expect(await (await settings(s)).getSetting("page_mode_sites")).toEqual({
        "other.org": "off",
        "www.example.com": "on",
      });
    });

    it("remembers Not now in storage.session only, until the browser restarts", async () => {
      const s = setup();
      await offered(s);
      const reply = await send(s, "later");
      expect(reply.answer).toEqual({ ok: true });
      expect(s.session.values.get("page-mode-later:www.example.com")).toBe(true);
      expect(await (await settings(s)).getSetting("page_mode_sites")).toEqual({});
      expect(s.pageTabs.sent).toEqual(["settings-changed"]);
      // The browser restarts: storage.session is empty, and the site is asked again.
      s.session.values.clear();
      expect(
        (await s.messageBus.send({ type: "page-mode-config", host: "www.example.com" })).answer,
      ).toEqual({ state: "ask", llm: null });
    });

    it.each(["on", "off"])("%s forgets an earlier Not now", async (choice) => {
      const s = setup();
      await offered(s);
      await send(s, "later");
      await send(s, choice);
      expect(s.session.values.has("page-mode-later:www.example.com")).toBe(false);
    });

    it.each([
      {
        name: "page mode that is not offered",
        setup: false,
        url: SITE,
        tab: TAB,
        host: "www.example.com",
        choice: "on",
      },
      {
        name: "a host that is not the page's",
        setup: true,
        url: SITE,
        tab: TAB,
        host: "evil.org",
        choice: "on",
      },
      {
        name: "a page that is not http or https",
        setup: true,
        url: "about:blank",
        tab: TAB,
        host: "www.example.com",
        choice: "on",
      },
      {
        name: "a sender with no address",
        setup: true,
        url: undefined,
        tab: TAB,
        host: "www.example.com",
        choice: "on",
      },
    ])("takes nothing for $name", async ({ setup: on, url, tab, host, choice }) => {
      const s = setup();
      if (on) await offered(s);
      const reply = await send(s, choice, { host, url, tab });
      expect(reply).toEqual({ answered: true, answer: { ok: false } });
      expect(await (await settings(s)).getSetting("page_mode_sites")).toEqual({});
      expect([...s.session.values.keys()]).toEqual([]);
      expect(s.pageTabs.sent).toEqual([]);
    });

    it.each([
      { name: "an unknown choice", choice: "ask", overrides: {} },
      { name: "no choice", choice: undefined, overrides: {} },
      { name: "an upper-case host", choice: "on", overrides: { host: "WWW.example.com" } },
      {
        name: "a sender without a tab (an extension page)",
        choice: "on",
        overrides: { tab: undefined },
      },
    ])("leaves $name unanswered", async ({ choice, overrides }) => {
      const s = setup();
      await offered(s);
      const reply = await send(s, choice, overrides);
      expect(reply.answered).toBe(false);
      expect(await (await settings(s)).getSetting("page_mode_sites")).toEqual({});
    });

    it("is answered only for the extension's own senders", async () => {
      const s = setup();
      await offered(s);
      const reply = await s.messageBus.send(
        { type: "page-mode-site", host: "www.example.com", choice: "on" },
        { ownExtension: false, url: SITE, tab: TAB },
      );
      expect(reply.answered).toBe(false);
      expect(await (await settings(s)).getSetting("page_mode_sites")).toEqual({});
    });
  });

  describe("Open in English Tutor from a blocked badge", () => {
    it("stores the text as a hand-off and opens a tutor tab after the sender's tab", async () => {
      const s = setup();
      const reply = await s.messageBus.send(
        { type: "page-mode-open-tutor", text: "I has a idea." },
        { tab: { id: 7, windowId: 4, index: 2 } },
      );
      expect(reply.answer).toEqual({ ok: true });
      expect(s.tabs.opened).toHaveLength(1);
      expect(s.tabs.opened[0]?.after).toEqual({ windowId: 4, index: 2 });
      expect([...s.session.values.values()]).toEqual([
        { text: "I has a idea.", action: "check", at: NOW },
      ]);
    });

    it.each([
      { name: "an empty text", text: "" },
      { name: "white space", text: " \n " },
      { name: "a text that is too long", text: "x".repeat(200_001) },
      { name: "a text that is not a string", text: 5 },
    ])("ignores $name", async ({ text }) => {
      const s = setup();
      const reply = await s.messageBus.send({ type: "page-mode-open-tutor", text });
      expect(reply.answered).toBe(false);
      expect(s.tabs.opened).toEqual([]);
    });

    it("ignores a sender that is not the extension's own code", async () => {
      const s = setup();
      await s.messageBus.send(
        { type: "page-mode-open-tutor", text: "Some text." },
        { ownExtension: false },
      );
      expect(s.tabs.opened).toEqual([]);
    });
  });

  describe("the options link of the issues dialog", () => {
    it("opens the options page for the frame of a tab", async () => {
      const s = setup();
      const reply = await s.messageBus.send(
        { type: "page-mode-open-options" },
        { tab: { id: 7, windowId: 4, index: 2 } },
      );
      expect(reply.answer).toEqual({ ok: true });
      expect(s.options.opened).toBe(1);
    });

    it.each([
      { name: "a message from no tab", sender: {} },
      { name: "a sender that is not the extension's own code", sender: { ownExtension: false } },
    ])("ignores $name", async ({ sender }) => {
      const s = setup();
      const reply = await s.messageBus.send({ type: "page-mode-open-options" }, sender);
      expect(reply.answered).toBe(false);
      expect(s.options.opened).toBe(0);
    });
  });

  describe("the ignore set for the page-mode frame", () => {
    const inTab = { tab: { id: 5, windowId: 1, index: 0 } };
    const ask = (s: ReturnType<typeof setup>, message: object, sender: object = inTab) =>
      s.messageBus.send({ type: "page-mode-ignore", ...message }, sender);

    it("adds a pair to the ignore set in storage.session, which the tutor pages read too", async () => {
      const s = setup();
      expect((await ask(s, { op: "add", source: "session:a", fingerprint: "f1" })).answer).toEqual({
        ok: true,
      });
      expect(s.session.values.get(ignoreKey("session:a", "f1"))).toBe(true);
      expect((await ask(s, { op: "has", source: "session:a", fingerprint: "f1" })).answer).toEqual({
        has: true,
      });
      expect((await ask(s, { op: "has", source: "session:a", fingerprint: "f2" })).answer).toEqual({
        has: false,
      });
    });

    it("moves the pairs of a source", async () => {
      const s = setup();
      await ask(s, { op: "add", source: "session:a", fingerprint: "f1" });
      expect((await ask(s, { op: "move", from: "session:a", to: "doc:7" })).answer).toEqual({
        ok: true,
      });
      expect([...s.session.values.keys()].filter((k) => k.startsWith("ignore:"))).toEqual([
        ignoreKey("doc:7", "f1"),
      ]);
    });

    it.each([
      { name: "a bad op", message: { op: "clear", source: "a", fingerprint: "f" }, sender: inTab },
      {
        name: "an empty source",
        message: { op: "add", source: "", fingerprint: "f" },
        sender: inTab,
      },
      { name: "no tab", message: { op: "add", source: "a", fingerprint: "f" }, sender: {} },
      {
        name: "a sender that is not the extension's own code",
        message: { op: "add", source: "a", fingerprint: "f" },
        sender: { ...inTab, ownExtension: false },
      },
    ])("ignores $name", async ({ message, sender }) => {
      const s = setup();
      expect((await ask(s, message, sender)).answered).toBe(false);
      expect([...s.session.values.keys()].filter((k) => k.startsWith("ignore:"))).toEqual([]);
    });
  });

  describe("the page-mode frame: register and claim", () => {
    const ID = "11111111-1111-4111-8111-111111111111";
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const inTab = (id: number) => ({ tab: { id, windowId: 1, index: 0 } });
    const register = (s: ReturnType<typeof setup>, id = ID, tab = 5) =>
      s.messageBus.send({ type: "page-frame-register", id }, inTab(tab));
    const claim = (s: ReturnType<typeof setup>, id = ID, tab = 5) =>
      s.messageBus.send({ type: "page-frame-claim", id }, inTab(tab));

    it("registers the id with the sender's tab, and grants the claim of that tab once", async () => {
      const s = setup();
      expect((await register(s)).answer).toEqual({ ok: true });
      expect(s.session.values.get(`page-frame:${ID}`)).toEqual({ tabId: 5, at: NOW });
      expect((await claim(s)).answer).toEqual({ granted: true });
      expect(s.session.values.has(`page-frame:${ID}`)).toBe(false);
      expect((await claim(s)).answer).toEqual({ granted: false });
    });

    it("refuses the claim of a frame a web page made by itself (an id nobody registered)", async () => {
      const s = setup();
      await register(s);
      expect((await claim(s, OTHER)).answer).toEqual({ granted: false });
      // The registered id is still there for the real frame.
      expect((await claim(s)).answer).toEqual({ granted: true });
    });

    it("refuses a claim from another tab, and the entry is gone afterwards", async () => {
      const s = setup();
      await register(s, ID, 5);
      expect((await claim(s, ID, 6)).answer).toEqual({ granted: false });
      expect((await claim(s, ID, 5)).answer).toEqual({ granted: false });
    });

    it("refuses a claim that has no tab", async () => {
      const s = setup();
      await register(s);
      expect((await s.messageBus.send({ type: "page-frame-claim", id: ID })).answer).toEqual({
        granted: false,
      });
    });

    it("registers nothing for a sender without a tab", async () => {
      const s = setup();
      const reply = await s.messageBus.send({ type: "page-frame-register", id: ID });
      expect(reply.answered).toBe(false);
      expect(s.session.values.size).toBe(0);
    });

    it.each([
      { name: "an id that is not a UUID", message: { type: "page-frame-register", id: "abc" } },
      { name: "no id", message: { type: "page-frame-register" } },
      { name: "a claim with a bad id", message: { type: "page-frame-claim", id: 5 } },
    ])("ignores $name", async ({ message }) => {
      const s = setup();
      expect((await s.messageBus.send(message, inTab(5))).answered).toBe(false);
      expect(s.session.values.size).toBe(0);
    });

    it("ignores both messages from a sender that is not the extension's own code", async () => {
      const s = setup();
      await s.messageBus.send(
        { type: "page-frame-register", id: ID },
        { ...inTab(5), ownExtension: false },
      );
      expect(s.session.values.size).toBe(0);
      await register(s);
      const reply = await s.messageBus.send(
        { type: "page-frame-claim", id: ID },
        { ...inTab(5), ownExtension: false },
      );
      expect(reply.answered).toBe(false);
      expect(s.session.values.has(`page-frame:${ID}`)).toBe(true);
    });

    it("keeps nothing in memory: a restart of the event page still knows the registration", async () => {
      const first = setup();
      await register(first);
      const second = setup({ session: first.session, clock: first.clock });
      expect((await claim(second)).answer).toEqual({ granted: true });
    });

    it("refuses the claim of an entry that is older than 5 minutes", async () => {
      const s = setup();
      await register(s);
      s.clock.advance(5 * 60 * 1000 + 1);
      expect((await claim(s)).answer).toEqual({ granted: false });
    });

    it("deletes the entries older than 5 minutes when the script runs, and keeps the others", async () => {
      const session = new FakeSessionStorage();
      session.values.set("page-frame:old", { tabId: 1, at: NOW - 5 * 60 * 1000 - 1 });
      session.values.set("page-frame:new", { tabId: 1, at: NOW - 1000 });
      setup({ session });
      await settle();
      expect([...session.values.keys()]).toEqual(["page-frame:new"]);
    });
  });

  describe("the toolbar button's menu entry for the site", () => {
    const entry = (s: ReturnType<typeof setup>) => s.menus.entries.get(MENU_IDS.pageModeSite);

    it("is made hidden", async () => {
      const s = setup();
      s.lifecycle.install();
      await settle();
      expect(entry(s)?.visible).toBe(false);
    });

    it.each([
      {
        name: "Turn on on the host for a site with no choice",
        on: true,
        sites: {},
        later: false,
        url: SITE,
        title: "Turn on on www.example.com",
        visible: true,
      },
      {
        name: "Turn on on the host for a site answered Not now",
        on: true,
        sites: {},
        later: true,
        url: SITE,
        title: "Turn on on www.example.com",
        visible: true,
      },
      {
        name: "Turn off on the host for a site that is on",
        on: true,
        sites: { "www.example.com": "on" },
        later: false,
        url: SITE,
        title: "Turn off on www.example.com",
        visible: true,
      },
      {
        name: "Turn on on the host for a site that is off",
        on: true,
        sites: { "www.example.com": "off" },
        later: false,
        url: SITE,
        title: "Turn on on www.example.com",
        visible: true,
      },
      {
        name: "Turn on for the exact host: a parent that is on does not count",
        on: true,
        sites: { "example.com": "on" },
        later: false,
        url: SITE,
        title: "Turn on on www.example.com",
        visible: true,
      },
      {
        name: "nothing while page mode is not offered",
        on: false,
        sites: {},
        later: false,
        url: SITE,
        title: undefined,
        visible: false,
      },
      {
        name: "nothing for a page that is not http or https",
        on: true,
        sites: {},
        later: false,
        url: "about:preferences",
        title: undefined,
        visible: false,
      },
      {
        name: "nothing for a file",
        on: true,
        sites: {},
        later: false,
        url: "file:///home/me/a.html",
        title: undefined,
        visible: false,
      },
      {
        name: "nothing when the address is not known",
        on: true,
        sites: {},
        later: false,
        url: undefined,
        title: undefined,
        visible: false,
      },
    ])("shows $name", async ({ on, sites, later, url, title, visible }) => {
      const s = setup();
      s.lifecycle.install();
      await settle();
      const store = await settings(s);
      await store.setSetting("page_mode", on);
      await store.setSetting("page_mode_sites", sites as Record<string, "on" | "off">);
      if (later) s.session.values.set("page-mode-later:www.example.com", true);
      s.menus.show({ contexts: ["action"], tabUrl: url });
      await settle();
      await settle();
      expect(entry(s)?.visible).toBe(visible);
      if (title !== undefined) expect(entry(s)?.title).toBe(title);
      expect(s.menus.changes.at(-1)).toBe("refresh");
    });

    it("is left alone when another menu is shown", async () => {
      const s = setup();
      s.menus.show({ contexts: ["selection"], tabUrl: SITE });
      await settle();
      expect(s.menus.changes).toEqual([]);
    });
  });

  describe("turning page mode on and off for a site from the menu", () => {
    const choose = (s: ReturnType<typeof setup>, url: string | undefined) => {
      s.menus.choose(MENU_IDS.pageModeSite, {
        tab: { tabId: 1, windowId: 1, index: 0, url },
      });
    };

    it.each([
      {
        name: "a site with no choice",
        sites: {},
        later: false,
        expected: { "www.example.com": "on" },
      },
      {
        name: "a site answered Not now",
        sites: {},
        later: true,
        expected: { "www.example.com": "on" },
      },
      {
        name: "a site that is off",
        sites: { "www.example.com": "off", "other.org": "on" },
        later: false,
        expected: { "www.example.com": "on", "other.org": "on" },
      },
      {
        name: "a site that is on",
        sites: { "www.example.com": "on", "other.org": "on" },
        later: false,
        expected: { "www.example.com": "off", "other.org": "on" },
      },
    ])(
      "for $name stores the other state, announces it and tells the open pages",
      async ({ sites, later, expected }) => {
        const s = setup();
        const store = await settings(s);
        await store.setSetting("page_mode", true);
        await store.setSetting("page_mode_sites", sites as Record<string, "on" | "off">);
        if (later) s.session.values.set("page-mode-later:www.example.com", true);
        choose(s, SITE);
        await settle();
        await settle();
        expect(await store.getSetting("page_mode_sites")).toEqual(expected);
        expect(s.session.values.has("page-mode-later:www.example.com")).toBe(false);
        expect(s.pageTabs.sent).toEqual(["settings-changed"]);
      },
    );

    it.each([
      { name: "an unknown address", url: undefined },
      { name: "a page that is not http or https", url: "about:blank" },
    ])("does nothing for $name", async ({ url }) => {
      const s = setup();
      await (await settings(s)).setSetting("page_mode", true);
      choose(s, url);
      await settle();
      await settle();
      expect(await (await settings(s)).getSetting("page_mode_sites")).toEqual({});
      expect(s.pageTabs.sent).toEqual([]);
    });

    it("does nothing while page mode is not offered", async () => {
      const s = setup();
      choose(s, SITE);
      await settle();
      await settle();
      expect(await (await settings(s)).getSetting("page_mode_sites")).toEqual({});
      expect(s.pageTabs.sent).toEqual([]);
    });
  });

  describe("the welcome page", () => {
    it.each([
      { reason: "install", welcomes: 1 },
      { reason: "update", welcomes: 0 },
      { reason: "browser_update", welcomes: 0 },
    ])("is opened for the reason $reason: $welcomes time(s)", async ({ reason, welcomes }) => {
      const s = setup();
      s.lifecycle.install(reason);
      await settle();
      expect(s.options.welcomes).toBe(welcomes);
      // Whatever the reason, the menus and the registration are brought up to date.
      expect(s.menus.installs).toBe(1);
    });

    it("is not opened when the browser starts", async () => {
      const s = setup();
      s.lifecycle.startBrowser();
      await settle();
      expect(s.options.welcomes).toBe(0);
    });

    it("logs a failure to open it instead of leaving a rejected promise", async () => {
      const s = setup();
      s.options.welcomeFails = new Error("no window");
      s.lifecycle.install();
      await settle();
      expect(messages(s.logged)).toContain("could not open the welcome page");
      expect(s.menus.installs).toBe(1);
    });
  });

  it("registers its message and menu listeners synchronously, and keeps no state between runs", async () => {
    const first = setup();
    await turnedOn(first);
    // A restart of the event page: the same store, permission and registration.
    const second = setup({
      store: first.stored,
      permission: first.permission,
      scripts: first.scripts,
    });
    const reply = await second.messageBus.send({ type: "page-mode-config", host: "example.com" });
    expect(reply.answer).toEqual({ state: "ask", llm: null });
    second.permission.withdraw();
    await settle();
    await settle();
    expect(await (await settings(second)).getSetting("page_mode")).toBe(false);
  });
});
