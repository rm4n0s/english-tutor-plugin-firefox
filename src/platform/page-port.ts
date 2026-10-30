import { connectMessage, parseConnectMessage } from "../core/page-mode/protocol";

/**
 * The private channel between the page-mode content script and its frame (SPEC section 4.11): a
 * `MessageChannel` whose second end is handed to the frame by `postMessage`. The only place that
 * makes or receives one.
 */
export interface PagePort {
  post(message: unknown): void;
  /** Registers the listener for messages from the other side. */
  onMessage(handler: (message: unknown) => void): void;
  /** Registers the listener for the other side going away. A `MessagePort` cannot tell; fakes can. */
  onDisconnect(handler: () => void): void;
  /** Closes this end. */
  disconnect(): void;
}

/** The frame the content script talks to. */
export interface FrameTarget {
  /** The frame's window (`iframe.contentWindow`). */
  window: Window;
  /** The extension's origin, `moz-extension://<uuid>`: the only one that may receive the port. */
  origin: string;
}

/** The content script's side: opens the channel to the frame. */
export interface PageConnector {
  /** Gives the frame its end of a new channel, named by `id` (the id in the frame's address). */
  connect(frame: FrameTarget, id: string): PagePort;
}

/** The frame's side: receives the channel. Registered synchronously when the frame's script runs. */
export interface PagePortServer {
  /** `handler` gets each port that was offered, with the id it names. It decides which to keep. */
  onConnect(handler: (port: PagePort, id: string) => void): void;
}

class MessagePagePort implements PagePort {
  private readonly port: MessagePort;

  constructor(port: MessagePort) {
    this.port = port;
  }

  post(message: unknown): void {
    this.port.postMessage(message);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.port.onmessage = (event: MessageEvent) => {
      handler(event.data);
    };
    // A port delivers nothing until `start`, which `onmessage` does by itself; this is explicit.
    this.port.start();
  }

  onDisconnect(): void {
    // A MessagePort has no close event: the frame goes with its page, and a frame that never
    // answers is `PageFrameBlocked` (the 5 seconds).
  }

  disconnect(): void {
    this.port.onmessage = null;
    this.port.close();
  }
}

export class WindowPageConnector implements PageConnector {
  private readonly win: Window & typeof globalThis;

  constructor(win: Window & typeof globalThis) {
    this.win = win;
  }

  connect(frame: FrameTarget, id: string): PagePort {
    const channel = new this.win.MessageChannel();
    // Addressed to the extension's origin: only the extension's frame gets the port.
    frame.window.postMessage(connectMessage(id), frame.origin, [channel.port2]);
    return new MessagePagePort(channel.port1);
  }
}

export class WindowPagePortServer implements PagePortServer {
  private readonly win: Window;

  constructor(win: Window) {
    this.win = win;
  }

  onConnect(handler: (port: PagePort, id: string) => void): void {
    this.win.addEventListener("message", (event: MessageEvent) => {
      // Only the page that embeds the frame can offer a port, and only with a port.
      if (event.source !== this.win.parent) return;
      const id = parseConnectMessage(event.data);
      const port = event.ports[0];
      if (id === undefined || port === undefined || event.ports.length !== 1) return;
      handler(new MessagePagePort(port), id);
    });
  }
}
