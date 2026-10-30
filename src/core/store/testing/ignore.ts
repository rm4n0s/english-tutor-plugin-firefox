import type { IgnoreSet } from "../stats";

/** An ignore set in memory, which a test can make fail. */
export class MemoryIgnoreSet implements IgnoreSet {
  readonly pairs = new Set<string>();
  failWith: Error | undefined;

  has(source: string, fingerprint: string): Promise<boolean> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(this.pairs.has(`${source}|${fingerprint}`));
  }

  add(source: string, fingerprint: string): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.pairs.add(`${source}|${fingerprint}`);
    return Promise.resolve();
  }
}
