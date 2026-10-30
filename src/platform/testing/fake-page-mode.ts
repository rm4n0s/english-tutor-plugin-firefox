import type { PageBroadcast } from "../../core/page-mode/messages";
import type {
  BackgroundMessages,
  ContentScripts,
  MessageSender,
  PageModeBackendLink,
  PageModePermission,
  PageModeRuntime,
  PageTabs,
} from "../page-mode";

export class FakePageModePermission implements PageModePermission {
  granted = false;
  /** What the user answers when asked. */
  answer: "grant" | "refuse" = "grant";
  readonly calls: string[] = [];
  private removed: (() => void) | undefined;

  contains(): Promise<boolean> {
    this.calls.push("contains");
    return Promise.resolve(this.granted);
  }

  // Not async, like the real one: the call is recorded in the turn of the click.
  request(): Promise<boolean> {
    this.calls.push("request");
    if (this.answer === "grant") this.granted = true;
    return Promise.resolve(this.granted);
  }

  remove(): Promise<boolean> {
    this.calls.push("remove");
    const was = this.granted;
    this.granted = false;
    return Promise.resolve(was);
  }

  onRemoved(handler: () => void): void {
    this.removed = handler;
  }

  /** The user withdraws the permission in about:addons. */
  withdraw(): void {
    this.granted = false;
    this.removed?.();
  }
}

export class FakeContentScripts implements ContentScripts {
  registered = false;
  readonly calls: string[] = [];
  failWith: Error | undefined;

  isRegistered(): Promise<boolean> {
    return Promise.resolve(this.registered);
  }

  register(): Promise<void> {
    this.calls.push("register");
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.registered = true;
    return Promise.resolve();
  }

  unregister(): Promise<void> {
    this.calls.push("unregister");
    this.registered = false;
    return Promise.resolve();
  }
}

export class FakePageTabs implements PageTabs {
  readonly sent: PageBroadcast[] = [];

  broadcast(message: PageBroadcast): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

export class FakeBackendLink implements PageModeBackendLink {
  applied = 0;
  failWith: Error | undefined;
  /** Called on each `apply`, so a test can stand for the background script. */
  onApply: (() => Promise<void>) | undefined;

  async apply(): Promise<void> {
    this.applied++;
    if (this.failWith !== undefined) throw this.failWith;
    await this.onApply?.();
  }
}

export class FakeBackgroundMessages implements BackgroundMessages {
  private handler:
    ((message: unknown, sender: MessageSender) => Promise<unknown> | undefined) | undefined;

  onMessage(
    handler: (message: unknown, sender: MessageSender) => Promise<unknown> | undefined,
  ): void {
    this.handler = handler;
  }

  /** A page sends a message. Resolves with the answer, or undefined when nobody answers. */
  async send(
    message: unknown,
    sender: Partial<MessageSender> = {},
  ): Promise<{ answered: boolean; answer: unknown }> {
    const result = this.handler?.(message, { ownExtension: true, tab: undefined, ...sender });
    if (result === undefined) return { answered: false, answer: undefined };
    return { answered: true, answer: await result };
  }
}

/** The content script's link to the extension, in memory. */
export class FakePageModeRuntime implements PageModeRuntime {
  /** The answer of the background script about this host. */
  enabled = true;
  enabledFails: Error | undefined;
  readonly asked: string[] = [];
  readonly opened: string[] = [];
  readonly listeners = new Set<(message: PageBroadcast) => void>();

  enabledOn(host: string): Promise<boolean> {
    this.asked.push(host);
    if (this.enabledFails !== undefined) return Promise.reject(this.enabledFails);
    return Promise.resolve(this.enabled);
  }

  openInTutor(text: string): Promise<void> {
    this.opened.push(text);
    return Promise.resolve();
  }

  onBroadcast(handler: (message: PageBroadcast) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  frameUrl(fragment: string): string {
    return `moz-extension://test/page-ui.html#${fragment}`;
  }

  /** The background script sends a message to the page. */
  broadcast(message: PageBroadcast): void {
    for (const handler of [...this.listeners]) handler(message);
  }
}
