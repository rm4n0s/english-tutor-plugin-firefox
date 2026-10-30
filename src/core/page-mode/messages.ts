import { isSiteHost } from "../store/settings";
import { FRAME_ID_PATTERN } from "./protocol";

/**
 * The `runtime` messages of page mode (SPEC section 4.11) between the content script, the options
 * page and the background script. Plain data, no `browser.*`. Page scripts cannot send or receive
 * `runtime` messages, so these never come from a web page's own code.
 */

/** The options page asks the background script to make the registration match the settings. */
export const PAGE_MODE_APPLY = "page-mode-apply";
/**
 * The content script asks what page mode does on its host. The answer is a `SiteConfig`: the
 * site's state, and for `ask` the server of the LLM in use, for the prompt's note.
 */
export const PAGE_MODE_CONFIG = "page-mode-config";
/** The content script tells the background script the choice made in the prompt (`SiteRequest`). */
export const PAGE_MODE_SITE = "page-mode-site";
/** The content script hands the text of a text box to a new tutor tab (the blocked badge). */
export const PAGE_MODE_OPEN_TUTOR = "page-mode-open-tutor";
/** The background script tells the open pages that page mode was turned off: remove everything. */
export const PAGE_MODE_OFF = "page-mode-off";
/** The background script tells the open pages that a setting changed: ask again. */
export const SETTINGS_CHANGED = "settings-changed";

/** The content script tells the background script the id of the frame it is about to make. */
export const PAGE_FRAME_REGISTER = "page-frame-register";
/** A page-mode frame asks the background script whether it is the one that was registered. */
export const PAGE_FRAME_CLAIM = "page-frame-claim";

/** The most text a hand-off from a text box carries: 10,000 words of 20 characters at most. */
export const MAX_HANDOFF_CHARS = 200_000;

export interface ConfigRequest {
  type: typeof PAGE_MODE_CONFIG;
  /** The host name of the page (`location.hostname`). */
  host: string;
}

/** What page mode does on a site (SPEC section 4.11): `later` is "Not now", until the browser restarts. */
export type SiteState = "on" | "off" | "ask" | "later";

/** The server of the LLM in use, for the prompt's note: the host and port only, never a key. */
export interface PromptServer {
  /** `host` or `host:port`. */
  server: string;
  /** Whether the server is on this computer. */
  local: boolean;
}

/** The background script's answer to `page-mode-config`. */
export type SiteConfig =
  { state: "on" | "off" | "later" } | { state: "ask"; llm: PromptServer | null };

/** The choices the prompt offers. */
export type PromptChoice = "on" | "off" | "later";

export interface SiteRequest {
  type: typeof PAGE_MODE_SITE;
  host: string;
  choice: PromptChoice;
}

export interface OpenTutorRequest {
  type: typeof PAGE_MODE_OPEN_TUTOR;
  text: string;
}

export interface FrameIdRequest {
  type: typeof PAGE_FRAME_REGISTER | typeof PAGE_FRAME_CLAIM;
  id: string;
}

/** The type of a message, or undefined when it is not an object with a string `type`. */
export function messageType(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

export function parseConfigRequest(message: unknown): ConfigRequest | undefined {
  if (messageType(message) !== PAGE_MODE_CONFIG) return undefined;
  const host = (message as { host?: unknown }).host;
  if (typeof host !== "string" || host.length > 253) return undefined;
  return { type: PAGE_MODE_CONFIG, host };
}

/** The state in an answer of the background script, or undefined for anything else. */
export function parseSiteConfig(answer: unknown): SiteConfig | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const { state, llm } = answer as { state?: unknown; llm?: unknown };
  if (state === "on" || state === "off" || state === "later") return { state };
  if (state !== "ask") return undefined;
  if (llm === null || llm === undefined) return { state, llm: null };
  if (typeof llm !== "object") return undefined;
  const { server, local } = llm as { server?: unknown; local?: unknown };
  if (typeof server !== "string" || server === "" || server.length > 300) return undefined;
  if (typeof local !== "boolean") return undefined;
  return { state, llm: { server, local } };
}

export function parseSiteRequest(message: unknown): SiteRequest | undefined {
  if (messageType(message) !== PAGE_MODE_SITE) return undefined;
  const { host, choice } = message as { host?: unknown; choice?: unknown };
  if (typeof host !== "string" || !isSiteHost(host)) return undefined;
  if (choice !== "on" && choice !== "off" && choice !== "later") return undefined;
  return { type: PAGE_MODE_SITE, host, choice };
}

export function parseOpenTutorRequest(message: unknown): OpenTutorRequest | undefined {
  if (messageType(message) !== PAGE_MODE_OPEN_TUTOR) return undefined;
  const text = (message as { text?: unknown }).text;
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_HANDOFF_CHARS) {
    return undefined;
  }
  return { type: PAGE_MODE_OPEN_TUTOR, text };
}

/** A register or claim message with a well-formed frame id, or undefined. */
export function parseFrameIdRequest(
  message: unknown,
  type: FrameIdRequest["type"],
): FrameIdRequest | undefined {
  if (messageType(message) !== type) return undefined;
  const id = (message as { id?: unknown }).id;
  if (typeof id !== "string" || !FRAME_ID_PATTERN.test(id)) return undefined;
  return { type, id };
}

/** The messages the background script sends to the open pages. */
export type PageBroadcast = typeof PAGE_MODE_OFF | typeof SETTINGS_CHANGED;

/** The broadcast a page received, or undefined for anything else (a tutor ping, a stray message). */
export function parseBroadcast(message: unknown): PageBroadcast | undefined {
  const type = messageType(message);
  return type === PAGE_MODE_OFF || type === SETTINGS_CHANGED ? type : undefined;
}
