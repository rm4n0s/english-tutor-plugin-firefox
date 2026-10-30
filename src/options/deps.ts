import type { Clock } from "../core/clock";
import type { Logger } from "../core/log";
import type { Store } from "../core/store";
import type { ChangeChannel } from "../platform/channel";
import type { PageModePermission, PageTabs } from "../platform/page-mode";
import type { HostPermissions } from "../platform/permissions";

/** Everything the options page needs from outside, so tests can pass fakes. */
export interface OptionsDeps {
  store: Store;
  channel: ChangeChannel;
  permissions: HostPermissions;
  /** The `<all_urls>` permission of page mode, granted at installation (SPEC section 4.11). */
  pageMode: PageModePermission;
  /** Tells the open pages that page mode changed (`page-mode-off`, `settings-changed`). */
  tabs: PageTabs;
  /** The page's `fetch`. */
  fetch: typeof fetch;
  clock: Clock;
  log: Logger;
}
