import type { Clock } from "../core/clock";
import type { Logger } from "../core/log";
import type { Store } from "../core/store";
import type { ChangeChannel } from "../platform/channel";
import type { PageModeBackendLink, PageModePermission } from "../platform/page-mode";
import type { HostPermissions } from "../platform/permissions";

/** Everything the options page needs from outside, so tests can pass fakes. */
export interface OptionsDeps {
  store: Store;
  channel: ChangeChannel;
  permissions: HostPermissions;
  /** The `<all_urls>` permission of page mode (SPEC section 4.11). */
  pageMode: PageModePermission;
  /** Has the background script register or unregister the content script. */
  background: PageModeBackendLink;
  /** The page's `fetch`. */
  fetch: typeof fetch;
  clock: Clock;
  log: Logger;
}
