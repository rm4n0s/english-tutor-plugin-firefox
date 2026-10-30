import type { Scheduler } from "../core/clock";
import { AppError } from "../core/errors";
import type { Logger } from "../core/log";
import {
  parseFrameMessage,
  type ContentMessage,
  type FrameMessage,
} from "../core/page-mode/protocol";
import type { Random } from "../core/random";
import type { PageConnector, PagePort } from "../platform/page-port";
import { applyCss } from "./style";

/** The frame has this long to load and answer (SPEC section 4.11). */
export const FRAME_TIMEOUT_MS = 5000;

export const FRAME_BLOCKED_MESSAGE = "This site does not let English Tutor show its panel";

export interface FrameLinkDeps {
  doc: Document;
  /** Where the frame goes: the layer of the overlay host. */
  parent: HTMLElement;
  connector: PageConnector;
  /** The address of the frame for an id. */
  frameUrl(id: string): string;
  /** Tells the background script the id, before the frame is made (SPEC section 4.11). */
  register(id: string): Promise<void>;
  scheduler: Scheduler;
  random: Random;
  log: Logger;
  timeoutMs?: number;
}

export interface FrameLinkHandlers {
  /** The frame is connected and listening. */
  onReady(): void;
  onMessage(message: FrameMessage): void;
  /** The frame could not be reached, or went away. The error is `PageFrameBlocked`. */
  onBlocked(error: AppError): void;
}

type LinkState = "idle" | "starting" | "ready" | "blocked" | "closed";

/**
 * The content script's link to its frame (SPEC section 4.11): a hidden `<iframe>` of
 * `page-ui.html` in the overlay's closed shadow root, made when the first text box is focused, and
 * a private `MessageChannel` whose second end goes to the frame with `postMessage` (see
 * `core/page-mode/protocol.ts`). The random id is in the frame's address fragment and in the first
 * message, so the frame accepts only this channel. A page's script cannot see the channel. The id
 * is registered with the background script first, and the frame has to claim it from the same tab
 * (`core/page-mode/frame-claims.ts`), so a frame that a page makes by itself does not start.
 *
 * If the page's Content Security Policy keeps the frame from loading, the frame never answers
 * within 5 seconds: the link is blocked, with `PageFrameBlocked`, and the badge says so.
 */
export class FrameLink {
  private readonly deps: FrameLinkDeps;
  private readonly handlers: FrameLinkHandlers;
  private current: LinkState = "idle";
  private iframe: HTMLIFrameElement | undefined;
  private port: PagePort | undefined;
  private cancelTimer: (() => void) | undefined;
  private readonly queue: ContentMessage[] = [];

  constructor(deps: FrameLinkDeps, handlers: FrameLinkHandlers) {
    this.deps = deps;
    this.handlers = handlers;
  }

  get state(): LinkState {
    return this.current;
  }

  /** Makes the frame, once. Later calls do nothing. */
  start(): void {
    if (this.current !== "idle") return;
    this.current = "starting";
    const { scheduler } = this.deps;
    const id = this.deps.random.uuid();
    this.cancelTimer = scheduler.after(this.deps.timeoutMs ?? FRAME_TIMEOUT_MS, () => {
      this.cancelTimer = undefined;
      this.block("FrameLink.start");
    });
    // The background script must know the id before the frame asks about it: a frame that a web
    // page makes by itself is not registered, and does not start.
    this.deps.register(id).then(
      () => {
        this.makeFrame(id);
      },
      () => {
        this.block("FrameLink.register");
      },
    );
  }

  private makeFrame(id: string): void {
    // Closed or blocked while the registration was on its way.
    if (this.current !== "starting" || this.iframe !== undefined) return;
    const { doc, parent } = this.deps;
    const iframe = doc.createElement("iframe");
    iframe.setAttribute("title", "English Tutor");
    iframe.setAttribute("aria-hidden", "true");
    // Hidden for now: the popover and the dialog (steps 14 and 15) show it.
    applyCss(iframe, {
      all: "initial",
      display: "none",
      width: "0",
      height: "0",
      border: "0",
    });
    this.iframe = iframe;
    iframe.addEventListener("load", () => {
      this.connect(id);
    });
    iframe.src = this.deps.frameUrl(id);
    parent.append(iframe);
  }

  /** Sends a message to the frame; it waits until the frame says it is ready. */
  post(message: ContentMessage): void {
    if (this.current === "ready" && this.port !== undefined) this.port.post(message);
    else if (this.current === "starting" || this.current === "idle") this.queue.push(message);
  }

  /** Takes the frame and the port away. */
  close(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.current = "closed";
    this.queue.length = 0;
    const port = this.port;
    this.port = undefined;
    port?.disconnect();
    this.iframe?.remove();
    this.iframe = undefined;
  }

  private connect(id: string): void {
    // A load that comes after the 5 seconds, or after close, does nothing.
    if (this.current !== "starting" || this.port !== undefined) return;
    const frameWindow = this.iframe?.contentWindow;
    if (frameWindow === null || frameWindow === undefined) {
      this.block("FrameLink.connect");
      return;
    }
    let port: PagePort;
    try {
      // `protocol` and `host`, not `origin`: the origin of a moz-extension address is opaque in
      // some engines, and the port must be addressed to exactly this extension.
      const url = new URL(this.deps.frameUrl(id));
      port = this.deps.connector.connect(
        { window: frameWindow, origin: `${url.protocol}//${url.host}` },
        id,
      );
    } catch {
      this.block("FrameLink.connect");
      return;
    }
    this.port = port;
    port.onMessage((data) => {
      const message = parseFrameMessage(data);
      if (message === undefined) return;
      if (message.type === "ready") {
        if (this.current !== "starting") return;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
        this.current = "ready";
        for (const queued of this.queue.splice(0)) port.post(queued);
        this.handlers.onReady();
        return;
      }
      if (this.current === "ready") this.handlers.onMessage(message);
    });
    port.onDisconnect(() => {
      if (this.current === "starting" || this.current === "ready") this.block("FrameLink.connect");
    });
  }

  private block(where: string): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.current = "blocked";
    this.queue.length = 0;
    const port = this.port;
    this.port = undefined;
    port?.disconnect();
    this.iframe?.remove();
    this.iframe = undefined;
    const error = new AppError("PageFrameBlocked", FRAME_BLOCKED_MESSAGE, {}).via(where);
    this.deps.log.warn("the page-mode frame is blocked", { err: error });
    this.handlers.onBlocked(error);
  }
}
