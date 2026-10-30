import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import { BrowserCommands } from "./commands";
import { BrowserLifecycle } from "./lifecycle";
import { BrowserNotifier } from "./notifications";
import { BrowserBackgroundMenus, type WebMenuItem } from "./web-menus";

type Listener = (...args: never[]) => void;

function event() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    api: {
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
    },
    fire: (...args: unknown[]) => {
      for (const l of listeners) (l as (...a: unknown[]) => void)(...args);
    },
  };
}

const ITEMS: WebMenuItem[] = [
  { id: "parent", title: "P", contexts: ["selection"] },
  { id: "child", title: "C", contexts: ["selection"], parentId: "parent", visible: false },
  { id: "button", title: "B", contexts: ["action"] },
];

function menusApi(options: { lastError?: Error; throws?: Error } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const clicked = event();
  const shown = event();
  const api = {
    runtime: { lastError: null as Error | null },
    menus: {
      create: (props: object, callback: () => void) => {
        calls.push({ method: "create", args: [props] });
        if (options.throws !== undefined) throw options.throws;
        api.runtime.lastError = options.lastError ?? null;
        callback();
        api.runtime.lastError = null;
        return 1;
      },
      remove: (id: string) => {
        calls.push({ method: "remove", args: [id] });
        // The id of an earlier run exists once; the others do not.
        return id === "parent" ? Promise.resolve() : Promise.reject(new Error("no such item"));
      },
      update: (id: string, changes: object) => {
        calls.push({ method: "update", args: [id, changes] });
        return options.throws === undefined ? Promise.resolve() : Promise.reject(options.throws);
      },
      refresh: () => {
        calls.push({ method: "refresh", args: [] });
        return options.throws === undefined ? Promise.resolve() : Promise.reject(options.throws);
      },
      onClicked: clicked.api,
      onShown: shown.api,
    },
  };
  return { api: api as unknown as typeof browser, calls, clicked, shown };
}

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("BrowserBackgroundMenus", () => {
  it("removes the entries of an earlier run, children first, and then makes them in order", async () => {
    const { api, calls } = menusApi();
    await new BrowserBackgroundMenus(api).install(ITEMS);
    expect(
      calls.map(
        (c) =>
          `${c.method}:${JSON.stringify(c.args[0] instanceof Object ? (c.args[0] as { id: string }).id : c.args[0])}`,
      ),
    ).toEqual([
      'remove:"button"',
      'remove:"child"',
      'remove:"parent"',
      'create:"parent"',
      'create:"child"',
      'create:"button"',
    ]);
    expect(calls.find((c) => (c.args[0] as { id?: string }).id === "child")?.args[0]).toEqual({
      id: "child",
      title: "C",
      contexts: ["selection"],
      parentId: "parent",
      visible: false,
    });
    expect(calls.find((c) => (c.args[0] as { id?: string }).id === "button")?.args[0]).toEqual({
      id: "button",
      title: "B",
      contexts: ["action"],
      visible: true,
    });
  });

  it.each([
    { name: "lastError", options: { lastError: new Error("bad parent") }, message: "bad parent" },
    { name: "a thrown error", options: { throws: new Error("threw") }, message: "threw" },
  ])("install fails with ContextMenuFailed through $name", async ({ options, message }) => {
    const { api } = menusApi(options);
    const err = await caught(new BrowserBackgroundMenus(api).install(ITEMS));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("BrowserBackgroundMenus.install")).toBe(true);
    expect((err as AppError).tag).toBe("ContextMenuFailed");
    expect((err as AppError).message).toBe(message);
  });

  it("update and refresh pass on, and fail with ContextMenuFailed", async () => {
    const ok = menusApi();
    const menus = new BrowserBackgroundMenus(ok.api);
    await menus.update("child", { visible: false });
    await menus.refresh();
    expect(ok.calls).toEqual([
      { method: "update", args: ["child", { visible: false }] },
      { method: "refresh", args: [] },
    ]);
    const bad = menusApi({ throws: new Error("nope") });
    const failing = new BrowserBackgroundMenus(bad.api);
    const updateErr = await caught(failing.update("child", { visible: true }));
    const refreshErr = await caught(failing.refresh());
    expect(
      (updateErr as AppError).hasRoute("BrowserBackgroundMenus.update->ContextMenuFailed"),
    ).toBe(true);
    expect(
      (refreshErr as AppError).hasRoute("BrowserBackgroundMenus.refresh->ContextMenuFailed"),
    ).toBe(true);
  });

  it("reports a click with the selection and the tab's place", () => {
    const { api, clicked } = menusApi();
    const heard: unknown[] = [];
    new BrowserBackgroundMenus(api).onClicked((c) => heard.push(c));
    clicked.fire(
      { menuItemId: "child", selectionText: "Some text" },
      { id: 3, windowId: 8, index: 5 },
    );
    clicked.fire({ menuItemId: 7 }, { id: 3 });
    clicked.fire({ menuItemId: "button" });
    expect(heard).toEqual([
      { id: "child", selectionText: "Some text", tab: { tabId: 3, windowId: 8, index: 5 } },
      { id: "7", selectionText: undefined, tab: undefined },
      { id: "button", selectionText: undefined, tab: undefined },
    ]);
  });

  it("reports a menu that is about to show", () => {
    const { api, shown } = menusApi();
    const heard: unknown[] = [];
    new BrowserBackgroundMenus(api).onShown((s) => heard.push(s));
    shown.fire({
      contexts: ["selection", "page"],
      selectionText: "x y",
      viewType: "tab",
      menuIds: [],
    });
    shown.fire({ contexts: ["page"], menuIds: [] });
    expect(heard).toEqual([
      { contexts: ["selection", "page"], selectionText: "x y", viewType: "tab" },
      { contexts: ["page"], selectionText: undefined, viewType: undefined },
    ]);
  });
});

describe("BrowserCommands, BrowserLifecycle and BrowserNotifier", () => {
  it("passes on a command", () => {
    const commands = event();
    const api = { commands: { onCommand: commands.api } } as unknown as typeof browser;
    const heard: string[] = [];
    new BrowserCommands(api).onCommand((name) => heard.push(name));
    commands.fire("open-tutor");
    expect(heard).toEqual(["open-tutor"]);
  });

  it("passes on the lifecycle events and reloads", () => {
    const installed = event();
    const started = event();
    const updated = event();
    let reloads = 0;
    const api = {
      runtime: {
        onInstalled: installed.api,
        onStartup: started.api,
        onUpdateAvailable: updated.api,
        reload: () => reloads++,
      },
    } as unknown as typeof browser;
    const lifecycle = new BrowserLifecycle(api);
    const heard: string[] = [];
    lifecycle.onInstalled(() => heard.push("installed"));
    lifecycle.onStartup(() => heard.push("startup"));
    lifecycle.onUpdateAvailable(() => heard.push("update"));
    installed.fire({ reason: "update" });
    started.fire();
    updated.fire({ version: "2" });
    lifecycle.reload();
    expect(heard).toEqual(["installed", "startup", "update"]);
    expect(reloads).toBe(1);
  });

  it("shows, clears and hears the click of a notification", async () => {
    const clicked = event();
    const calls: unknown[][] = [];
    const api = {
      runtime: { getURL: (p: string) => `moz-extension://x/${p}` },
      notifications: {
        create: (...args: unknown[]) => {
          calls.push(["create", ...args]);
          return Promise.resolve("id");
        },
        clear: (...args: unknown[]) => {
          calls.push(["clear", ...args]);
          return Promise.resolve(true);
        },
        onClicked: clicked.api,
      },
    } as unknown as typeof browser;
    const notifier = new BrowserNotifier(api);
    await notifier.show("check-3", "Check finished", "3 issues");
    await notifier.clear("check-3");
    const heard: string[] = [];
    notifier.onClicked((id) => heard.push(id));
    clicked.fire("check-3");
    expect(calls).toEqual([
      [
        "create",
        "check-3",
        {
          type: "basic",
          title: "Check finished",
          message: "3 issues",
          iconUrl: "moz-extension://x/icons/icon-96.png",
        },
      ],
      ["clear", "check-3"],
    ]);
    expect(heard).toEqual(["check-3"]);
  });
});
