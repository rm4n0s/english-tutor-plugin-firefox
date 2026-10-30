import { describe, expect, it } from "vitest";
import { SessionTabStorage } from "./tab-storage";

class MemoryStorage {
  readonly items = new Map<string, string>();
  throwOnRead = false;
  throwOnWrite = false;
  getItem(key: string): string | null {
    if (this.throwOnRead) throw new DOMException("blocked", "SecurityError");
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new DOMException("full", "QuotaExceededError");
    this.items.set(key, value);
  }
}

describe("SessionTabStorage", () => {
  it("reads what it wrote", () => {
    const storage = new SessionTabStorage(new MemoryStorage());
    expect(storage.read()).toBeNull();
    storage.write("abc");
    expect(storage.read()).toBe("abc");
  });

  it("reads null when the browser blocks storage", () => {
    const memory = new MemoryStorage();
    memory.throwOnRead = true;
    expect(new SessionTabStorage(memory).read()).toBeNull();
  });

  it("lets a refused write throw, for the caller to log", () => {
    const memory = new MemoryStorage();
    memory.throwOnWrite = true;
    expect(() => {
      new SessionTabStorage(memory).write("x");
    }).toThrow(DOMException);
  });
});
