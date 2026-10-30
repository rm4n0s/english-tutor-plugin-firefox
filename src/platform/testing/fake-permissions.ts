import { originPattern, type HostPermissions } from "../permissions";

/** Host permissions in memory. `answer` decides what a `request` does: grant (default) or refuse. */
export class FakePermissions implements HostPermissions {
  /** The origin patterns that are granted. */
  readonly granted = new Set<string>();
  /** Every call, in order, as "method pattern". */
  readonly calls: string[] = [];
  /** What the user answers when asked. */
  answer: "grant" | "refuse" = "grant";

  contains(baseUrl: string): Promise<boolean> {
    const pattern = originPattern(baseUrl);
    this.calls.push(`contains ${pattern ?? baseUrl}`);
    return Promise.resolve(pattern !== undefined && this.granted.has(pattern));
  }

  // Not async, like the real one: the call is recorded in the turn of the click.
  request(baseUrl: string): Promise<boolean> {
    const pattern = originPattern(baseUrl);
    this.calls.push(`request ${pattern ?? baseUrl}`);
    if (pattern === undefined) return Promise.resolve(false);
    if (this.answer === "grant") this.granted.add(pattern);
    return Promise.resolve(this.granted.has(pattern));
  }

  remove(baseUrl: string): Promise<boolean> {
    const pattern = originPattern(baseUrl);
    this.calls.push(`remove ${pattern ?? baseUrl}`);
    return Promise.resolve(pattern !== undefined && this.granted.delete(pattern));
  }
}
