import { describe, expect, it } from "vitest";
import { ignoreKey, SessionIgnoreSet } from "./ignore-set";
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

  it("passes a storage failure on", async () => {
    const storage = new FakeSessionStorage();
    storage.failWith = new Error("no storage");
    const set = new SessionIgnoreSet(storage);
    await expect(set.has("session:a", "f1")).rejects.toThrow("no storage");
    await expect(set.add("session:a", "f1")).rejects.toThrow("no storage");
  });
});

describe("BrowserSessionStorage", () => {
  it("passes keys and items to storage.session", async () => {
    const calls: unknown[] = [];
    const api = {
      storage: {
        session: {
          get: (keys: string[]) => {
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
    await storage.set({ a: 1 });
    await storage.remove(["a"]);
    expect(calls).toEqual([
      ["get", ["a", "b"]],
      ["set", { a: 1 }],
      ["remove", ["a"]],
    ]);
  });
});
