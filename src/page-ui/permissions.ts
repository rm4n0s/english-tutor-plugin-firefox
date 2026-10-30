import type { HostPermissionCheck } from "../core/llm/client";

/**
 * The host permission check of the page-mode frame. An extension frame inside a web page has only
 * a few of the extension APIs (`runtime`, `storage`, `menus`, `i18n`: checked in Firefox 159), not
 * `permissions`. It does not need it: the frame exists only where the content script runs, which
 * needs access to the site, and `<all_urls>` (granted at installation) covers the origin of every
 * LLM. If the user withdraws the access, the background script answers `off` and the page removes
 * the frame (SPEC section 4.11).
 */
export class AllUrlsPermissions implements HostPermissionCheck {
  contains(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
