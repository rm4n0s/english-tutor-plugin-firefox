/**
 * The messages on the channel between the page-mode content script and its frame (SPEC section
 * 4.11). The content script finds text boxes and keeps their text; the frame (`page-ui.html`)
 * keeps each box's issue state, runs the checks and answers with the issues and the badge state.
 * Plain data. Every message is checked on arrival: the other side is trusted to be this
 * extension's code, but a message is still just data.
 */
import { CATEGORIES, type Category } from "../analysis/taxonomy";

/**
 * How the content script and the frame find each other. Firefox does not deliver a content
 * script's `runtime.connect` or `runtime.sendMessage` to an extension frame inside a web page
 * (checked in Firefox 159), so the content script makes a `MessageChannel` and gives one end to
 * the frame with `postMessage` to the frame's window (addressed to the extension's origin only,
 * so only the frame gets it). Everything after that goes over the channel, which no script of the
 * page can see. The first message names the frame by the random id that is also in the frame's
 * address, and the frame accepts exactly one port, the one with its own id.
 */
export const CONNECT_TYPE = "english-tutor-page-ui";

/** A random id has 36 characters (a UUID); anything else is not one of ours. */
export const FRAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The message that carries the port to the frame. */
export function connectMessage(id: string): { type: typeof CONNECT_TYPE; id: string } {
  return { type: CONNECT_TYPE, id };
}

/** The id in a connect message, or undefined when the data is not one. */
export function parseConnectMessage(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { type, id } = data as { type?: unknown; id?: unknown };
  return type === CONNECT_TYPE && typeof id === "string" && FRAME_ID_PATTERN.test(id)
    ? id
    : undefined;
}

/** The id in the frame's address fragment (`#<id>`), or undefined. */
export function frameIdOfFragment(fragment: string): string | undefined {
  const id = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return FRAME_ID_PATTERN.test(id) ? id : undefined;
}

/** The most words of a text box that is checked (SPEC section 4.11). */
export const MAX_WORDS = 10_000;
/** The fewest words of a text box that is checked. */
export const MIN_WORDS = 3;

/** Content script to frame. */
export type ContentMessage =
  /** The box got the focus. The first one for a box carries its `session:` source. */
  | { type: "focus"; box: number; source: string; revision: number; text: string }
  /** The text is now `text.slice(0, start) + inserted + text.slice(start + removed)`. */
  | {
      type: "edit";
      box: number;
      /** The box's revision after this edit: the previous one plus one. */
      revision: number;
      start: number;
      removed: number;
      inserted: string;
    }
  /** The whole text again, after a `resync` request. */
  | { type: "text"; box: number; revision: number; text: string }
  | { type: "blur"; box: number }
  /** The box left the page, or page mode was turned off for it. */
  | { type: "forget"; box: number }
  /**
   * Show the explanation popover for this issue (or switch it to this issue). `maxHeight` is the
   * room the card has in the page, in CSS pixels (SPEC section 4.11).
   */
  | { type: "popover-open"; box: number; issue: number; maxHeight: number }
  /** The popover was closed by the page (Escape, a click elsewhere, typing): drop the selection. */
  | { type: "popover-close"; box: number }
  /**
   * Show the issues dialog for this box (SPEC section 4.11). `issue` is the issue to select in it
   * (the one the popover showed when All issues was pressed), or null.
   */
  | { type: "dialog-open"; box: number; issue: number | null }
  /** The dialog was closed by the page (Escape, another box's dialog, the popover): drop the selection. */
  | { type: "dialog-close"; box: number };

export type BoxStatus = "idle" | "checking" | "checked" | "failed" | "no-llm" | "too-long";

/** An issue as the content script needs it: where to draw, and its category. */
export interface WireIssue {
  id: number;
  start: number;
  /** Exclusive. */
  end: number;
  category: Category;
}

/** Frame to content script. */
export type FrameMessage =
  /** The frame is connected and listening. */
  | { type: "ready" }
  /** The state of one box, valid for the text at `revision`. */
  | {
      type: "state";
      box: number;
      revision: number;
      status: BoxStatus;
      /** Why a check failed, or why there is none (no LLM, too long). Never the text or a reply. */
      message?: string;
      issues: WireIssue[];
    }
  /** The frame lost track of the box's text: send it again (`text`). */
  | { type: "resync"; box: number }
  /** The popover for this issue is drawn and is `height` CSS pixels high (and again when that changes). */
  | { type: "popover-size"; box: number; issue: number; height: number }
  /** The frame closed the popover (Escape in the card, Not an error, an issue that is gone). */
  | { type: "popover-closed"; box: number }
  /** All issues was pressed in the popover: the content script opens the issues dialog. */
  | { type: "all-issues"; box: number }
  /** The dialog is drawn for this box: the content script may show the frame as the dialog. */
  | { type: "dialog-ready"; box: number }
  /** The issue selected in the dialog's list changed (null: none): highlight it and scroll to it. */
  | { type: "dialog-select"; box: number; issue: number | null }
  /** The frame closed the dialog (Close, Escape in the dialog, a box that is gone). */
  | { type: "dialog-closed"; box: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function uint(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const STATUSES: readonly BoxStatus[] = [
  "idle",
  "checking",
  "checked",
  "failed",
  "no-llm",
  "too-long",
];

export function parseContentMessage(data: unknown): ContentMessage | undefined {
  const m = record(data);
  if (m === undefined) return undefined;
  const box = uint(m.box);
  if (box === undefined) return undefined;
  switch (m.type) {
    case "focus": {
      const revision = uint(m.revision);
      if (revision === undefined || typeof m.source !== "string" || typeof m.text !== "string") {
        return undefined;
      }
      return { type: "focus", box, source: m.source, revision, text: m.text };
    }
    case "edit": {
      const revision = uint(m.revision);
      const start = uint(m.start);
      const removed = uint(m.removed);
      if (
        revision === undefined ||
        start === undefined ||
        removed === undefined ||
        typeof m.inserted !== "string"
      ) {
        return undefined;
      }
      return { type: "edit", box, revision, start, removed, inserted: m.inserted };
    }
    case "text": {
      const revision = uint(m.revision);
      if (revision === undefined || typeof m.text !== "string") return undefined;
      return { type: "text", box, revision, text: m.text };
    }
    case "blur":
      return { type: "blur", box };
    case "forget":
      return { type: "forget", box };
    case "popover-open": {
      const issue = uint(m.issue);
      const maxHeight = uint(m.maxHeight);
      if (issue === undefined || maxHeight === undefined) return undefined;
      return { type: "popover-open", box, issue, maxHeight };
    }
    case "popover-close":
      return { type: "popover-close", box };
    case "dialog-open": {
      const issue = m.issue === null || m.issue === undefined ? null : uint(m.issue);
      if (issue === undefined) return undefined;
      return { type: "dialog-open", box, issue };
    }
    case "dialog-close":
      return { type: "dialog-close", box };
    default:
      return undefined;
  }
}

function parseIssues(value: unknown): WireIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: WireIssue[] = [];
  for (const item of value as unknown[]) {
    const i = record(item);
    if (i === undefined) return undefined;
    const id = uint(i.id);
    const start = uint(i.start);
    const end = uint(i.end);
    const category = CATEGORIES.find((c) => c === i.category);
    if (id === undefined || start === undefined || end === undefined || category === undefined) {
      return undefined;
    }
    if (end < start) return undefined;
    issues.push({ id, start, end, category });
  }
  return issues;
}

export function parseFrameMessage(data: unknown): FrameMessage | undefined {
  const m = record(data);
  if (m === undefined) return undefined;
  if (m.type === "ready") return { type: "ready" };
  const box = uint(m.box);
  if (box === undefined) return undefined;
  if (m.type === "resync") return { type: "resync", box };
  if (m.type === "popover-closed") return { type: "popover-closed", box };
  if (m.type === "all-issues") return { type: "all-issues", box };
  if (m.type === "dialog-ready") return { type: "dialog-ready", box };
  if (m.type === "dialog-closed") return { type: "dialog-closed", box };
  if (m.type === "dialog-select") {
    const issue = m.issue === null ? null : uint(m.issue);
    if (issue === undefined) return undefined;
    return { type: "dialog-select", box, issue };
  }
  if (m.type === "popover-size") {
    const issue = uint(m.issue);
    const height = uint(m.height);
    if (issue === undefined || height === undefined) return undefined;
    return { type: "popover-size", box, issue, height };
  }
  if (m.type !== "state") return undefined;
  const revision = uint(m.revision);
  const status = STATUSES.find((s) => s === m.status);
  const issues = parseIssues(m.issues);
  if (revision === undefined || status === undefined || issues === undefined) return undefined;
  if (m.message !== undefined && typeof m.message !== "string") return undefined;
  return {
    type: "state",
    box,
    revision,
    status,
    ...(typeof m.message === "string" ? { message: m.message } : {}),
    issues,
  };
}

/** The text after an edit message, or undefined when the edit does not fit `text`. */
export function applyEditMessage(
  text: string,
  edit: { start: number; removed: number; inserted: string },
): string | undefined {
  if (edit.start + edit.removed > text.length) return undefined;
  return text.slice(0, edit.start) + edit.inserted + text.slice(edit.start + edit.removed);
}
