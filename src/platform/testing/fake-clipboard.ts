import type { Clipboard } from "../clipboard";

/** The clipboard in memory. */
export class FakeClipboard implements Clipboard {
  readonly written: string[] = [];
  failWith: Error | undefined;

  writeText(text: string): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.written.push(text);
    return Promise.resolve();
  }
}
