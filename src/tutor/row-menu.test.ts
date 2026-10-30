import { describe, expect, it } from "vitest";
import { Logger } from "../core/log";
import { FakeContextMenus, FakeCurrentTab } from "../platform/testing/fake-menus";
import { RowMenu, type RowMenuActions } from "./row-menu";

const PAGE = "moz-extension://test/tutor.html";

function setup(tabId: number | null = 7) {
  const menus = new FakeContextMenus();
  const calls: string[] = [];
  const warnings: string[] = [];
  const state = { canRegenerate: true };
  const actions: RowMenuActions = {
    notAnError: (id) => calls.push(`not-an-error ${String(id)}`),
    regenerate: (id) => calls.push(`regenerate ${String(id)}`),
    canRegenerate: () => state.canRegenerate,
  };
  const log = new Logger({
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: () => undefined,
  });
  const menu = new RowMenu({
    menus,
    currentTab: new FakeCurrentTab(tabId ?? undefined),
    pageUrl: PAGE,
    actions,
    log,
  });
  return { menus, menu, calls, warnings, state };
}

const NOT = (tab: number) => `row-not-an-error-${String(tab)}`;
const REGEN = (tab: number) => `row-regenerate-${String(tab)}`;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("RowMenu", () => {
  it("makes two invisible entries for this tab, limited to the tutor page", async () => {
    const { menus, menu } = setup();
    await menu.start();
    expect([...menus.entries]).toEqual([
      [NOT(7), { title: "Not an error", visible: false, enabled: true, patterns: [PAGE] }],
      [
        REGEN(7),
        { title: "Regenerate explanation", visible: false, enabled: true, patterns: [PAGE] },
      ],
    ]);
  });

  it("makes no entries and does nothing where the page is not in a tab", async () => {
    const { menus, menu } = setup(null);
    await menu.start();
    menu.open(3);
    expect(menus.entries.size).toBe(0);
    expect(menus.overridden).toBe(0);
  });

  it("two tabs make entries of their own and do not clash", async () => {
    const menus = new FakeContextMenus();
    const log = new Logger({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    const actions = {
      notAnError: () => undefined,
      regenerate: () => undefined,
      canRegenerate: () => true,
    };
    for (const tab of [1, 2]) {
      await new RowMenu({
        menus,
        currentTab: new FakeCurrentTab(tab),
        pageUrl: PAGE,
        actions,
        log,
      }).start();
    }
    expect([...menus.entries.keys()]).toEqual([NOT(1), REGEN(1), NOT(2), REGEN(2)]);
  });

  it("opening the menu on a row overrides the browser's menu", async () => {
    const { menus, menu } = setup();
    await menu.start();
    menu.open(4);
    expect(menus.overridden).toBe(1);
  });

  it("shows the entries, enabling Regenerate, when the menu it opened is shown, and hides them after", async () => {
    const { menus, menu } = setup();
    await menu.start();
    menu.open(4);
    menus.show(7);
    await tick();
    expect(menus.visibleIds).toEqual([NOT(7), REGEN(7)]);
    expect(menus.entries.get(REGEN(7))?.enabled).toBe(true);
    expect(menus.refreshes).toBe(1);
    menus.hide();
    await tick();
    expect(menus.visibleIds).toEqual([]);
  });

  it("disables Regenerate explanation when no LLM is selected", async () => {
    const { menus, menu, state } = setup();
    await menu.start();
    state.canRegenerate = false;
    menu.open(4);
    menus.show(7);
    await tick();
    expect(menus.entries.get(REGEN(7))?.enabled).toBe(false);
    expect(menus.entries.get(NOT(7))?.enabled).toBe(true);
  });

  it.each([
    { name: "a menu that this page did not open (the tab strip)", open: false, shownFor: 7 },
    { name: "a menu shown for another tab", open: true, shownFor: 8 },
  ])("leaves the entries hidden for $name", async ({ open, shownFor }) => {
    const { menus, menu } = setup();
    await menu.start();
    if (open) menu.open(4);
    menus.show(shownFor);
    await tick();
    expect(menus.visibleIds).toEqual([]);
    expect(menus.refreshes).toBe(0);
  });

  it.each([
    { name: "Not an error", id: NOT(7), expected: "not-an-error 4" },
    { name: "Regenerate explanation", id: REGEN(7), expected: "regenerate 4" },
  ])("$name acts on the row the menu was opened on", async ({ id, expected }) => {
    const { menus, menu, calls } = setup();
    await menu.start();
    menu.open(4);
    menus.show(7);
    menus.choose(id, 7);
    menus.hide();
    expect(calls).toEqual([expected]);
  });

  it("handles a click that arrives after the menu was hidden", async () => {
    const { menus, menu, calls } = setup();
    await menu.start();
    menu.open(4);
    menus.show(7);
    menus.hide();
    menus.choose(NOT(7), 7);
    expect(calls).toEqual(["not-an-error 4"]);
  });

  it.each([
    { name: "a click for another tab", id: NOT(7), tab: 8 },
    { name: "a click on another tab's entry", id: NOT(8), tab: 7 },
    { name: "a click on an entry of another page", id: "editor-copy", tab: 7 },
  ])("ignores $name", async ({ id, tab }) => {
    const { menus, menu, calls } = setup();
    await menu.start();
    menu.open(4);
    menus.choose(id, tab);
    expect(calls).toEqual([]);
  });

  it("ignores a click before any row menu was opened", async () => {
    const { menus, menu, calls } = setup();
    await menu.start();
    menus.choose(NOT(7), 7);
    expect(calls).toEqual([]);
  });

  it("logs a failure to show the entries instead of leaving a rejected promise", async () => {
    const { menus, menu, warnings } = setup();
    await menu.start();
    menu.open(4);
    menus.failWith = new Error("menu is gone");
    menus.show(7);
    await tick();
    expect(warnings).toEqual(["[english-tutor] could not show the row menu entries"]);
  });

  it("removes its entries and listeners when the page is destroyed", async () => {
    const { menus, menu, calls } = setup();
    await menu.start();
    menu.destroy();
    await tick();
    expect(menus.entries.size).toBe(0);
    menus.choose(NOT(7), 7);
    expect(calls).toEqual([]);
  });
});
