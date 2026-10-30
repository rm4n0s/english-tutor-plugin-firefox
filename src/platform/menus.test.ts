import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import { BrowserContextMenus } from "./menus";
import { BrowserCurrentTab } from "./tabs";
import { FakeContextMenus } from "./testing/fake-menus";

type Listener = (...args: never[]) => void;

/** The part of `browser.menus` and `browser.runtime` that the wrapper calls. */
function fakeApi(options: { lastError?: Error; throws?: Error } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const event = (name: string) => {
    const set = new Set<Listener>();
    listeners.set(name, set);
    return {
      addListener: (l: Listener) => set.add(l),
      removeListener: (l: Listener) => set.delete(l),
    };
  };
  const failure = options.throws;
  const api = {
    runtime: { lastError: null as Error | null },
    menus: {
      create: (props: object, callback: () => void) => {
        calls.push({ method: "create", args: [props] });
        if (failure !== undefined) throw failure;
        api.runtime.lastError = options.lastError ?? null;
        callback();
        api.runtime.lastError = null;
        return 1;
      },
      remove: (id: string) => {
        calls.push({ method: "remove", args: [id] });
        return id === "gone" ? Promise.reject(new Error("no")) : Promise.resolve();
      },
      update: (id: string, changes: object) => {
        calls.push({ method: "update", args: [id, changes] });
        return failure === undefined ? Promise.resolve() : Promise.reject(failure);
      },
      refresh: () => {
        calls.push({ method: "refresh", args: [] });
        return failure === undefined ? Promise.resolve() : Promise.reject(failure);
      },
      overrideContext: (o: object) => {
        calls.push({ method: "overrideContext", args: [o] });
      },
      onClicked: event("clicked"),
      onShown: event("shown"),
      onHidden: event("hidden"),
    },
  };
  return { api: api as unknown as typeof browser, calls, listeners };
}

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("BrowserContextMenus", () => {
  it("creates each entry, for every context, on the given pages", async () => {
    const { api, calls } = fakeApi();
    await new BrowserContextMenus(api).create(
      [
        { id: "a", title: "A", visible: false },
        { id: "b", title: "B", enabled: false },
      ],
      ["moz-extension://x/tutor.html"],
    );
    expect(calls.map((c) => c.args[0])).toEqual([
      {
        id: "a",
        title: "A",
        contexts: ["all"],
        documentUrlPatterns: ["moz-extension://x/tutor.html"],
        visible: false,
        enabled: true,
      },
      {
        id: "b",
        title: "B",
        contexts: ["all"],
        documentUrlPatterns: ["moz-extension://x/tutor.html"],
        visible: true,
        enabled: false,
      },
    ]);
  });

  describe.each([
    {
      name: "create (lastError)",
      options: { lastError: new Error("ID already exists: a") },
      call: (m: BrowserContextMenus) => m.create([{ id: "a", title: "A" }], []),
      matches: (e: AppError) => e.hasRoute("BrowserContextMenus.create->ContextMenuFailed"),
    },
    {
      name: "create (throws)",
      options: { throws: new Error("bad pattern") },
      call: (m: BrowserContextMenus) => m.create([{ id: "a", title: "A" }], []),
      matches: (e: AppError) => e.hasRoute("BrowserContextMenus.create->ContextMenuFailed"),
    },
    {
      name: "update",
      options: { throws: new Error("No menu item") },
      call: (m: BrowserContextMenus) => m.update("a", { visible: true }),
      matches: (e: AppError) => e.hasRoute("BrowserContextMenus.update->ContextMenuFailed"),
    },
    {
      name: "refresh",
      options: { throws: new Error("no menu is shown") },
      call: (m: BrowserContextMenus) => m.refresh(),
      matches: (e: AppError) => e.hasRoute("BrowserContextMenus.refresh->ContextMenuFailed"),
    },
  ])("$name fails", ({ options, call, matches }) => {
    it("with ContextMenuFailed and keeps the cause", async () => {
      const { api } = fakeApi(options);
      const err = await caught(call(new BrowserContextMenus(api)));
      expect(err).toBeInstanceOf(AppError);
      expect(matches(err as AppError)).toBe(true);
      expect((err as AppError).cause).toBeInstanceOf(Error);
      expect((err as AppError).message).toBe((options.lastError ?? options.throws).message);
    });
  });

  it("updates and refreshes the context menu", async () => {
    const { api, calls } = fakeApi();
    const menus = new BrowserContextMenus(api);
    await menus.update("a", { visible: true, title: "T" });
    await menus.refresh();
    expect(calls).toEqual([
      { method: "update", args: ["a", { visible: true, title: "T" }] },
      { method: "refresh", args: [] },
    ]);
  });

  it.each([{ showDefaults: false }, { showDefaults: true }])(
    "overrides the context menu with %o",
    (options) => {
      const { api, calls } = fakeApi();
      new BrowserContextMenus(api).overrideContext(options);
      expect(calls).toEqual([{ method: "overrideContext", args: [options] }]);
    },
  );

  it("removes entries and skips one that is already gone", async () => {
    const { api, calls } = fakeApi();
    await new BrowserContextMenus(api).remove(["a", "gone", "b"]);
    expect(calls.map((c) => c.args[0])).toEqual(["a", "gone", "b"]);
  });

  it("tells listeners about clicks, shown and hidden menus until they are removed", () => {
    const { api, listeners } = fakeApi();
    const menus = new BrowserContextMenus(api);
    const seen: unknown[] = [];
    const stops = [
      menus.onClicked((c) => seen.push(["click", c])),
      menus.onShown((s) => seen.push(["shown", s])),
      menus.onHidden(() => seen.push(["hidden"])),
    ];
    const call = (name: string, ...args: unknown[]) => {
      for (const l of listeners.get(name) ?? []) (l as (...a: unknown[]) => void)(...args);
    };
    call("clicked", { menuItemId: "a" }, { id: 4 });
    call("clicked", { menuItemId: 9 }, undefined);
    call("shown", { menuIds: ["a", 2] }, { id: 4 });
    call("hidden");
    expect(seen).toEqual([
      ["click", { id: "a", tabId: 4 }],
      ["click", { id: "9", tabId: undefined }],
      ["shown", { ids: ["a", "2"], tabId: 4 }],
      ["hidden"],
    ]);
    for (const stop of stops) stop();
    call("clicked", { menuItemId: "a" }, { id: 4 });
    call("hidden");
    expect(seen).toHaveLength(4);
  });
});

describe("BrowserCurrentTab", () => {
  it.each([
    { name: "a tab", current: { id: 12 }, expected: 12 },
    { name: "no tab", current: undefined, expected: undefined },
  ])("gives the id for $name", async ({ current, expected }) => {
    const api = {
      tabs: { getCurrent: () => Promise.resolve(current) },
    } as unknown as typeof browser;
    expect(await new BrowserCurrentTab(api).id()).toBe(expected);
  });
});

describe("FakeContextMenus", () => {
  it("refuses a duplicate id like the browser, and tells every listener of a click", async () => {
    const menus = new FakeContextMenus();
    await menus.create([{ id: "a", title: "A" }], ["p"]);
    await expect(menus.create([{ id: "a", title: "A" }], ["p"])).rejects.toThrow("already exists");
    const heard: string[] = [];
    menus.onClicked((c) => heard.push(`1:${c.id}@${String(c.tabId)}`));
    menus.onClicked((c) => heard.push(`2:${c.id}@${String(c.tabId)}`));
    menus.choose("a", 3);
    expect(heard).toEqual(["1:a@3", "2:a@3"]);
  });
});
