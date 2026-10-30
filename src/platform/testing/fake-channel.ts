import type {
  ChangeChannel,
  ChannelListener,
  ChannelMessage,
  ChannelMessageType,
} from "../channel";

/**
 * Connects fake channels the way pages are connected by the real one: a message posted on one
 * channel reaches every other open channel of the bus, not the poster. Delivery is synchronous,
 * which is simpler to test than the real, asynchronous delivery.
 */
export class FakeChannelBus {
  private readonly channels = new Set<FakeChangeChannel>();

  /** A new channel, like a page opening `BroadcastChannel("english-tutor")`. */
  connect(): FakeChangeChannel {
    const channel = new FakeChangeChannel(this.channels);
    this.channels.add(channel);
    return channel;
  }
}

export class FakeChangeChannel implements ChangeChannel {
  /** Everything this channel has posted, in order. */
  readonly posted: ChannelMessage[] = [];
  private readonly listeners = new Set<ChannelListener>();
  private readonly peers: Set<FakeChangeChannel>;

  constructor(peers: Set<FakeChangeChannel>) {
    this.peers = peers;
  }

  post(type: ChannelMessageType): void {
    const message = { type };
    this.posted.push(message);
    for (const peer of [...this.peers]) {
      if (peer !== this) peer.deliver(message);
    }
  }

  subscribe(listener: ChannelListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.listeners.clear();
    this.peers.delete(this);
  }

  private deliver(message: ChannelMessage): void {
    for (const listener of [...this.listeners]) listener(message);
  }
}
