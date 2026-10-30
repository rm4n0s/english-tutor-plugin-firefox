import type { Clock, Scheduler } from "../core/clock";
import type { Logger } from "../core/log";
import type { Random } from "../core/random";
import type { Store } from "../core/store";
import type { ChangeChannel } from "../platform/channel";
import type { LinkOpener } from "../platform/links";
import type { HostPermissions } from "../platform/permissions";

/** Everything the tutor page needs from outside, so tests can pass fakes. */
export interface TutorDeps {
  store: Store;
  channel: ChangeChannel;
  permissions: HostPermissions;
  /** The page's `fetch`. */
  fetch: typeof fetch;
  clock: Clock;
  scheduler: Scheduler;
  /** The source of delimiter tokens of the check prompt. */
  random: Random;
  log: Logger;
  /** Opens a link of an explanation in a new tab next to this one. */
  links: LinkOpener;
  /** Opens the options page (the Prefs button, and the link in the no-LLM hint). */
  openOptions(): void;
}
