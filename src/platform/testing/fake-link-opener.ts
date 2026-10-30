import type { LinkOpener } from "../links";

/** Records the addresses it was asked to open. */
export class FakeLinkOpener implements LinkOpener {
  readonly opened: string[] = [];
  failWith: Error | undefined;

  open(url: string): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.opened.push(url);
    return Promise.resolve();
  }
}
