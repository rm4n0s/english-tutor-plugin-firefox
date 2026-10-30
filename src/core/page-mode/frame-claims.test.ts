import { describe, expect, it } from "vitest";
import { FakeSessionStorage } from "../../platform/testing/fake-session-storage";
import { FakeClock } from "../testing/fake-clock";
import { FRAME_CLAIM_MAX_AGE_MS, FrameClaims } from "./frame-claims";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = 5_000_000;

function setup() {
  const storage = new FakeSessionStorage();
  const clock = new FakeClock(NOW);
  return { storage, clock, claims: new FrameClaims(storage, clock) };
}

describe("FrameClaims: register and claim", () => {
  it("stores the tab and the time under the id", async () => {
    const { storage, claims } = setup();
    await claims.register(ID, 7);
    expect(storage.values.get(`page-frame:${ID}`)).toEqual({ tabId: 7, at: NOW });
  });

  it("grants a claim from the tab that registered the id, and deletes the entry", async () => {
    const { storage, claims } = setup();
    await claims.register(ID, 7);
    expect(await claims.claim(ID, 7)).toBe(true);
    expect(storage.values.size).toBe(0);
  });

  it("grants an id once: the second claim is refused", async () => {
    const { claims } = setup();
    await claims.register(ID, 7);
    expect(await claims.claim(ID, 7)).toBe(true);
    expect(await claims.claim(ID, 7)).toBe(false);
  });

  it.each([
    { name: "an id nobody registered (a frame a page made by itself)", claimId: OTHER, tab: 7 },
    { name: "a claim from another tab", claimId: ID, tab: 8 },
    { name: "a claim with no tab", claimId: ID, tab: undefined },
  ])("refuses $name", async ({ claimId, tab }) => {
    const { claims } = setup();
    await claims.register(ID, 7);
    expect(await claims.claim(claimId, tab)).toBe(false);
  });

  it("deletes the entry when the claim is refused, so the right tab cannot claim it afterwards", async () => {
    const { claims } = setup();
    await claims.register(ID, 7);
    expect(await claims.claim(ID, 8)).toBe(false);
    expect(await claims.claim(ID, 7)).toBe(false);
  });

  it.each([
    { name: "just inside 5 minutes", age: FRAME_CLAIM_MAX_AGE_MS, granted: true },
    { name: "1 ms over 5 minutes", age: FRAME_CLAIM_MAX_AGE_MS + 1, granted: false },
  ])("claims an id registered $name ago: $granted", async ({ age, granted }) => {
    const { clock, claims } = setup();
    await claims.register(ID, 7);
    clock.advance(age);
    expect(await claims.claim(ID, 7)).toBe(granted);
  });

  it("refuses and deletes an entry that is not one", async () => {
    const { storage, claims } = setup();
    storage.values.set(`page-frame:${ID}`, { tabId: "7", at: NOW });
    expect(await claims.claim(ID, 7)).toBe(false);
    expect(storage.values.size).toBe(0);
  });

  it("fails when the storage fails: the caller treats it as a refusal", async () => {
    const { storage, claims } = setup();
    storage.failWith = new Error("storage gone");
    await expect(claims.claim(ID, 7)).rejects.toThrow("storage gone");
    await expect(claims.register(ID, 7)).rejects.toThrow("storage gone");
  });
});

describe("FrameClaims: sweep", () => {
  it("deletes the entries older than 5 minutes and any that is not one, and nothing else", async () => {
    const { storage, claims } = setup();
    storage.values.set(`page-frame:${ID}`, { tabId: 1, at: NOW - FRAME_CLAIM_MAX_AGE_MS - 1 });
    storage.values.set(`page-frame:${OTHER}`, { tabId: 1, at: NOW - FRAME_CLAIM_MAX_AGE_MS });
    storage.values.set("page-frame:broken", { tabId: "x" });
    storage.values.set("handoff:a", { text: "T", action: "check", at: 0 });
    storage.values.set("ignore:session:a|ff", true);
    expect(await claims.sweep()).toBe(2);
    expect([...storage.values.keys()].sort()).toEqual([
      "handoff:a",
      "ignore:session:a|ff",
      `page-frame:${OTHER}`,
    ]);
  });
});
