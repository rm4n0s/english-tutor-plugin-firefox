/**
 * Messages between the extension's pages about shared data (SPEC section 4.2). A page that
 * changes the LLM list, the settings, the library or the statistics posts the matching message;
 * the other pages reload what changed.
 */
export const CHANNEL_NAME = "english-tutor";

export const CHANNEL_MESSAGE_TYPES = [
  "configs-changed",
  "settings-changed",
  "library-changed",
  "stats-changed",
] as const;

export type ChannelMessageType = (typeof CHANNEL_MESSAGE_TYPES)[number];

export interface ChannelMessage {
  type: ChannelMessageType;
}

/** The message in `data`, or undefined when it is not one of ours. */
export function parseChannelMessage(data: unknown): ChannelMessage | undefined {
  if (typeof data !== "object" || data === null || !("type" in data)) return undefined;
  const type = data.type;
  return CHANNEL_MESSAGE_TYPES.find((known) => known === type) === undefined
    ? undefined
    : { type: type as ChannelMessageType };
}

export type ChannelListener = (message: ChannelMessage) => void;

/**
 * The channel that announces changes. A page does not receive its own messages. `core` and `ui`
 * get one through their constructors.
 */
export interface ChangeChannel {
  post(type: ChannelMessageType): void;
  /** Returns a function that removes the listener. */
  subscribe(listener: ChannelListener): () => void;
  close(): void;
}

/** The real channel: a `BroadcastChannel` named `english-tutor`. */
export class BroadcastChangeChannel implements ChangeChannel {
  private readonly channel: BroadcastChannel;
  private readonly listeners = new Set<ChannelListener>();

  constructor(channel: BroadcastChannel = new BroadcastChannel(CHANNEL_NAME)) {
    this.channel = channel;
    this.channel.onmessage = (event: MessageEvent) => {
      const message = parseChannelMessage(event.data);
      if (message === undefined) return;
      for (const listener of [...this.listeners]) listener(message);
    };
  }

  post(type: ChannelMessageType): void {
    this.channel.postMessage({ type });
  }

  subscribe(listener: ChannelListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.listeners.clear();
    this.channel.close();
  }
}
