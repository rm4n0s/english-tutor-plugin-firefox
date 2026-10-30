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

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(options: { frameWindow?: boolean; registerFails?: boolean } = {}) {
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
  const registered: string[] = [];
  const received: FrameMessage[] = [];
  const blocked: AppError[] = [];
  const ready = vi.fn();
  const link = new FrameLink(
    {
      doc: document,
      parent,
      connector: bus.connector,
      frameUrl: (id) => `moz-extension://abc-def/page-ui.html#${id}`,
      register: (id) => {
        if (options.registerFails === true) return Promise.reject(new Error("no background"));
        registered.push(id);
        return Promise.resolve();
      },
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
  /** Starts the link and lets the registration finish, so that the iframe is made. */
  const start = async () => {
    link.start();
    await settle();
  };
  return {
    start,
    registered,
    parent,
    scheduler,
    bus,
    link,
    load,
    frame,
    frameSide,
    received,
    blocked,
    ready,
    warned,
  };
}

describe("FrameLink: the hidden frame and the channel", () => {
  it("makes one hidden iframe of page-ui.html with the random id in its address, once", async () => {
    const { start, parent, link } = setup();
    await start();
    await start();
    await settle();
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

  it("offers the channel to the frame's window, addressed to the extension's origin, with the id of the address", async () => {
    const { start, bus, load, frame, parent } = setup();
    frame();
    await start();
    load();
    const connection = bus.connections[0];
    expect(connection?.id).toBe(parent.querySelector("iframe")?.src.split("#")[1]);
    expect(connection?.frame.origin).toBe("moz-extension://abc-def");
  });

  it("is ready when the frame answers, flushes what waited, and passes on later messages", async () => {
    const { start, link, load, frame, frameSide, ready, received } = setup();
    frame();
    const early: ContentMessage = { type: "blur", box: 1 };
    await start();
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

  it("delivers the queued and the later messages to the frame in order", async () => {
    const { start, bus, link, load } = setup();
    const got: unknown[] = [];
    bus.server.onConnect((port) => {
      port.onMessage((m) => {
        got.push(m);
      });
      port.post({ type: "ready" });
    });
    await start();
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

  it("ignores messages that are not the protocol's", async () => {
    const { start, load, frame, frameSide, received } = setup();
    frame();
    await start();
    load();
    frameSide[0]?.post({ type: "nonsense" });
    frameSide[0]?.post("text");
    frameSide[0]?.post({ type: "state", box: 1, revision: 0, status: "checked", issues: "no" });
    expect(received).toEqual([]);
  });

  it("closes: the port is cut and the iframe goes", async () => {
    const { start, parent, link, load, frame } = setup();
    frame();
    await start();
    load();
    link.close();
    expect(link.state).toBe("closed");
    expect(parent.querySelector("iframe")).toBeNull();
    link.post({ type: "blur", box: 1 });
  });
});

describe("FrameLink: the registration of the frame's id", () => {
  it("registers the id with the background script, and only then makes the iframe", async () => {
    const { link, registered, parent } = setup();
    link.start();
    // The registration is on its way: there is no iframe yet.
    expect(parent.querySelector("iframe")).toBeNull();
    await settle();
    expect(registered).toHaveLength(1);
    expect(parent.querySelector("iframe")?.src.endsWith(`#${registered[0] ?? ""}`)).toBe(true);
  });

  it("is blocked, with its own route, when the registration fails, and makes no iframe", async () => {
    const { link, start, blocked, parent, bus } = setup({ registerFails: true });
    await start();
    expect(link.state).toBe("blocked");
    expect(parent.querySelector("iframe")).toBeNull();
    expect(bus.connections).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.hasRoute("FrameLink.register->PageFrameBlocked")).toBe(true);
  });

  it("makes no iframe when it was closed while the registration was on its way", async () => {
    const { link, parent } = setup();
    link.start();
    link.close();
    await settle();
    expect(parent.querySelector("iframe")).toBeNull();
    expect(link.state).toBe("closed");
  });
});

describe("FrameLink: PageFrameBlocked", () => {
  it("is blocked when the frame does not answer within 5 seconds (usually the page's policy)", async () => {
    const { start, scheduler, link, load, blocked, received, warned, parent } = setup();
    await start();
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

  it("is blocked when the iframe never loads at all", async () => {
    const { start, scheduler, blocked } = setup();
    await start();
    scheduler.advance(FRAME_TIMEOUT_MS);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.hasRoute("PageFrameBlocked")).toBe(true);
  });

  it("is blocked at once when the loaded iframe has no window", async () => {
    const { start, link, load, blocked } = setup({ frameWindow: false });
    await start();
    load();
    expect(link.state).toBe("blocked");
    expect(blocked[0]?.hasRoute("FrameLink.connect->PageFrameBlocked")).toBe(true);
  });

  it("is blocked when the channel is cut before the frame answered", async () => {
    const { start, bus, link, load, blocked } = setup();
    await start();
    load();
    bus.connections[0]?.port.peer?.disconnect();
    expect(link.state).toBe("blocked");
    expect(blocked).toHaveLength(1);
  });

  it("is blocked, once, when the channel is cut after the frame was ready", async () => {
    const { start, bus, load, frame, blocked, scheduler } = setup();
    frame();
    await start();
    load();
    bus.connections[0]?.port.peer?.disconnect();
    scheduler.advance(FRAME_TIMEOUT_MS * 2);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.hasRoute("FrameLink.connect->PageFrameBlocked")).toBe(true);
  });

  it("does not block a frame that answers in time, and cancels the timer", async () => {
    const { start, scheduler, link, load, frame, blocked } = setup();
    frame();
    await start();
    load();
    expect(scheduler.pending).toBe(0);
    scheduler.advance(FRAME_TIMEOUT_MS * 3);
    expect(blocked).toEqual([]);
    expect(link.state).toBe("ready");
  });

  it("drops what was waiting for a frame that never answered, and sends nothing afterwards", async () => {
    const { start, bus, scheduler, link } = setup();
    await start();
    link.post({ type: "blur", box: 1 });
    scheduler.advance(FRAME_TIMEOUT_MS);
    link.post({ type: "blur", box: 2 });
    expect(bus.connections).toEqual([]);
  });

  it("ignores a load that comes after it gave up", async () => {
    const { start, scheduler, load, bus } = setup();
    await start();
    const iframe = document.querySelector("iframe");
    scheduler.advance(FRAME_TIMEOUT_MS);
    // The iframe was removed, but a late load event may still arrive.
    iframe?.dispatchEvent(new Event("load"));
    expect(bus.connections).toEqual([]);
    expect(() => load).not.toThrow();
  });
});
