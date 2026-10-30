import type { HostPermissionCheck } from "../core/llm/client";
import { parseHttpUrl } from "../core/llm/endpoint";

/**
 * The origin of a base URL as the match pattern the `permissions` API wants:
 * `<scheme>://<host>[:<port>]/*` (SPEC section 4.7). Undefined when the address is not `http(s)`.
 */
export function originPattern(baseUrl: string): string | undefined {
  const url = parseHttpUrl(baseUrl);
  return url === undefined ? undefined : `${url.protocol}//${url.host}/*`;
}

/**
 * Host permissions per LLM origin, asked for at runtime (SPEC sections 3.2 and 4.7). Every method
 * takes the effective base URL of an LLM (`effectiveBaseUrl`). The only place that calls
 * `browser.permissions`.
 */
export interface HostPermissions extends HostPermissionCheck {
  /** True when the origin of `baseUrl` is granted. */
  contains(baseUrl: string): Promise<boolean>;
  /**
   * Asks for the origin of `baseUrl`; true when it is (now) granted. Firefox accepts the call only
   * during a user gesture, so a click handler must call this synchronously, before any `await`.
   * It resolves to false, without asking, for an address that is not `http(s)`.
   */
  request(baseUrl: string): Promise<boolean>;
  /** Gives the origin of `baseUrl` back; true when it was removed. */
  remove(baseUrl: string): Promise<boolean>;
}

export class BrowserHostPermissions implements HostPermissions {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  contains(baseUrl: string): Promise<boolean> {
    const pattern = originPattern(baseUrl);
    if (pattern === undefined) return Promise.resolve(false);
    return this.api.permissions.contains({ origins: [pattern] });
  }

  // Not `async`: the call to the browser must happen in the same turn as the click.
  request(baseUrl: string): Promise<boolean> {
    const pattern = originPattern(baseUrl);
    if (pattern === undefined) return Promise.resolve(false);
    return this.api.permissions.request({ origins: [pattern] });
  }

  remove(baseUrl: string): Promise<boolean> {
    const pattern = originPattern(baseUrl);
    if (pattern === undefined) return Promise.resolve(false);
    return this.api.permissions.remove({ origins: [pattern] });
  }
}
