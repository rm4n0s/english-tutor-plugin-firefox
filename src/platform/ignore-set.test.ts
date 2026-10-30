import { describe, expect, it } from "vitest";
import { ignoreKey, RuntimeIgnoreSet, SessionIgnoreSet } from "./ignore-set";
import { BrowserSessionStorage } from "./session-storage";
import { FakeSessionStorage } from "./testing/fake-session-storage";

describe("SessionIgnoreSet", () => {
  it.each([
    {
      name: "a pair that was added",
      add: [["session:a", "f1"]],
      ask: ["session:a", "f1"],
      has: true,
    },
    {
      name: "a pair that was not",
      add: [["session:a", "f1"]],
      ask: ["session:a", "f2"],
      has: false,
    },
    {
      name: "the same fingerprint of another source",
      add: [["session:a", "f1"]],
      ask: ["session:b", "f1"],
      has: false,
    },
    { name: "nothing added", add: [], ask: ["session:a", "f1"], has: false },
  ])("says $has for $name", async ({ add, ask, has }) => {
    const set = new SessionIgnoreSet(new FakeSessionStorage());
    for (const [source, fingerprint] of add) await set.add(source ?? "", fingerprint ?? "");
    expect(await set.has(ask[0] ?? "", ask[1] ?? "")).toBe(has);
  });

  it("is shared by two sets over one storage (two tabs), one key per pair", async () => {
    const storage = new FakeSessionStorage();
    const tabA = new SessionIgnoreSet(storage);
    const tabB = new SessionIgnoreSet(storage);
    await Promise.all([tabA.add("session:a", "f1"), tabB.add("session:b", "f2")]);
    expect(await tabB.has("session:a", "f1")).toBe(true);
    expect(await tabA.has("session:b", "f2")).toBe(true);
    expect([...storage.values.keys()].sort()).toEqual([
      ignoreKey("session:a", "f1"),
      ignoreKey("session:b", "f2"),
    ]);
  });

  it("moves the pairs of one source to another, and only those", async () => {
    const storage = new FakeSessionStorage();
    await storage.set({ "handoff:1": { text: "kept" } });
    const set = new SessionIgnoreSet(storage);
    await set.add("session:a", "f1");
    await set.add("session:a", "f2");
    await set.add("session:ab", "f3");
    await set.add("session:b", "f4");
    await set.move("session:a", "doc:7");
    expect(await set.has("doc:7", "f1")).toBe(true);
    expect(await set.has("doc:7", "f2")).toBe(true);
    expect(await set.has("session:a", "f1")).toBe(false);
    expect(await set.has("session:ab", "f3")).toBe(true);
    expect(await set.has("session:b", "f4")).toBe(true);
    expect([...storage.values.keys()].sort()).toEqual(
      [
        "handoff:1",
        ignoreKey("doc:7", "f1"),
        ignoreKey("doc:7", "f2"),
        ignoreKey("session:ab", "f3"),
        ignoreKey("session:b", "f4"),
      ].sort(),
    );
  });

  it.each([
    { name: "onto itself", from: "session:a", to: "session:a" },
    { name: "from a source without pairs", from: "session:z", to: "doc:1" },
  ])("does nothing when it moves $name", async ({ from, to }) => {
    const storage = new FakeSessionStorage();
    const set = new SessionIgnoreSet(storage);
    await set.add("session:a", "f1");
    await set.move(from, to);
    expect([...storage.values.keys()]).toEqual([ignoreKey("session:a", "f1")]);
  });

  it("passes a storage failure on", async () => {
    const storage = new FakeSessionStorage();
    storage.failWith = new Error("no storage");
    const set = new SessionIgnoreSet(storage);
    await expect(set.has("session:a", "f1")).rejects.toThrow("no storage");
    await expect(set.add("session:a", "f1")).rejects.toThrow("no storage");
    await expect(set.move("session:a", "doc:1")).rejects.toThrow("no storage");
  });
});

describe("BrowserSessionStorage", () => {
  it("passes keys and items to storage.session", async () => {
    const calls: unknown[] = [];
    const api = {
      storage: {
        session: {
          get: (keys: string[] | null) => {
            calls.push(["get", keys]);
            return Promise.resolve({ a: 1 });
          },
          set: (items: object) => {
            calls.push(["set", items]);
            return Promise.resolve();
          },
          remove: (keys: string[]) => {
            calls.push(["remove", keys]);
            return Promise.resolve();
          },
        },
      },
    } as unknown as typeof browser;
    const storage = new BrowserSessionStorage(api);
    expect(await storage.get(["a", "b"])).toEqual({ a: 1 });
    expect(await storage.getAll()).toEqual({ a: 1 });
    await storage.set({ a: 1 });
    await storage.remove(["a"]);
    expect(calls).toEqual([
      ["get", ["a", "b"]],
      ["get", null],
      ["set", { a: 1 }],
      ["remove", ["a"]],
    ]);
  });
});

describe("RuntimeIgnoreSet (the page-mode frame has no storage.session)", () => {
  /** A background script that keeps the set in a fake session storage, as the real one does. */
  function background(storage = new FakeSessionStorage()) {
    const set = new SessionIgnoreSet(storage);
    const sent: unknown[] = [];
    const api = {
      sendMessage: async (message: {
        op: string;
        source: string;
        fingerprint: string;
        from: string;
        to: string;
      }) => {
        sent.push(message);
        if (message.op === "has")
          return { has: await set.has(message.source, message.fingerprint) };
        if (message.op === "add") await set.add(message.source, message.fingerprint);
        else await set.move(message.from, message.to);
        return { ok: true };
      },
    };
    return { storage, sent, ignore: new RuntimeIgnoreSet(api as never) };
  }

  it("adds a pair through the background script, into the shared storage", async () => {
    const { ignore, storage, sent } = background();
    await ignore.add("session:a", "f1");
    expect(sent).toEqual([
      { type: "page-mode-ignore", op: "add", source: "session:a", fingerprint: "f1" },
    ]);
    expect([...storage.values.keys()]).toEqual([ignoreKey("session:a", "f1")]);
    expect(await ignore.has("session:a", "f1")).toBe(true);
    expect(await ignore.has("session:a", "f2")).toBe(false);
  });

  it("moves the pairs of a source", async () => {
    const { ignore, storage } = background();
    await ignore.add("session:a", "f1");
    await ignore.move("session:a", "doc:7");
    expect([...storage.values.keys()]).toEqual([ignoreKey("doc:7", "f1")]);
  });

  it.each([
    { name: "no answer", answer: undefined },
    { name: "an answer that is not ok", answer: { ok: false } },
    { name: "a text", answer: "ok" },
  ])("fails when the background script gives $name for a change", async ({ answer }) => {
    const ignore = new RuntimeIgnoreSet({ sendMessage: () => Promise.resolve(answer) });
    await expect(ignore.add("session:a", "f1")).rejects.toBeInstanceOf(TypeError);
    await expect(ignore.move("session:a", "doc:1")).rejects.toBeInstanceOf(TypeError);
  });

  it("says no for an answer that is not a clear yes, and fails when the background script does", async () => {
    const odd = new RuntimeIgnoreSet({ sendMessage: () => Promise.resolve(undefined) });
    expect(await odd.has("session:a", "f1")).toBe(false);
    const broken = new RuntimeIgnoreSet({
      sendMessage: () => Promise.reject(new Error("gone")),
    });
    await expect(broken.has("session:a", "f1")).rejects.toThrow("gone");
  });
});
