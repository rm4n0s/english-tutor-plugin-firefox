import type { SessionStorage } from "../session-storage";

/** `storage.session` in memory, which a test can make fail. Tabs share one instance. */
export class FakeSessionStorage implements SessionStorage {
  readonly values = new Map<string, unknown>();
  failWith: Error | undefined;

  get(keys: readonly string[]): Promise<Record<string, unknown>> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const found: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.values.has(key)) found[key] = this.values.get(key);
    }
    return Promise.resolve(found);
  }

  getAll(): Promise<Record<string, unknown>> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(Object.fromEntries(this.values));
  }

  set(items: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
    return Promise.resolve();
  }

  remove(keys: readonly string[]): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    for (const key of keys) this.values.delete(key);
    return Promise.resolve();
  }
}
