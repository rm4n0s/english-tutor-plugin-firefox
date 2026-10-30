import { describe, expect, it } from "vitest";
import { Logger } from "../core/log";
import { FakeContextMenus, FakeCurrentTab } from "../platform/testing/fake-menus";
import { EditorMenu } from "./editor-menu";

const PAGE = "moz-extension://test/tutor.html";
const ALT = (tab: number) => `editor-alternative-${String(tab)}`;
const CHECK = (tab: number) => `editor-check-${String(tab)}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(tabId: number | null = 7) {
  const menus = new FakeContextMenus();
  const calls: string[] = [];
  const warnings: string[] = [];
  const state = { available: true, canCheck: true };
  const log = new Logger({
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: () => undefined,
  });
  const menu = new EditorMenu({
    menus,
    currentTab: new FakeCurrentTab(tabId ?? undefined),
    pageUrl: PAGE,
    log,
    actions: {
      alternatives: () => calls.push("alternatives"),
      checkSelection: () => calls.push("check"),
      available: () => state.available,
      canCheck: () => state.canCheck,
    },
  });
  return { menus, menu, calls, warnings, state };
}

describe("EditorMenu", () => {
  it("makes Alternative and Check for this tab, invisible, limited to the tutor page, in that order", async () => {
    const { menus, menu } = setup();
    await menu.start();
    expect([...menus.entries]).toEqual([
      [ALT(7), { title: "Alternative", visible: false, enabled: true, patterns: [PAGE] }],
      [CHECK(7), { title: "Check", visible: false, enabled: true, patterns: [PAGE] }],
    ]);
  });

  it("makes nothing where the page is not in a tab", async () => {
    const { menus, menu } = setup(null);
    await menu.start();
    menu.open();
    expect(menus.entries.size).toBe(0);
    expect(menus.overridden).toBe(0);
  });

  it("keeps the browser's own entries (showDefaults: true)", async () => {
    const { menus, menu } = setup();
    await menu.start();
    menu.open();
    expect(menus.overridden).toBe(1);
    expect(menus.lastShowDefaults).toBe(true);
  });

  it("shows both entries when the menu it opened is shown, and hides them after", async () => {
    const { menus, menu } = setup();
    await menu.start();
    menu.open();
    menus.show(7);
    await tick();
    expect(menus.visibleIds).toEqual([ALT(7), CHECK(7)]);
    expect(menus.entries.get(CHECK(7))?.enabled).toBe(true);
    expect(menus.refreshes).toBe(1);
    menus.hide();
    await tick();
    expect(menus.visibleIds).toEqual([]);
  });

  it.each([
    { name: "nothing is selected, or only white space", available: false, canCheck: true },
    { name: "a manual check runs", available: false, canCheck: true },
  ])("shows no entry when $name", async ({ available, canCheck }) => {
    const { menus, menu, state } = setup();
    await menu.start();
    state.available = available;
    state.canCheck = canCheck;
    menu.open();
    menus.show(7);
    await tick();
    expect(menus.visibleIds).toEqual([]);
    expect(menus.refreshes).toBe(0);
  });

  it("disables Check, and only Check, while no LLM is configured", async () => {
    const { menus, menu, state } = setup();
    await menu.start();
    state.canCheck = false;
    menu.open();
    menus.show(7);
    await tick();
    expect(menus.visibleIds).toEqual([ALT(7), CHECK(7)]);
    expect(menus.entries.get(CHECK(7))?.enabled).toBe(false);
    expect(menus.entries.get(ALT(7))?.enabled).toBe(true);
  });

  it.each([
    { name: "a menu this page did not open", open: false, shownFor: 7 },
    { name: "a menu shown for another tab", open: true, shownFor: 8 },
  ])("leaves the entries hidden for $name", async ({ open, shownFor }) => {
    const { menus, menu } = setup();
    await menu.start();
    if (open) menu.open();
    menus.show(shownFor);
    await tick();
    expect(menus.visibleIds).toEqual([]);
  });

  it.each([
    { name: "Alternative", id: ALT(7), expected: ["alternatives"] },
    { name: "Check", id: CHECK(7), expected: ["check"] },
  ])("choosing $name calls the page", async ({ id, expected }) => {
    const { menus, menu, calls } = setup();
    await menu.start();
    menu.open();
    menus.show(7);
    menus.choose(id, 7);
    menus.hide();
    expect(calls).toEqual(expected);
  });

  it("does not run Check without an LLM, even if the browser sends the click", async () => {
    const { menus, menu, calls, state } = setup();
    await menu.start();
    state.canCheck = false;
    menus.choose(CHECK(7), 7);
    expect(calls).toEqual([]);
  });

  it.each([
    { name: "a click for another tab", id: ALT(7), tab: 8 },
    { name: "a click on another tab's entry", id: ALT(8), tab: 7 },
    { name: "a click on a row menu entry", id: "row-not-an-error-7", tab: 7 },
  ])("ignores $name", async ({ id, tab }) => {
    const { menus, menu, calls } = setup();
    await menu.start();
    menus.choose(id, tab);
    expect(calls).toEqual([]);
  });

  it("two tabs make entries of their own", async () => {
    const menus = new FakeContextMenus();
    const log = new Logger({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    const actions = {
      alternatives: () => undefined,
      checkSelection: () => undefined,
      available: () => true,
      canCheck: () => true,
    };
    for (const tab of [1, 2]) {
      await new EditorMenu({
        menus,
        currentTab: new FakeCurrentTab(tab),
        pageUrl: PAGE,
        actions,
        log,
      }).start();
    }
    expect([...menus.entries.keys()]).toEqual([ALT(1), CHECK(1), ALT(2), CHECK(2)]);
  });

  it("logs a failure to show the entries", async () => {
    const { menus, menu, warnings } = setup();
    await menu.start();
    menu.open();
    menus.failWith = new Error("menu is gone");
    menus.show(7);
    await tick();
    expect(warnings).toEqual(["[english-tutor] could not show the editor menu entries"]);
  });

  it("removes its entries and listeners when the page is destroyed", async () => {
    const { menus, menu, calls } = setup();
    await menu.start();
    menu.destroy();
    await tick();
    expect(menus.entries.size).toBe(0);
    menus.choose(ALT(7), 7);
    expect(calls).toEqual([]);
  });
});
