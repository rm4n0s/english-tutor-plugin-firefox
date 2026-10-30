import { describe, expect, it, vi } from "vitest";
import { connectMessage } from "../core/page-mode/protocol";
import { WindowPageConnector, WindowPagePortServer } from "./page-port";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** The little of a `Window` that the wrappers use, with Node's own `MessageChannel`. */
function fakeWindow() {
  const listeners: ((event: MessageEvent) => void)[] = [];
  const parent = {} as Window;
  const win = {
    MessageChannel,
    parent,
    addEventListener: (_: string, l: (event: MessageEvent) => void) => listeners.push(l),
  } as unknown as Window & typeof globalThis;
  return { win, parent, listeners };
}

describe("WindowPageConnector and WindowPagePortServer", () => {
  it("gives the frame its end of a channel, addressed to the extension's origin only", () => {
    const { win } = fakeWindow();
    const postMessage = vi.fn();
    const frame = { postMessage } as unknown as Window;
    new WindowPageConnector(win).connect({ window: frame, origin: "moz-extension://abc" }, ID);
    const call = postMessage.mock.calls[0] as unknown as [unknown, string, MessagePort[]];
    expect(call[0]).toEqual(connectMessage(ID));
    expect(call[1]).toBe("moz-extension://abc");
    expect(call[2]).toHaveLength(1);
  });

  it("carries messages both ways over the channel", async () => {
    const content = fakeWindow();
    const frameSide = fakeWindow();
    const accepted: { id: string; post: (m: unknown) => void; got: unknown[] }[] = [];
    new WindowPagePortServer(frameSide.win).onConnect((port, id) => {
      const got: unknown[] = [];
      port.onMessage((m) => {
        got.push(m);
      });
      accepted.push({
        id,
        post: (m) => {
          port.post(m);
        },
        got,
      });
    });
    // The browser delivers the content script's postMessage to the frame's window.
    const frame = {
      postMessage: (data: unknown, _origin: string, ports: MessagePort[]) => {
        for (const listener of frameSide.listeners) {
          listener({ source: frameSide.parent, data, ports } as unknown as MessageEvent);
        }
      },
    } as unknown as Window;
    const port = new WindowPageConnector(content.win).connect(
      { window: frame, origin: "moz-extension://abc" },
      ID,
    );
    const fromFrame: unknown[] = [];
    port.onMessage((m) => {
      fromFrame.push(m);
    });
    port.post({ type: "blur", box: 1 });
    accepted[0]?.post({ type: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accepted[0]?.id).toBe(ID);
    expect(accepted[0]?.got).toEqual([{ type: "blur", box: 1 }]);
    expect(fromFrame).toEqual([{ type: "ready" }]);
    port.disconnect();
  });

  it.each([
    { name: "a message from another window", source: "other", data: connectMessage(ID), ports: 1 },
    { name: "a message with no port", source: "parent", data: connectMessage(ID), ports: 0 },
    { name: "a message with two ports", source: "parent", data: connectMessage(ID), ports: 2 },
    {
      name: "a message that is not a connect message",
      source: "parent",
      data: { type: "hello" },
      ports: 1,
    },
    {
      name: "a connect message with a bad id",
      source: "parent",
      data: connectMessage("nope"),
      ports: 1,
    },
    { name: "text", source: "parent", data: "hello", ports: 1 },
  ])("ignores $name", ({ source, data, ports }) => {
    const { win, parent, listeners } = fakeWindow();
    const handler = vi.fn();
    new WindowPagePortServer(win).onConnect(handler);
    const channels = Array.from({ length: ports }, () => new MessageChannel().port2);
    listeners[0]?.({
      source: source === "parent" ? parent : {},
      data,
      ports: channels,
    } as unknown as MessageEvent);
    expect(handler).not.toHaveBeenCalled();
  });
});
