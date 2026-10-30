// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountingRandom } from "../core/analysis/testing/helpers";
import { AppError } from "../core/errors";
import { Logger } from "../core/log";
import {
  FRAME_ID_PATTERN,
  type ContentMessage,
  type FrameMessage,
} from "../core/page-mode/protocol";
import { FakeScheduler } from "../core/testing/fake-clock";
import { FakePortBus, type FakePort } from "../platform/testing/fake-page-port";
import { skipIframeLoading } from "./testing/iframes";
import { FRAME_BLOCKED_MESSAGE, FRAME_TIMEOUT_MS, FrameLink } from "./frame-link";

let restoreIframes: () => void = () => undefined;

beforeEach(() => {
  restoreIframes = skipIframeLoading(window);
});

afterEach(() => {
  restoreIframes();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function setup(options: { frameWindow?: boolean } = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const scheduler = new FakeScheduler();
  const bus = new FakePortBus();
  const warned: string[] = [];
  const log = new Logger({
    debug: () => undefined,
    info: () => undefined,
    warn: (m) => {
      warned.push(m);
    },
    error: () => undefined,
  });
  const received: FrameMessage[] = [];
  const blocked: AppError[] = [];
  const ready = vi.fn();
  const link = new FrameLink(
    {
      doc: document,
      parent,
      connector: bus.connector,
      frameUrl: (id) => `moz-extension://abc-def/page-ui.html#${id}`,
      scheduler,
      random: new CountingRandom(),
      log,
    },
    {
      onReady: ready,
      onMessage: (m) => {
        received.push(m);
      },
      onBlocked: (e) => {
        blocked.push(e);
      },
    },
  );
  /** The browser finishes loading the iframe: its window exists and `load` fires. */
  const load = () => {
    const iframe = parent.querySelector("iframe");
    if (iframe === null) throw new Error("no iframe");
    if (options.frameWindow !== false) {
      Object.defineProperty(iframe, "contentWindow", { value: {}, configurable: true });
    }
    iframe.dispatchEvent(new Event("load"));
  };
  /** The frame's script runs: it takes the port and says it is ready. */
  const frame = () => {
    bus.server.onConnect((port) => {
      port.post({ type: "ready" });
      frameSide.push(port as FakePort);
    });
  };
  const frameSide: FakePort[] = [];
  return { parent, scheduler, bus, link, load, frame, frameSide, received, blocked, ready, warned };
}

describe("FrameLink: the hidden frame and the channel", () => {
  it("makes one hidden iframe of page-ui.html with the random id in its address, once", () => {
    const { parent, link } = setup();
    link.start();
    link.start();
    const iframes = parent.querySelectorAll("iframe");
    expect(iframes).toHaveLength(1);
    const iframe = iframes[0];
    const id = iframe?.src.split("#")[1] ?? "";
    expect(id).toMatch(FRAME_ID_PATTERN);
    expect(iframe?.src.startsWith("moz-extension://abc-def/page-ui.html#")).toBe(true);
    expect(iframe?.style.getPropertyValue("display")).toBe("none");
    expect(iframe?.getAttribute("aria-hidden")).toBe("true");
    expect(link.state).toBe("starting");
  });

  it("offers the channel to the frame's window, addressed to the extension's origin, with the id of the address", () => {
    const { bus, link, load, frame, parent } = setup();
    frame();
    link.start();
    load();
    const connection = bus.connections[0];
    expect(connection?.id).toBe(parent.querySelector("iframe")?.src.split("#")[1]);
    expect(connection?.frame.origin).toBe("moz-extension://abc-def");
  });

  it("is ready when the frame answers, flushes what waited, and passes on later messages", () => {
    const { link, load, frame, frameSide, ready, received } = setup();
    frame();
    const early: ContentMessage = { type: "blur", box: 1 };
    link.start();
    link.post(early);
    expect(link.state).toBe("starting");
    load();
    expect(link.state).toBe("ready");
    expect(ready).toHaveBeenCalledTimes(1);
    // The frame's end received the message that waited.
    expect(frameSide[0]?.posted).toEqual([{ type: "ready" }]);
    link.post({ type: "forget", box: 2 });
    frameSide[0]?.post({ type: "resync", box: 7 });
    expect(received).toEqual([{ type: "resync", box: 7 }]);
  });

  it("delivers the queued and the later messages to the frame in order", () => {
    const { bus, link, load } = setup();
    const got: unknown[] = [];
    bus.server.onConnect((port) => {
      port.onMessage((m) => {
        got.push(m);
      });
      port.post({ type: "ready" });
    });
    link.start();
    link.post({ type: "blur", box: 1 });
    link.post({ type: "blur", box: 2 });
    load();
    link.post({ type: "blur", box: 3 });
    expect(got).toEqual([
      { type: "blur", box: 1 },
      { type: "blur", box: 2 },
      { type: "blur", box: 3 },
    ]);
  });

  it("ignores messages that are not the protocol's", () => {
    const { link, load, frame, frameSide, received } = setup();
    frame();
    link.start();
    load();
    frameSide[0]?.post({ type: "nonsense" });
    frameSide[0]?.post("text");
    frameSide[0]?.post({ type: "state", box: 1, revision: 0, status: "checked", issues: "no" });
    expect(received).toEqual([]);
  });

  it("closes: the port is cut and the iframe goes", () => {
    const { parent, link, load, frame } = setup();
    frame();
    link.start();
    load();
    link.close();
    expect(link.state).toBe("closed");
    expect(parent.querySelector("iframe")).toBeNull();
    link.post({ type: "blur", box: 1 });
  });
});

describe("FrameLink: PageFrameBlocked", () => {
  it("is blocked when the frame does not answer within 5 seconds (usually the page's policy)", () => {
    const { scheduler, link, load, blocked, received, warned, parent } = setup();
    link.start();
    load();
    scheduler.advance(FRAME_TIMEOUT_MS - 1);
    expect(link.state).toBe("starting");
    scheduler.advance(1);
    expect(link.state).toBe("blocked");
    expect(blocked).toHaveLength(1);
    const error = blocked[0]!;
    expect(error).toBeInstanceOf(AppError);
    expect(error.hasRoute("FrameLink.start->PageFrameBlocked")).toBe(true);
    expect(error.message).toBe(FRAME_BLOCKED_MESSAGE);
    expect(received).toEqual([]);
    expect(warned).toEqual(["[english-tutor] the page-mode frame is blocked"]);
    expect(parent.querySelector("iframe")).toBeNull();
  });

  it("is blocked when the iframe never loads at all", () => {
    const { scheduler, link, blocked } = setup();
    link.start();
    scheduler.advance(FRAME_TIMEOUT_MS);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.hasRoute("PageFrameBlocked")).toBe(true);
  });

  it("is blocked at once when the loaded iframe has no window", () => {
    const { link, load, blocked } = setup({ frameWindow: false });
    link.start();
    load();
    expect(link.state).toBe("blocked");
    expect(blocked[0]?.hasRoute("FrameLink.connect->PageFrameBlocked")).toBe(true);
  });

  it("is blocked when the channel is cut before the frame answered", () => {
    const { bus, link, load, blocked } = setup();
    link.start();
    load();
    bus.connections[0]?.port.peer?.disconnect();
    expect(link.state).toBe("blocked");
    expect(blocked).toHaveLength(1);
  });

  it("is blocked, once, when the channel is cut after the frame was ready", () => {
    const { bus, link, load, frame, blocked, scheduler } = setup();
    frame();
    link.start();
    load();
    bus.connections[0]?.port.peer?.disconnect();
    scheduler.advance(FRAME_TIMEOUT_MS * 2);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.hasRoute("FrameLink.connect->PageFrameBlocked")).toBe(true);
  });

  it("does not block a frame that answers in time, and cancels the timer", () => {
    const { scheduler, link, load, frame, blocked } = setup();
    frame();
    link.start();
    load();
    expect(scheduler.pending).toBe(0);
    scheduler.advance(FRAME_TIMEOUT_MS * 3);
    expect(blocked).toEqual([]);
    expect(link.state).toBe("ready");
  });

  it("drops what was waiting for a frame that never answered, and sends nothing afterwards", () => {
    const { bus, scheduler, link } = setup();
    link.start();
    link.post({ type: "blur", box: 1 });
    scheduler.advance(FRAME_TIMEOUT_MS);
    link.post({ type: "blur", box: 2 });
    expect(bus.connections).toEqual([]);
  });

  it("ignores a load that comes after it gave up", () => {
    const { scheduler, link, load, bus } = setup();
    link.start();
    const iframe = document.querySelector("iframe");
    scheduler.advance(FRAME_TIMEOUT_MS);
    // The iframe was removed, but a late load event may still arrive.
    iframe?.dispatchEvent(new Event("load"));
    expect(bus.connections).toEqual([]);
    expect(() => load).not.toThrow();
  });
});
