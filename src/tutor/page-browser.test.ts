// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { reply, slowReply } from "../core/analysis/testing/helpers";
import { serialiseSavedTab, type SavedTab } from "../core/files";
import { handoffFragment, parseHandoffFragment } from "../core/handoff";
import type { FakeResponse } from "../core/llm/testing/fake-fetch";
import {
  config,
  mountForTest,
  PAGE_URL,
  TAB_ID,
  type HarnessOptions,
  type TutorHarness,
} from "./testing/harness";

let mounted: TutorHarness | undefined;

afterEach(() => {
  mounted?.page.destroy();
  mounted = undefined;
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(document, "hasFocus");
  document.documentElement.removeAttribute("style");
  document.title = "";
});

async function mount(options: HarnessOptions = {}): Promise<TutorHarness> {
  mounted = await mountForTest(document, { configs: [config()], selected: 1, ...options });
  return mounted;
}

const byId = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found;
};
const editor = () => byId("editor") as HTMLTextAreaElement;
const click = (id: string) => byId(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const status = () => byId("status-state").textContent;
const rows = () => [...document.querySelectorAll<HTMLElement>(".issue-row")];

function type(value: string): void {
  editor().value = value;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle(check: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** The tab is in the background (`visible` false) or its window has no focus. */
function setAway(away: { visible: boolean; focused: boolean }): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (away.visible ? "visible" : "hidden"),
  });
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => away.focused });
}

const TEXT = "Yesterday I seen him. He go to school. I very like it.";
const THREE_ISSUES = JSON.stringify({
  issues: [
    { text: "I seen", error_type: "verb_form", message: "Use saw." },
    { text: "He go", error_type: "subject_verb_agreement", message: "Use goes." },
    { text: "I very like", error_type: "word_order", message: "Put very first." },
  ],
});
const CHECKED = reply(THREE_ISSUES, { usage: { input: 10, output: 5 } });

describe("answering the background script's ping (SPEC section 4.1)", () => {
  it("answers with the tab, its window, when it was focused and whether it has unsaved changes", async () => {
    const h = await mount();
    expect(h.pings.listening).toBe(true);
    expect(await h.pings.ping()).toEqual({
      tabId: TAB_ID,
      windowId: 1,
      focusedAt: 1_000,
      dirty: false,
    });
    type("Some words");
    expect((await h.pings.ping())?.dirty).toBe(true);
  });

  it("does not count a text that is only white space as unsaved changes", async () => {
    const h = await mount();
    type("  \n");
    expect((await h.pings.ping())?.dirty).toBe(false);
  });

  it("a tab that opens in the background has never been focused", async () => {
    setAway({ visible: false, focused: false });
    const h = await mount();
    expect((await h.pings.ping())?.focusedAt).toBe(0);
  });

  it.each([
    {
      event: "the tab becomes the visible tab",
      fire: () => document.dispatchEvent(new Event("visibilitychange")),
    },
    { event: "its window gets the focus", fire: () => window.dispatchEvent(new Event("focus")) },
  ])("remembers when $event", async ({ fire }) => {
    setAway({ visible: false, focused: false });
    const h = await mount();
    h.clock.advance(5_000);
    // Still hidden: the visibilitychange to hidden is not a focus.
    fire();
    expect((await h.pings.ping())?.focusedAt).toBe(0);
    setAway({ visible: true, focused: true });
    fire();
    expect((await h.pings.ping())?.focusedAt).toBe(6_000);
  });

  it("stops answering when the page is destroyed", async () => {
    const h = await mount();
    h.page.destroy();
    expect(h.pings.listening).toBe(false);
  });

  it("has no answer where the page is in no tab", async () => {
    const h = await mount();
    (h.deps.currentTab as unknown as { tabId: number | undefined }).tabId = undefined;
    expect(await h.pings.ping()).toBeUndefined();
  });
});

describe("a text from the web page menu (SPEC section 4.1)", () => {
  const SELECTED = "I has a idea. It are good.";

  it("opens the text as a new text, deletes the entry and clears the address", async () => {
    const h = await mount({ handoff: { text: SELECTED, action: "check" }, script: CHECKED });
    expect(editor().value).toBe(SELECTED);
    expect(h.fragment.hash).toBe("");
    expect(h.fragment.cleared).toBe(1);
    expect([...h.session.values.keys()].filter((k) => k.startsWith("handoff:"))).toEqual([]);
    expect(h.page.tabText.unsaved).toBe(false);
    expect(h.page.tabText.name).toBeUndefined();
    expect(document.title).toBe("Untitled – English Tutor");
    expect(h.page.source.key.startsWith("session:")).toBe(true);
  });

  it("Check starts a manual check of the whole text, counted under the tab's source", async () => {
    const h = await mount({ handoff: { text: TEXT, action: "check" }, script: CHECKED });
    await settle(() => {
      expect(h.page.state.outcome).toBe("finished");
    });
    expect(status()).toBe("3 issues");
    expect(rows()).toHaveLength(3);
    const userMessage = JSON.stringify(h.fake.requests[0]?.body);
    expect(userMessage).toContain("I seen him");
    // Recorded: it was a manual check.
    await settle(async () => {
      expect((await h.stats.typeStats()).length).toBeGreaterThan(0);
    });
  });

  it("Check without an LLM only loads the text", async () => {
    const h = await mount({
      configs: [],
      handoff: { text: TEXT, action: "check" },
    });
    expect(editor().value).toBe(TEXT);
    expect(h.fake.requests).toHaveLength(0);
    expect(h.page.state.pending).toBeNull();
  });

  it("Alternatives selects all of the text and opens the panel for it", async () => {
    const h = await mount({
      handoff: { text: "make a photo", action: "alternatives" },
      script: reply(JSON.stringify({ alternatives: ["take a photo", "snap a picture"] })),
    });
    expect(editor().selectionStart).toBe(0);
    expect(editor().selectionEnd).toBe("make a photo".length);
    await settle(() => {
      expect(byId("alternatives").dataset.state).toBe("ready");
    });
    expect(byId("alt-selected").textContent).toBe("make a photo");
    // No check ran, and nothing was recorded.
    expect(h.page.state.outcome).toBe("none");
  });

  it("gives the tab a source of its own", async () => {
    const h = await mount({ handoff: { text: SELECTED, action: "check" }, script: CHECKED });
    const before = h.page.source.key;
    expect(before).not.toBe("session:00000000-0000-4000-8000-000000000000");
    expect(before.startsWith("session:")).toBe(true);
  });

  it("keeps the text for a reload", async () => {
    const h = await mount({ handoff: { text: SELECTED, action: "alternatives" } });
    h.scheduler.advance(1000);
    expect(h.tabStorage.value).toContain("I has a idea");
  });

  it("an entry that is gone shows HandoffExpired in the banner and leaves the text empty", async () => {
    const h = await mount({ fragment: handoffFragment("0a1b2c3d-0000-4000-8000-0123456789ab") });
    expect(editor().value).toBe("");
    expect(byId("banner").hidden).toBe(false);
    expect(byId("banner").textContent).toContain("no longer available");
    const failure = h.logged.find((l) => l.message.includes("tutor page failed"));
    expect((failure?.fields as { err: unknown }).err).toMatchObject({
      tag: "HandoffExpired",
      route: "HandoffStore.take->HandoffExpired",
    });
    expect(h.fragment.hash).toBe("");
  });

  it("the address opened a second time is expired", async () => {
    const h = await mount({ handoff: { text: SELECTED, action: "check" }, script: CHECKED });
    const key = parseHandoffFragment(handoffFragment("0a1b2c3d-0000-4000-8000-0123456789ab"));
    expect(key).toBeDefined();
    h.page.destroy();
    mounted = undefined;
    document.body.replaceChildren();
    const again = await mountForTest(document, {
      configs: [config()],
      selected: 1,
      fragment: handoffFragment(key ?? ""),
    });
    mounted = again;
    expect(again.page.tabText.name).toBeUndefined();
    expect(editor().value).toBe("");
  });

  it.each(["", "#", "#something", "#handoff=", "#handoff=not-a-key", "#handoff=ignore:session:x"])(
    "ignores the fragment %j",
    async (fragment) => {
      const h = await mount({ fragment });
      expect(editor().value).toBe("");
      expect(byId("banner").hidden).toBe(true);
      expect(h.fragment.cleared).toBe(0);
    },
  );

  it("does not put the text into the page's address", async () => {
    const h = await mount({ handoff: { text: SELECTED, action: "check" }, script: CHECKED });
    expect(h.fragment.hash).not.toContain("idea");
    expect(PAGE_URL).not.toContain("idea");
  });
});

describe("the check-finished notification (SPEC section 4.10)", () => {
  const AWAY = [
    { name: "the tab is hidden", state: { visible: false, focused: true } },
    { name: "the window has no focus", state: { visible: true, focused: false } },
    { name: "the tab is hidden and unfocused", state: { visible: false, focused: false } },
  ];

  async function checkWith(h: TutorHarness, text = TEXT): Promise<void> {
    type(text);
    click("check");
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
  }

  it.each(AWAY)("shows 'Check finished' with the result when $name", async ({ state }) => {
    setAway(state);
    const h = await mount({ script: CHECKED });
    await checkWith(h);
    expect([...h.notifier.shown]).toEqual([
      [`check-${String(TAB_ID)}`, { title: "Check finished", message: "3 issues" }],
    ]);
  });

  it("says 'No errors found' for a text without issues", async () => {
    setAway({ visible: false, focused: true });
    const h = await mount({ script: reply(JSON.stringify({ issues: [] })) });
    await checkWith(h);
    expect([...h.notifier.shown.values()]).toEqual([
      { title: "Check finished", message: "No errors found" },
    ]);
  });

  it("shows 'Check failed' with the error's message", async () => {
    setAway({ visible: false, focused: true });
    const failing: FakeResponse = {
      kind: "json",
      status: 500,
      body: { error: { message: "down" } },
    };
    const h = await mount({ script: failing });
    await checkWith(h);
    const shown = [...h.notifier.shown.values()];
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe("Check failed");
    expect(shown[0]?.message).toContain("HTTP 500");
  });

  it("shows nothing while the tab is visible and focused", async () => {
    setAway({ visible: true, focused: true });
    const h = await mount({ script: CHECKED });
    await checkWith(h);
    expect(h.notifier.shown.size).toBe(0);
  });

  it("looks at the tab when the check ends, not when it starts", async () => {
    setAway({ visible: true, focused: true });
    const h = await mount({ script: slowReply(THREE_ISSUES, 50) });
    type(TEXT);
    click("check");
    setAway({ visible: false, focused: true });
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    expect(h.notifier.shown.size).toBe(1);
  });

  it("shows nothing for a check the user cancelled", async () => {
    setAway({ visible: false, focused: false });
    const h = await mount({ script: slowReply(THREE_ISSUES, 200) });
    type(TEXT);
    click("check");
    click("check"); // Cancel
    await settle(() => {
      expect(status()).toBe("Check cancelled");
    });
    expect(h.notifier.shown.size).toBe(0);
  });

  it("shows nothing for a check whose result was discarded because the text changed", async () => {
    setAway({ visible: false, focused: false });
    const h = await mount({
      script: slowReply(THREE_ISSUES, 50),
      tabState: serialiseSavedTab({
        text: TEXT,
        source: "session:123e4567-e89b-42d3-a456-426614174000",
        name: undefined,
        documentId: undefined,
        lineEnding: "lf",
        dirty: false,
      }),
    });
    click("check");
    // A loaded text (nothing is unsaved, so no question) ends the check.
    click("new");
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.notifier.shown.size).toBe(0);
  });

  it("shows nothing for an auto-check", async () => {
    setAway({ visible: false, focused: false });
    const h = await mount({
      script: CHECKED,
      settings: { auto_check: true, auto_check_delay_s: 1 },
    });
    type(TEXT);
    h.scheduler.advance(1000);
    await settle(() => {
      expect(h.page.state.outcome).toBe("finished");
    });
    expect(h.notifier.shown.size).toBe(0);
  });

  it("logs, and does not fail the check, when the notification cannot be shown", async () => {
    setAway({ visible: false, focused: true });
    const h = await mount({ script: CHECKED });
    h.notifier.failWith = new Error("no notifications");
    await checkWith(h);
    await settle(() => {
      expect(h.logged.some((l) => l.message.includes("could not show the notification"))).toBe(
        true,
      );
    });
    expect(status()).toBe("3 issues");
  });
});

describe("a duplicated tab (SPEC section 4.2)", () => {
  const SAVED: SavedTab = {
    text: "A draft.",
    source: "session:123e4567-e89b-42d3-a456-426614174000",
    name: "draft",
    documentId: undefined,
    lineEnding: "lf",
    dirty: true,
  };
  const state = (tab: Partial<SavedTab>) => serialiseSavedTab({ ...SAVED, ...tab });

  it("keeps the source when the state was written by this tab", async () => {
    const h = await mount({ tabState: state({ tabId: TAB_ID }) });
    expect(h.page.source.key).toBe(SAVED.source);
    expect(editor().value).toBe("A draft.");
  });

  it("keeps the source of a state that has no tab id (written before)", async () => {
    const h = await mount({ tabState: state({}) });
    expect(h.page.source.key).toBe(SAVED.source);
  });

  it("keeps the text but renews a session source copied from another tab", async () => {
    const h = await mount({ tabState: state({ tabId: 3 }) });
    expect(editor().value).toBe("A draft.");
    expect(h.page.tabText.name).toBe("draft");
    expect(h.page.tabText.dirty).toBe(true);
    expect(h.page.source.key).not.toBe(SAVED.source);
    expect(h.page.source.key.startsWith("session:")).toBe(true);
    // The new source and the tab's own id are written.
    h.scheduler.advance(1000);
    expect(h.tabStorage.value).toContain(h.page.source.key);
    expect(h.tabStorage.value).toContain(`"tabId":${String(TAB_ID)}`);
  });

  it("keeps a document source: both tabs edit the same document", async () => {
    const h = await mount({
      documents: [{ title: "Essay", content: "stored", line_ending: "lf" }],
      tabState: state({ tabId: 3, source: "doc:1", documentId: 1, dirty: false }),
    });
    expect(h.page.source.key).toBe("doc:1");
  });

  it("two tabs that were one count their mistakes under different sources", async () => {
    const first = await mount({
      tabState: state({ tabId: 3, text: TEXT }),
      tab: 3,
      script: CHECKED,
    });
    const firstSource = first.page.source.key;
    expect(firstSource).toBe(SAVED.source);
    const copied = first.tabStorage.value ?? state({ tabId: 3, text: TEXT });
    first.page.destroy();
    mounted = undefined;
    document.body.replaceChildren();
    const second = await mount({ tabState: copied, tab: 8, script: CHECKED });
    expect(second.page.source.key).not.toBe(firstSource);
  });
});

describe("fonts (SPEC section 4.7)", () => {
  const prop = (name: string) => document.documentElement.style.getPropertyValue(name);

  it("sets no property for the default settings", async () => {
    await mount();
    expect(document.documentElement.getAttribute("style") ?? "").not.toContain("font");
  });

  it("applies the three fonts from the settings through custom properties", async () => {
    await mount({
      more: {
        editor_font_family: "Georgia",
        editor_font_size: 18,
        button_font_family: "monospace",
        button_font_size: 14,
        results_font_family: "Fira Code",
        results_font_size: 9,
      },
    });
    expect(prop("--editor-font-family")).toBe('"Georgia", system-ui, sans-serif');
    expect(prop("--editor-font-size")).toBe("18pt");
    expect(prop("--button-font-family")).toBe("monospace, system-ui, sans-serif");
    expect(prop("--button-font-size")).toBe("14pt");
    expect(prop("--results-font-family")).toBe('"Fira Code", system-ui, sans-serif');
    expect(prop("--results-font-size")).toBe("9pt");
  });

  it("follows a change made on the options page at once", async () => {
    const h = await mount();
    await h.deps.store.setSetting("editor_font_size", 20);
    await h.deps.store.setSetting("results_font_family", "Georgia");
    h.other.channel.post("settings-changed");
    await settle(() => {
      expect(prop("--editor-font-size")).toBe("20pt");
    });
    expect(prop("--results-font-family")).toBe('"Georgia", system-ui, sans-serif');
    await h.deps.store.setSetting("editor_font_size", 13);
    h.other.channel.post("settings-changed");
    await settle(() => {
      expect(prop("--editor-font-size")).toBe("");
    });
  });
});

describe("pane sizes (SPEC sections 4.2 and 9)", () => {
  const panes = () => byId("panes");
  const side = () => byId("side");

  it("keeps the stylesheet's sizes for the defaults", async () => {
    await mount();
    expect(panes().style.getPropertyValue("--editor-share")).toBe("65%");
    expect(side().style.getPropertyValue("--issues-share")).toBe("40%");
  });

  it("restores both positions from pane_sizes", async () => {
    await mount({ more: { pane_sizes: { editor: 50, issues: 25 } } });
    expect(panes().style.getPropertyValue("--editor-share")).toBe("50%");
    expect(side().style.getPropertyValue("--issues-share")).toBe("25%");
    expect(byId("divider-main").getAttribute("aria-valuenow")).toBe("50");
    expect(byId("divider-side").getAttribute("aria-valuenow")).toBe("25");
  });

  it("saves a position when a divider is moved with the keyboard, keeping the other one", async () => {
    const h = await mount({ more: { pane_sizes: { editor: 50, issues: 25 } } });
    byId("divider-main").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await settle(async () => {
      expect((await h.deps.store.getSettings()).pane_sizes).toEqual({ editor: 52, issues: 25 });
    });
    byId("divider-side").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await settle(async () => {
      expect((await h.deps.store.getSettings()).pane_sizes).toEqual({ editor: 52, issues: 27 });
    });
  });

  it("restores what an earlier page saved", async () => {
    const h = await mount();
    byId("divider-side").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    byId("divider-side").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    await settle(async () => {
      expect((await h.deps.store.getSettings()).pane_sizes.issues).toBe(36);
    });
    const stored = (await h.deps.store.getSettings()).pane_sizes;
    h.page.destroy();
    mounted = undefined;
    document.body.replaceChildren();
    await mount({ more: { pane_sizes: stored } });
    expect(side().style.getPropertyValue("--issues-share")).toBe("36%");
  });

  it("reports a failure to save in the banner", async () => {
    const h = await mount();
    h.db.close();
    byId("divider-main").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
  });
});
