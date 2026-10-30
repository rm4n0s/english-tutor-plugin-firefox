import type { PageFragment } from "../fragment";

/** An address fragment in memory. */
export class FakeFragment implements PageFragment {
  hash: string;
  cleared = 0;

  constructor(hash = "") {
    this.hash = hash;
  }

  get(): string {
    return this.hash;
  }

  clear(): void {
    this.hash = "";
    this.cleared++;
  }
}
