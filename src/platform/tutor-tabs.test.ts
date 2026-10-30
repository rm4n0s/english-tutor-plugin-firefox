import { describe, expect, it } from "vitest";
import {
  BrowserTutorPingResponder,
  BrowserTutorTabs,
  isTutorPing,
  parseTutorTabInfo,
  TUTOR_PING,
} from "./tutor-tabs";

const PONG = { tabId: 4, windowId: 2, focusedAt: 99, dirty: false };

describe("isTutorPing", () => {
  it.each([
    { message: { type: TUTOR_PING }, expected: true },
    { message: { type: "tutor-ping", extra: 1 }, expected: true },
    { message: { type: "other" }, expected: false },
    { message: "tutor-ping", expected: false },
    { message: null, expected: false },
    { message: undefined, expected: false },
  ])("is $expected for $message", ({ message, expected }) => {
    expect(isTutorPing(message)).toBe(expected);
  });
});

describe("parseTutorTabInfo", () => {
  it("reads an answer", () => {
    expect(parseTutorTabInfo({ ...PONG, extra: true })).toEqual(PONG);
  });

  it.each([
    undefined,
    null,
    "x",
    { ...PONG, tabId: "4" },
    { ...PONG, tabId: 1.5 },
    { ...PONG, windowId: undefined },
    { ...PONG, focusedAt: Number.NaN },
    { ...PONG, focusedAt: "9" },
    { ...PONG, dirty: 0 },
  ])("refuses %j", (value) => {
    expect(parseTutorTabInfo(value)).toBeUndefined();
  });
});

interface Call {
  method: string;
  args: unknown[];
}

function fakeApi(
  tabs: { id?: number }[],
  answers: Record<number, unknown>,
  options: { failQuery?: boolean } = {},
) {
  const calls: Call[] = [];
  const listeners = new Set<(message: unknown) => unknown>();
  const api = {
    runtime: {
      getURL: (path: string) => `moz-extension://x/${path}`,
      onMessage: {
        addListener: (l: (message: unknown) => unknown) => listeners.add(l),
        removeListener: (l: (message: unknown) => unknown) => listeners.delete(l),
      },
    },
    tabs: {
      query: (filter: object) => {
        calls.push({ method: "query", args: [filter] });
        return options.failQuery === true ? Promise.reject(new Error("no")) : Promise.resolve(tabs);
      },
      sendMessage: (id: number, message: unknown) => {
        calls.push({ method: "sendMessage", args: [id, message] });
        return id in answers
          ? Promise.resolve(answers[id])
          : Promise.reject(new Error("Receiving end does not exist"));
      },
      update: (id: number, props: object) => {
        calls.push({ method: "tabs.update", args: [id, props] });
        return Promise.resolve({});
      },
      create: (props: object) => {
        calls.push({ method: "create", args: [props] });
        return Promise.resolve({});
      },
    },
    windows: {
      update: (id: number, props: object) => {
        calls.push({ method: "windows.update", args: [id, props] });
        return Promise.resolve({});
      },
    },
  };
  return { api: api as unknown as typeof browser, calls, listeners };
}

describe("BrowserTutorTabs", () => {
  it("asks every tab and keeps the answers of the tutor pages", async () => {
    const { api, calls } = fakeApi([{ id: 1 }, { id: 2 }, {}, { id: 3 }, { id: 4 }], {
      2: PONG,
      3: undefined,
      4: { nonsense: true },
    });
    expect(await new BrowserTutorTabs(api, "tutor.html").ping()).toEqual([PONG]);
    expect(calls.filter((c) => c.method === "sendMessage").map((c) => c.args)).toEqual([
      [1, { type: TUTOR_PING }],
      [2, { type: TUTOR_PING }],
      [3, { type: TUTOR_PING }],
      [4, { type: TUTOR_PING }],
    ]);
  });

  it("gives no pages when no tab answers", async () => {
    const { api } = fakeApi([{ id: 1 }], {});
    expect(await new BrowserTutorTabs(api, "tutor.html").ping()).toEqual([]);
  });

  it("rejects when the tabs cannot be listed", async () => {
    const { api } = fakeApi([], {}, { failQuery: true });
    await expect(new BrowserTutorTabs(api, "tutor.html").ping()).rejects.toThrow("no");
  });

  it("brings the tab and then its window to the front", async () => {
    const { api, calls } = fakeApi([], {});
    await new BrowserTutorTabs(api, "tutor.html").focus({ tabId: 4, windowId: 2 });
    expect(calls).toEqual([
      { method: "tabs.update", args: [4, { active: true }] },
      { method: "windows.update", args: [2, { focused: true }] },
    ]);
  });

  it.each([
    {
      name: "in the current window",
      options: {},
      expected: { url: "moz-extension://x/tutor.html" },
    },
    {
      name: "with a fragment",
      options: { fragment: "#handoff=k" },
      expected: { url: "moz-extension://x/tutor.html#handoff=k" },
    },
    {
      name: "next to a tab of a window",
      options: { fragment: "#handoff=k", after: { windowId: 6, index: 3 } },
      expected: { url: "moz-extension://x/tutor.html#handoff=k", windowId: 6, index: 4 },
    },
  ])("opens the tutor page $name", async ({ options, expected }) => {
    const { api, calls } = fakeApi([], {});
    await new BrowserTutorTabs(api, "tutor.html").open(options);
    expect(calls).toEqual([{ method: "create", args: [expected] }]);
  });
});

describe("BrowserTutorPingResponder", () => {
  it("answers a ping and leaves other messages alone", async () => {
    const { api, listeners } = fakeApi([], {});
    const stop = new BrowserTutorPingResponder(api).onPing(() => Promise.resolve(PONG));
    expect(listeners.size).toBe(1);
    const [listener] = [...listeners];
    expect(await listener?.({ type: TUTOR_PING })).toEqual(PONG);
    expect(listener?.({ type: "other" })).toBeUndefined();
    stop();
    expect(listeners.size).toBe(0);
  });
});
