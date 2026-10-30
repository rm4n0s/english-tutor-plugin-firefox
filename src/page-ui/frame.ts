import type { AnalysisModel } from "../core/analysis";
import type { Clock, Scheduler } from "../core/clock";
import type { CheckRunner } from "../core/issues";
import type { Logger } from "../core/log";
import {
  parseContentMessage,
  type ContentMessage,
  type FrameMessage,
} from "../core/page-mode/protocol";
import type { PagePort, PagePortServer } from "../platform/page-port";
import { BoxSession } from "./box-session";

/** What the frame needs once the store is open. */
export interface FrameServices {
  clock: Clock;
  scheduler: Scheduler;
  runner: CheckRunner;
  settings: {
    readonly delaySeconds: number;
    getModel(): AnalysisModel | undefined;
    load(): Promise<void>;
  };
}

export interface PageFrameDeps {
  /** The id in the frame's address: the one port name this frame accepts. */
  id: string;
  server: PagePortServer;
  /** Resolves when the store is open and the settings are read. */
  services: Promise<FrameServices>;
  log: Logger;
}

/**
 * The page-mode frame (`page-ui.html`, SPEC section 4.11): an extension page inside a web page.
 * It accepts exactly one port, the one offered with its own id (the id is in its address and
 * was made by the content script; a port offered with another id is not its own and is ignored),
 * and then holds the issue state of each text box of that page: it runs the automatic checks (on
 * focus, and after the pause in typing), and answers with the issues and the badge state. The
 * messages are handled one at a time, in the order they arrive, once the store is open.
 *
 * Construct it synchronously when the script starts, so that no `runtime.connect` is missed.
 */
export class PageFrame {
  private readonly deps: PageFrameDeps;
  private port: PagePort | undefined;
  private services: FrameServices | undefined;
  private queue: Promise<void>;
  private readonly sessions = new Map<number, BoxSession>();

  constructor(deps: PageFrameDeps) {
    this.deps = deps;
    this.queue = deps.services.then(
      (services) => {
        this.services = services;
      },
      (err: unknown) => {
        deps.log.error("the page-mode frame could not open the store", { err });
      },
    );
    deps.server.onConnect((port, id) => {
      this.accept(port, id);
    });
  }

  /** The number of text boxes the frame holds state for. */
  get boxes(): number {
    return this.sessions.size;
  }

  session(box: number): BoxSession | undefined {
    return this.sessions.get(box);
  }

  /** Resolves when every message received so far has been handled. */
  idle(): Promise<void> {
    return this.queue;
  }

  private accept(port: PagePort, id: string): void {
    // Not offered with this frame's id, or a second one: ignored.
    if (id !== this.deps.id || this.port !== undefined) return;
    this.port = port;
    port.onMessage((data) => {
      const message = parseContentMessage(data);
      if (message === undefined) return;
      this.queue = this.queue
        .then(() => this.handle(message))
        .catch((err: unknown) => {
          this.deps.log.error("the page-mode frame could not handle a message", { err });
        });
    });
    port.onDisconnect(() => {
      // The page went away: nothing is left to check for.
      for (const session of this.sessions.values()) session.dispose();
      this.sessions.clear();
      this.port = undefined;
    });
    port.post({ type: "ready" } satisfies FrameMessage);
  }

  private async handle(message: ContentMessage): Promise<void> {
    const services = this.services;
    const port = this.port;
    if (services === undefined || port === undefined) return;
    switch (message.type) {
      case "focus": {
        // The settings are read again each time: a change made on the options page reaches a
        // frame that is not on the same broadcast channel as the page.
        await services.settings.load().catch((err: unknown) => {
          this.deps.log.warn("the page-mode frame could not read the settings", { err });
        });
        let session = this.sessions.get(message.box);
        if (session === undefined) {
          session = new BoxSession(
            {
              clock: services.clock,
              scheduler: services.scheduler,
              runner: services.runner,
              settings: services.settings,
              log: this.deps.log,
              send: (reply) => {
                this.port?.post(reply);
              },
            },
            message.box,
            message.source,
            message.text,
            message.revision,
          );
          this.sessions.set(message.box, session);
        }
        session.focus(message.revision, message.text);
        return;
      }
      case "edit":
        this.sessions.get(message.box)?.edit(message);
        return;
      case "text":
        this.sessions.get(message.box)?.setText(message.revision, message.text);
        return;
      case "blur":
        this.sessions.get(message.box)?.blur();
        return;
      case "forget": {
        const session = this.sessions.get(message.box);
        session?.dispose();
        this.sessions.delete(message.box);
        return;
      }
    }
  }
}
