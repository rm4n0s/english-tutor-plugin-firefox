import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import {
  ALL_URLS,
  BrowserBackgroundMessages,
  BrowserFrameActions,
  BrowserFrameClaim,
  BrowserContentScripts,
  BrowserPageModeBackendLink,
  BrowserPageModePermission,
  BrowserPageModeRuntime,
  BrowserPageTabs,
  PAGE_MODE_SCRIPT_ID,
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
  function fakeApi(answer: boolean) {
    const calls: { method: string; origins: string[] }[] = [];
    const removed = event();
    const record = (method: string) => (permissions: { origins?: string[] }) => {
      calls.push({ method, origins: permissions.origins ?? [] });
      return Promise.resolve(answer);
    };
    const api = {
      permissions: {
        contains: record("contains"),
        request: record("request"),
        remove: record("remove"),
        onRemoved: removed.api,
      },
    } as unknown as typeof browser;
    return { api, calls, removed };
  }

  it.each([
    { method: "contains", answer: true },
    { method: "contains", answer: false },
    { method: "request", answer: true },
    { method: "request", answer: false },
    { method: "remove", answer: true },
    { method: "remove", answer: false },
  ] as const)(
    "$method asks for <all_urls> only and returns $answer",
    async ({ method, answer }) => {
      const { api, calls } = fakeApi(answer);
      expect(await new BrowserPageModePermission(api)[method]()).toBe(answer);
      expect(calls).toEqual([{ method, origins: [ALL_URLS] }]);
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

  it("calls the handler when a permission is removed", () => {
    const { api, removed } = fakeApi(true);
    let count = 0;
    new BrowserPageModePermission(api).onRemoved(() => {
      count++;
    });
    removed.fire({ origins: [ALL_URLS] });
    expect(count).toBe(1);
  });
});

describe("BrowserContentScripts", () => {
  function fakeApi(registered: string[] = []) {
    const calls: { method: string; arg: unknown }[] = [];
    const api = {
      scripting: {
        getRegisteredContentScripts: (filter: unknown) => {
          calls.push({ method: "get", arg: filter });
          return Promise.resolve(registered.map((id) => ({ id })));
        },
        registerContentScripts: (scripts: unknown) => {
          calls.push({ method: "register", arg: scripts });
          return Promise.resolve();
        },
        unregisterContentScripts: (filter: unknown) => {
          calls.push({ method: "unregister", arg: filter });
          return Promise.resolve();
        },
      },
    } as unknown as typeof browser;
    return { api, calls };
  }

  it("registers page.js for every web page and every frame, at document_idle", async () => {
    const { api, calls } = fakeApi();
    await new BrowserContentScripts(api).register();
    expect(calls).toEqual([
      {
        method: "register",
        arg: [
          {
            id: "page-mode",
            matches: ["<all_urls>"],
            js: ["page.js"],
            runAt: "document_idle",
            allFrames: true,
          },
        ],
      },
    ]);
    expect(PAGE_MODE_SCRIPT_ID).toBe("page-mode");
  });

  it("unregisters its script by id", async () => {
    const { api, calls } = fakeApi();
    await new BrowserContentScripts(api).unregister();
    expect(calls).toEqual([{ method: "unregister", arg: { ids: ["page-mode"] } }]);
  });

  it.each([
    { registered: ["page-mode"], expected: true },
    { registered: [], expected: false },
  ])("isRegistered is $expected for $registered", async ({ registered, expected }) => {
    const { api, calls } = fakeApi(registered);
    expect(await new BrowserContentScripts(api).isRegistered()).toBe(expected);
    expect(calls[0]?.arg).toEqual({ ids: ["page-mode"] });
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

describe("BrowserPageModeBackendLink", () => {
  it("asks the background script to apply the setting", async () => {
    const sent: unknown[] = [];
    const api = {
      runtime: {
        sendMessage: (message: unknown) => {
          sent.push(message);
          return Promise.resolve({ ok: true });
        },
      },
    } as unknown as typeof browser;
    await new BrowserPageModeBackendLink(api).apply();
    expect(sent).toEqual([{ type: "page-mode-apply" }]);
  });

  it("fails when the background script fails", async () => {
    const api = {
      runtime: { sendMessage: () => Promise.reject(new Error("no store")) },
    } as unknown as typeof browser;
    await expect(new BrowserPageModeBackendLink(api).apply()).rejects.toThrow("no store");
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
    { answer: { state: "later" }, expected: { state: "later" } },
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
