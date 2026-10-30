import type { FrameTarget, PageConnector, PagePort, PagePortServer } from "../page-port";

/** One end of a fake channel. `post` delivers to the other end in the same turn. */
export class FakePort implements PagePort {
  /** Everything this end posted, in order. */
  readonly posted: unknown[] = [];
  disconnected = false;
  peer: FakePort | undefined;
  private readonly messageHandlers: ((message: unknown) => void)[] = [];
  private readonly disconnectHandlers: (() => void)[] = [];

  post(message: unknown): void {
    if (this.disconnected) return;
    this.posted.push(message);
    // A copy, as structured cloning does, so that tests cannot share objects.
    const copy: unknown = structuredClone(message);
    for (const handler of [...(this.peer?.messageHandlers ?? [])]) handler(copy);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    const peer = this.peer;
    if (peer !== undefined && !peer.disconnected) {
      peer.disconnected = true;
      for (const handler of [...peer.disconnectHandlers]) handler();
    }
  }

  /** A message as the other side would post it. */
  receive(message: unknown): void {
    for (const handler of [...this.messageHandlers]) handler(structuredClone(message));
  }
}

/**
 * A content script's connector and a frame's port server wired together in memory. A channel is
 * delivered only when a server is listening and the frame has a window, as in the browser.
 */
export class FakePortBus {
  private serverHandler: ((port: PagePort, id: string) => void) | undefined;
  /** Every channel the content side opened: its end, with the id and the frame it was offered to. */
  readonly connections: { port: FakePort; id: string; frame: FrameTarget }[] = [];
  /** What the frame does with an offered port; false makes it never arrive (a blocked frame). */
  deliver = true;

  readonly connector: PageConnector = {
    connect: (frame, id) => {
      const mine = new FakePort();
      const theirs = new FakePort();
      mine.peer = theirs;
      theirs.peer = mine;
      this.connections.push({ port: mine, id, frame });
      if (this.deliver) this.serverHandler?.(theirs, id);
      return mine;
    },
  };

  readonly server: PagePortServer = {
    onConnect: (handler) => {
      this.serverHandler = handler;
    },
  };
}
