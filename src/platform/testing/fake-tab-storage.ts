import type { TabStorage } from "../tab-storage";

/** A tab's `sessionStorage` in memory, which a test can make fail. */
export class FakeTabStorage implements TabStorage {
  value: string | null;
  failWith: Error | undefined;
  writes = 0;

  constructor(value: string | null = null) {
    this.value = value;
  }

  read(): string | null {
    return this.value;
  }

  write(value: string): void {
    if (this.failWith !== undefined) throw this.failWith;
    this.writes++;
    this.value = value;
  }
}
