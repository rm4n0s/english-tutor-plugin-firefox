import { describe, expect, it } from "vitest";
import { Logger } from "../core/log";
import { serialiseSavedTab, type SavedTab } from "../core/files";
import { FakeScheduler } from "../core/testing/fake-clock";
import { FakeTabStorage } from "../platform/testing/fake-tab-storage";
import { PERSIST_DELAY_MS, TabPersistence } from "./tab-persistence";

const TAB: SavedTab = {
  text: "Hello\nthere",
  source: "session:abc",
  name: "essay",
  documentId: undefined,
  lineEnding: "crlf",
  dirty: true,
};

function make(initial: string | null = null) {
  const storage = new FakeTabStorage(initial);
  const scheduler = new FakeScheduler();
  const logged: { level: string; message: string }[] = [];
  const sink = (level: string) => (message: string) => {
    logged.push({ level, message });
  };
  let snapshot = TAB;
  const persistence = new TabPersistence({
    storage,
    scheduler,
    log: new Logger({
      debug: sink("debug"),
      info: sink("info"),
      warn: sink("warn"),
      error: sink("error"),
    }),
    snapshot: () => snapshot,
  });
  return {
    storage,
    scheduler,
    persistence,
    logged,
    change: (tab: SavedTab) => {
      snapshot = tab;
    },
  };
}

describe("TabPersistence", () => {
  it.each([
    { name: "nothing stored", stored: null, expected: undefined },
    { name: "a broken value", stored: "{", expected: undefined },
    { name: "a stored tab", stored: serialiseSavedTab(TAB), expected: TAB },
  ])("restore: $name", ({ stored, expected }) => {
    expect(make(stored).persistence.restore()).toEqual(expected);
  });

  it("writes the tab's state after a pause, not at once", () => {
    const t = make();
    t.persistence.schedule();
    expect(t.storage.writes).toBe(0);
    t.scheduler.advance(PERSIST_DELAY_MS - 1);
    expect(t.storage.writes).toBe(0);
    t.scheduler.advance(1);
    expect(t.storage.writes).toBe(1);
    expect(t.persistence.restore()).toEqual(TAB);
  });

  it("writes once for many changes, with the state at the time of the write", () => {
    const t = make();
    t.persistence.schedule();
    t.persistence.schedule();
    t.change({ ...TAB, text: "changed" });
    t.persistence.schedule();
    t.scheduler.advance(PERSIST_DELAY_MS);
    expect(t.storage.writes).toBe(1);
    expect(t.persistence.restore()?.text).toBe("changed");
    // The next change starts a new wait.
    t.persistence.schedule();
    t.scheduler.advance(PERSIST_DELAY_MS);
    expect(t.storage.writes).toBe(2);
  });

  it("flush writes at once, and only when a write is waiting", () => {
    const t = make();
    t.persistence.flush();
    expect(t.storage.writes).toBe(0);
    t.persistence.schedule();
    t.persistence.flush();
    expect(t.storage.writes).toBe(1);
    expect(t.scheduler.pending).toBe(0);
    t.persistence.flush();
    expect(t.storage.writes).toBe(1);
  });

  it("destroy drops a waiting write", () => {
    const t = make();
    t.persistence.schedule();
    t.persistence.destroy();
    t.scheduler.advance(PERSIST_DELAY_MS * 2);
    expect(t.storage.writes).toBe(0);
  });

  it("logs a refused write (the quota) and goes on, without the text in the log", () => {
    const t = make();
    t.storage.failWith = new DOMException("full", "QuotaExceededError");
    t.persistence.schedule();
    t.scheduler.advance(PERSIST_DELAY_MS);
    expect(t.logged).toHaveLength(1);
    expect(t.logged[0]?.level).toBe("warn");
    expect(JSON.stringify(t.logged)).not.toContain("Hello");
    t.storage.failWith = undefined;
    t.persistence.schedule();
    t.scheduler.advance(PERSIST_DELAY_MS);
    expect(t.storage.writes).toBe(1);
  });
});
