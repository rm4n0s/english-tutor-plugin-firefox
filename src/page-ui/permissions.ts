import type { HostPermissionCheck } from "../core/llm/client";

/**
 * The host permission check of the page-mode frame. An extension frame inside a web page has only
 * a few of the extension APIs (`runtime`, `storage`, `menus`, `i18n`: checked in Firefox 159), not
 * `permissions`. It does not need it: the frame exists only while page mode is on, and page mode is
 * on only while the `<all_urls>` permission is granted, which covers the origin of every LLM. If
 * the user withdraws it, the background script switches page mode off and the page removes the
 * frame (SPEC section 4.11).
 */
export class AllUrlsPermissions implements HostPermissionCheck {
  contains(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
