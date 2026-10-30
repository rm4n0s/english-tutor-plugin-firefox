import { describe, expect, it } from "vitest";
import { CountingRandom } from "../analysis/testing/helpers";
import { AppError } from "../errors";
import { FakeClock } from "../testing/fake-clock";
import { FakeSessionStorage } from "../../platform/testing/fake-session-storage";
import { HANDOFF_MAX_AGE_MS, handoffFragment, HandoffStore, parseHandoffFragment } from "./handoff";

const KEY = "0a1b2c3d-0000-4000-8000-0123456789ab";

function setup() {
  const storage = new FakeSessionStorage();
  const clock = new FakeClock(5_000);
  const store = new HandoffStore(storage, clock, new CountingRandom());
  return { storage, clock, store };
}

describe("the address fragment", () => {
  it("holds only the key", () => {
    expect(handoffFragment(KEY)).toBe(`#handoff=${KEY}`);
    expect(parseHandoffFragment(handoffFragment(KEY))).toBe(KEY);
  });

  it.each([
    "",
    "#",
    "#handoff=",
    "#handoff=abc",
    `#other=${KEY}`,
    `handoff=${KEY}`,
    `#handoff=${KEY}x`,
    `#handoff=ignore:session:abc|ff`,
    `#handoff=${KEY.toUpperCase()}`,
  ])("is not a hand-off: %j", (fragment) => {
    expect(parseHandoffFragment(fragment)).toBeUndefined();
  });
});

describe("HandoffStore", () => {
  it.each([
    { action: "check", text: "He go to school." },
    { action: "alternatives", text: "make a photo\nwith a second line" },
    { action: "check", text: "" },
  ] as const)("puts in and takes out a $action entry once", async ({ action, text }) => {
    const { storage, store } = setup();
    const key = await store.put(text, action);
    expect(parseHandoffFragment(handoffFragment(key))).toBe(key);
    expect(storage.values.size).toBe(1);
    expect(await store.take(key)).toEqual({ text, action, at: 5_000 });
    // Taking deletes the entry: the same address opened again is expired.
    expect(storage.values.size).toBe(0);
    const err = await store.take(key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("HandoffStore.take->HandoffExpired")).toBe(true);
  });

  it("gives every entry its own key", async () => {
    const { storage, store } = setup();
    const a = await store.put("a", "check");
    const b = await store.put("b", "check");
    expect(a).not.toBe(b);
    expect(storage.values.size).toBe(2);
    expect((await store.take(b)).text).toBe("b");
    expect((await store.take(a)).text).toBe("a");
  });

  it.each([
    { name: "missing", value: undefined },
    { name: "not an object", value: "text" },
    { name: "a wrong action", value: { text: "t", action: "delete", at: 1 } },
    { name: "a wrong text", value: { text: 4, action: "check", at: 1 } },
    { name: "a wrong time", value: { text: "t", action: "check", at: "now" } },
  ])("HandoffExpired for an entry that is $name", async ({ value }) => {
    const { storage, store } = setup();
    if (value !== undefined) storage.values.set(`handoff:${KEY}`, value);
    const err = await store.take(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("HandoffStore.take->HandoffExpired")).toBe(true);
    // The message names no text.
    expect((err as AppError).message).toMatch(/no longer available/);
  });

  it("HandoffExpired, with the cause, when storage.session fails", async () => {
    const { storage, store } = setup();
    storage.failWith = new Error("storage broke");
    const err = await store.take(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("HandoffStore.take->HandoffExpired")).toBe(true);
    expect((err as AppError).cause).toBe(storage.failWith);
  });

  it("does not read other entries of storage.session", async () => {
    const { storage, store } = setup();
    storage.values.set(`ignore:${KEY}`, { text: "t", action: "check", at: 1 });
    const err = await store.take(KEY).catch((e: unknown) => e);
    expect((err as AppError).tag).toBe("HandoffExpired");
    expect(storage.values.size).toBe(1);
  });

  describe("sweep", () => {
    it.each([
      { age: 0, gone: false },
      { age: HANDOFF_MAX_AGE_MS - 1, gone: false },
      { age: HANDOFF_MAX_AGE_MS, gone: false },
      { age: HANDOFF_MAX_AGE_MS + 1, gone: true },
      { age: 24 * 3600 * 1000, gone: true },
    ])("an entry $age ms old is gone: $gone", async ({ age, gone }) => {
      const { storage, clock, store } = setup();
      const key = await store.put("t", "check");
      clock.advance(age);
      expect(await store.sweep()).toBe(gone ? 1 : 0);
      expect(storage.values.has(`handoff:${key}`)).toBe(!gone);
    });

    it("leaves what is not a hand-off entry, and removes a broken one", async () => {
      const { storage, store } = setup();
      storage.values.set("ignore:session:a|ff", true);
      storage.values.set("handoff:broken", { nope: true });
      expect(await store.sweep()).toBe(1);
      expect([...storage.values.keys()]).toEqual(["ignore:session:a|ff"]);
    });
  });
});
