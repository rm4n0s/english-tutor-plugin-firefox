import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import {
  ALL_URLS,
  BrowserBackgroundMessages,
  BrowserFrameActions,
  BrowserFrameClaim,
  BrowserContentScripts,
  BrowserPageModePermission,
  BrowserPageModeRuntime,
  BrowserPageTabs,
  PAGE_MODE_SCRIPT_FILE,
  type MessageSender,
} from "./page-mode";

type Listener = (...args: never[]) => unknown;

function event() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    api: {
      addListener: (l: Listener) => listeners.add(l),
      removeListener: (l: Listener) => listeners.delete(l),
    },
    fire: (...args: unknown[]) =>
      [...listeners].map((l) => (l as (...a: unknown[]) => unknown)(...args)),
  };
}

describe("BrowserPageModePermission", () => {
  function fakeApi(answer: boolean, { rejectContains = false } = {}) {
    const calls: { method: string; origins: string[] }[] = [];
    const removed = event();
    const added = event();
    const record = (method: string) => (permissions: { origins?: string[] }) => {
      calls.push({ method, origins: permissions.origins ?? [] });
      return method === "contains" && rejectContains
        ? Promise.reject(new Error("Invalid host permission"))
        : Promise.resolve(answer);
    };
    const api = {
      permissions: {
        contains: record("contains"),
        request: record("request"),
        onRemoved: removed.api,
        onAdded: added.api,
      },
    } as unknown as typeof browser;
    return { api, calls, removed, added };
  }

  it.each([
    { method: "contains", answer: true, origins: ["http://*/*", "https://*/*"] },
    { method: "contains", answer: false, origins: ["http://*/*", "https://*/*"] },
    { method: "request", answer: true, origins: [ALL_URLS] },
    { method: "request", answer: false, origins: [ALL_URLS] },
  ] as const)(
    "$method asks for $origins only and returns $answer",
    async ({ method, answer, origins }) => {
      const { api, calls } = fakeApi(answer);
      expect(await new BrowserPageModePermission(api)[method]()).toBe(answer);
      expect(calls).toEqual([{ method, origins }]);
      expect(ALL_URLS).toBe("<all_urls>");
    },
  );

  it("calls the browser in the turn of the call, because Firefox accepts request only during a gesture", () => {
    const { api, calls } = fakeApi(true);
    const promise = new BrowserPageModePermission(api).request();
    // Nothing was awaited: the call is already made.
    expect(calls).toEqual([{ method: "request", origins: [ALL_URLS] }]);
    return promise;
  });

  it.each([
    {
      name: "a page",
      url: "https://www.example.com/a/b?x=1#y",
      pattern: "https://www.example.com/*",
    },
    {
      name: "a page with a port",
      url: "http://127.0.0.1:47811/pages/x.html",
      pattern: "http://127.0.0.1/*",
    },
    { name: "a bare origin", url: "https://example.org", pattern: "https://example.org/*" },
    { name: "an IPv6 address", url: "http://[::1]:8080/", pattern: "http://[::1]/*" },
  ])(
    "containsSite asks about the site of $name, as a match pattern without port",
    async ({ url, pattern }) => {
      const { api, calls } = fakeApi(true);
      expect(await new BrowserPageModePermission(api).containsSite(url)).toBe(true);
      expect(calls).toEqual([{ method: "contains", origins: [pattern] }]);
    },
  );

  it.each([
    { name: "not an address", url: "not a url" },
    { name: "an opaque origin", url: "null" },
  ])("containsSite is false for $name, without asking the browser", async ({ url }) => {
    const { api, calls } = fakeApi(true);
    expect(await new BrowserPageModePermission(api).containsSite(url)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("containsSite is false when the browser refuses the pattern", async () => {
    const { api } = fakeApi(true, { rejectContains: true });
    expect(await new BrowserPageModePermission(api).containsSite("file:///a.html")).toBe(false);
  });

  it.each(["onRemoved", "onAdded"] as const)("calls the handler of %s", (method) => {
    const { api, removed, added } = fakeApi(true);
    let count = 0;
    new BrowserPageModePermission(api)[method](() => {
      count++;
    });
    (method === "onRemoved" ? removed : added).fire({ origins: [ALL_URLS] });
    expect(count).toBe(1);
  });
});

describe("BrowserContentScripts", () => {
  interface Fake {
    tabs?: { id?: number }[];
    /** The tab ids `executeScript` fails for. */
    unreachable?: number[];
  }

  function fakeApi({ tabs = [], unreachable = [] }: Fake = {}) {
    const calls: { method: string; arg: unknown }[] = [];
    const api = {
      scripting: {
        executeScript: (injection: { target: { tabId: number } }) => {
          calls.push({ method: "execute", arg: injection });
          return unreachable.includes(injection.target.tabId)
            ? Promise.reject(new Error("Missing host permission for the tab"))
            : Promise.resolve([]);
        },
      },
      tabs: {
        query: (filter: unknown) => {
          calls.push({ method: "query", arg: filter });
          return Promise.resolve(tabs);
        },
      },
    } as unknown as typeof browser;
    return { api, calls };
  }

  it("has nothing to register: the manifest declares the script", () => {
    const scripts = new BrowserContentScripts(fakeApi().api) as unknown as {
      register?: unknown;
      unregister?: unknown;
    };
    expect(scripts.register).toBeUndefined();
    expect(scripts.unregister).toBeUndefined();
    expect(PAGE_MODE_SCRIPT_FILE).toBe("page.js");
  });

  describe("injectIntoOpenTabs", () => {
    it("runs page.js in every frame of every http(s) tab that is open", async () => {
      const { api, calls } = fakeApi({ tabs: [{ id: 3 }, { id: 9 }] });
      const result = await new BrowserContentScripts(api).injectIntoOpenTabs();
      expect(result).toEqual({ injected: 2, skipped: 0 });
      expect(calls[0]).toEqual({
        method: "query",
        arg: { url: ["http://*/*", "https://*/*"] },
      });
      expect(calls.slice(1)).toEqual([
        { method: "execute", arg: { target: { tabId: 3, allFrames: true }, files: ["page.js"] } },
        { method: "execute", arg: { target: { tabId: 9, allFrames: true }, files: ["page.js"] } },
      ]);
    });

    it("skips a tab it cannot script (or a site the user withdrew access to) and a tab with no id, and goes on", async () => {
      const { api } = fakeApi({ tabs: [{ id: 1 }, {}, { id: 2 }, { id: 3 }], unreachable: [2] });
      expect(await new BrowserContentScripts(api).injectIntoOpenTabs()).toEqual({
        injected: 2,
        skipped: 2,
      });
    });

    it("does nothing when no tab is open", async () => {
      const { api, calls } = fakeApi();
      expect(await new BrowserContentScripts(api).injectIntoOpenTabs()).toEqual({
        injected: 0,
        skipped: 0,
      });
      expect(calls.map((c) => c.method)).toEqual(["query"]);
    });
  });
});

describe("BrowserPageTabs", () => {
  it("sends the message to every tab and ignores tabs that have nobody to receive it", async () => {
    const sent: { tab: number; message: unknown }[] = [];
    const api = {
      tabs: {
        query: () => Promise.resolve([{ id: 1 }, { id: 2 }, {}, { id: 3 }]),
        sendMessage: (tab: number, message: unknown) => {
          sent.push({ tab, message });
          return tab === 2
            ? Promise.reject(
                new Error("Could not establish connection. Receiving end does not exist."),
              )
            : Promise.resolve(undefined);
        },
      },
    } as unknown as typeof browser;
    await new BrowserPageTabs(api).broadcast("page-mode-off");
    expect(sent).toEqual([
      { tab: 1, message: { type: "page-mode-off" } },
      { tab: 2, message: { type: "page-mode-off" } },
      { tab: 3, message: { type: "page-mode-off" } },
    ]);
  });
});

describe("BrowserBackgroundMessages", () => {
  function setup() {
    const messages = event();
    const api = {
      runtime: { id: "english-tutor@rm4n0s.dev", onMessage: messages.api },
    } as unknown as typeof browser;
    const seen: { message: unknown; sender: MessageSender }[] = [];
    new BrowserBackgroundMessages(api).onMessage((message, sender) => {
      seen.push({ message, sender });
      return message === "answer me" ? Promise.resolve("answered") : undefined;
    });
    return { messages, seen };
  }

  it("tells the handler whether the sender is the extension and where its tab is", () => {
    const { messages, seen } = setup();
    messages.fire("a", {
      id: "english-tutor@rm4n0s.dev",
      url: "https://example.com/page",
      tab: { id: 9, windowId: 4, index: 2 },
    });
    messages.fire("b", { id: "someone-else@example.com" });
    messages.fire("c", { id: "english-tutor@rm4n0s.dev", tab: {} });
    // A tab without an id cannot be told from another one.
    messages.fire("d", { id: "english-tutor@rm4n0s.dev", tab: { windowId: 4, index: 2 } });
    expect(seen.map((s) => s.sender)).toEqual([
      {
        ownExtension: true,
        url: "https://example.com/page",
        tab: { id: 9, windowId: 4, index: 2 },
      },
      { ownExtension: false, url: undefined, tab: undefined },
      { ownExtension: true, url: undefined, tab: undefined },
      { ownExtension: true, url: undefined, tab: undefined },
    ]);
  });

  it("returns the handler's promise, and undefined when it does not answer", async () => {
    const { messages } = setup();
    const [answered] = messages.fire("answer me", { id: "english-tutor@rm4n0s.dev" });
    expect(await answered).toBe("answered");
    expect(messages.fire("other", { id: "english-tutor@rm4n0s.dev" })).toEqual([undefined]);
  });
});

describe("BrowserFrameClaim", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it.each([
    { name: "granted: true", answer: { granted: true }, expected: true },
    { name: "granted: false", answer: { granted: false }, expected: false },
    { name: "granted as a string", answer: { granted: "yes" }, expected: false },
    { name: "an empty object", answer: {}, expected: false },
    { name: "null", answer: null, expected: false },
    { name: "undefined (nobody answered)", answer: undefined, expected: false },
  ])("claims the id and reads $name", async ({ answer, expected }) => {
    const sent: unknown[] = [];
    const api = {
      runtime: {
        sendMessage: (message: unknown) => {
          sent.push(message);
          return Promise.resolve(answer);
        },
      },
    } as unknown as typeof browser;
    expect(await new BrowserFrameClaim(api).claim(ID)).toBe(expected);
    expect(sent).toEqual([{ type: "page-frame-claim", id: ID }]);
  });

  it("fails when the background script cannot be reached", async () => {
    const api = {
      runtime: { sendMessage: () => Promise.reject(new Error("no receiver")) },
    } as unknown as typeof browser;
    await expect(new BrowserFrameClaim(api).claim(ID)).rejects.toThrow("no receiver");
  });
});

describe("BrowserPageModeRuntime", () => {
  function setup(...given: [unknown?]) {
    const answer: unknown = given.length === 0 ? { state: "on" } : given[0];
    const sent: unknown[] = [];
    const messages = event();
    const api = {
      runtime: {
        sendMessage: (message: unknown) => {
          sent.push(message);
          return Promise.resolve(answer);
        },
        onMessage: messages.api,
        getURL: (path: string) => `moz-extension://uuid/${path}`,
      },
    } as unknown as typeof browser;
    return { runtime: new BrowserPageModeRuntime(api), sent, messages };
  }

  it("asks what page mode does on the host", async () => {
    const t = setup({ state: "ask", llm: { server: "localhost:11434", local: true } });
    expect(await t.runtime.configFor("example.com")).toEqual({
      state: "ask",
      llm: { server: "localhost:11434", local: true },
    });
    expect(t.sent).toEqual([{ type: "page-mode-config", host: "example.com" }]);
  });

  it.each([
    { answer: { state: "on" }, expected: { state: "on" } },
    { answer: { state: "off" }, expected: { state: "off" } },
    { answer: { state: "later" }, expected: { state: "later", llm: null } },
    { answer: { state: "ask", llm: null }, expected: { state: "ask", llm: null } },
    // An answer that makes no sense, or an old one, is off: nothing is read.
    { answer: { enabled: true }, expected: { state: "off" } },
    { answer: { state: "yes" }, expected: { state: "off" } },
    { answer: {}, expected: { state: "off" } },
    { answer: null, expected: { state: "off" } },
    { answer: undefined, expected: { state: "off" } },
    { answer: "on", expected: { state: "off" } },
    { answer: 1, expected: { state: "off" } },
  ])("reads the answer $answer as $expected", async ({ answer, expected }) => {
    expect(await setup(answer).runtime.configFor("example.com")).toEqual(expected);
  });

  it.each(["on", "off", "later"] as const)(
    "tells the background script the choice %s",
    async (choice) => {
      const t = setup({ ok: true });
      await t.runtime.chooseSite("example.com", choice);
      expect(t.sent).toEqual([{ type: "page-mode-site", host: "example.com", choice }]);
    },
  );

  it("hands the text over to a new tutor tab", async () => {
    const t = setup({ ok: true });
    await t.runtime.openInTutor("Some text.");
    expect(t.sent).toEqual([{ type: "page-mode-open-tutor", text: "Some text." }]);
  });

  it("registers the id of the frame it is about to make", async () => {
    const t = setup({ ok: true });
    await t.runtime.registerFrame("11111111-1111-4111-8111-111111111111");
    expect(t.sent).toEqual([
      { type: "page-frame-register", id: "11111111-1111-4111-8111-111111111111" },
    ]);
  });

  it("makes the frame's address from the extension's own page and the id", () => {
    expect(setup().runtime.frameUrl("abc")).toBe("moz-extension://uuid/page-ui.html#abc");
  });

  it("passes on page-mode-off and settings-changed, and never answers any message (it ignores tutor-ping)", () => {
    const t = setup();
    const heard: string[] = [];
    const stop = t.runtime.onBroadcast((message) => {
      heard.push(message);
    });
    const answers = [
      { type: "page-mode-off" },
      { type: "settings-changed" },
      { type: "tutor-ping" },
      { type: "page-mode-apply" },
      "tutor-ping",
      null,
      undefined,
    ].flatMap((message) => t.messages.fire(message, {}));
    expect(heard).toEqual(["page-mode-off", "settings-changed"]);
    // A listener that returns anything but undefined would answer the sender: the tutor's ping
    // must be left to the tutor pages.
    expect(answers.every((answer) => answer === undefined)).toBe(true);
    stop();
    expect(t.messages.listeners.size).toBe(0);
  });
});

describe("BrowserFrameActions", () => {
  function fakeApi(reply: () => Promise<unknown>) {
    const sent: unknown[] = [];
    const api = {
      runtime: {
        sendMessage: (message: unknown) => {
          sent.push(message);
          return reply();
        },
      },
    } as unknown as typeof browser;
    return { api, sent };
  }

  it.each([
    {
      name: "openInTutor",
      call: (a: BrowserFrameActions) => a.openInTutor("Some text"),
      message: { type: "page-mode-open-tutor", text: "Some text" },
    },
    {
      name: "openOptions",
      call: (a: BrowserFrameActions) => a.openOptions(),
      message: { type: "page-mode-open-options" },
    },
  ])("$name sends one message and resolves on { ok: true }", async ({ call, message }) => {
    const { api, sent } = fakeApi(() => Promise.resolve({ ok: true }));
    await call(new BrowserFrameActions(api));
    expect(sent).toEqual([message]);
  });

  it.each([
    {
      name: "openInTutor",
      call: (a: BrowserFrameActions) => a.openInTutor("Some text"),
      route: "BrowserFrameActions.openInTutor->PageDialogActionFailed",
    },
    {
      name: "openOptions",
      call: (a: BrowserFrameActions) => a.openOptions(),
      route: "BrowserFrameActions.openOptions->PageDialogActionFailed",
    },
  ])(
    "$name fails with PageDialogActionFailed when the message is refused",
    async ({ call, route }) => {
      const { api } = fakeApi(() => Promise.reject(new Error("no receiver")));
      const err = await call(new BrowserFrameActions(api)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).hasRoute(route)).toBe(true);
    },
  );

  it.each([
    { name: "no answer", answer: undefined },
    { name: "{ ok: false }", answer: { ok: false } },
    { name: "a string", answer: "ok" },
    { name: "null", answer: null },
  ])("fails with PageDialogActionFailed on $name", async ({ answer }) => {
    const { api } = fakeApi(() => Promise.resolve(answer));
    const err = await new BrowserFrameActions(api).openInTutor("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(
      (err as AppError).hasRoute("BrowserFrameActions.openInTutor->PageDialogActionFailed"),
    ).toBe(true);
  });
});
