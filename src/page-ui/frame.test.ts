import { describe, expect, it, vi } from "vitest";
import { placed, resultOf } from "../core/issues/testing/helpers";
import { Logger } from "../core/log";
import { connectMessage, type FrameMessage } from "../core/page-mode/protocol";
import { FakeClock, FakeScheduler } from "../core/testing/fake-clock";
import type { FakePort } from "../platform/testing/fake-page-port";
import { FakeFrameClaim } from "../platform/testing/fake-page-mode";
import { FakePortBus } from "../platform/testing/fake-page-port";
import { PageFrame, type FrameServices } from "./frame";
import { FakeRunner, MODEL, settle } from "./testing";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TEXT = "Yesterday I seen him. He go home.";

function setup(options: { services?: Promise<FrameServices> } = {}) {
  const bus = new FakePortBus();
  const runner = new FakeRunner();
  const scheduler = new FakeScheduler();
  const load = vi.fn(() => Promise.resolve());
  const services: FrameServices = {
    clock: new FakeClock(1_000),
    scheduler,
    runner,
    settings: { delaySeconds: 3, getModel: () => MODEL, load },
  };
  const logged: string[] = [];
  const record = (message: string) => {
    logged.push(message);
  };
  const claim = new FakeFrameClaim();
  const frame = new PageFrame({
    id: ID,
    server: bus.server,
    claim,
    services: options.services ?? Promise.resolve(services),
    log: new Logger({ debug: record, info: record, warn: record, error: record }),
  });
  /** The content script opens the channel with `id`; returns its end and what the frame sent. */
  const connect = async (id = ID) => {
    const mine = bus.connector.connect({ window: {} as Window, origin: "moz-extension://x" }, id);
    const received: FrameMessage[] = [];
    mine.onMessage((m) => {
      received.push(m as FrameMessage);
    });
    // The frame answers once the background script has confirmed its id.
    await settle();
    return { port: mine as FakePort, received };
  };
  return { bus, frame, claim, runner, scheduler, load, logged, connect };
}

const focus = (box = 1, text = TEXT, revision = 0) => ({
  type: "focus",
  box,
  source: `session:box-${String(box)}`,
  revision,
  text,
});

describe("PageFrame: accepting one port", () => {
  it("accepts the port offered with its id and says ready", async () => {
    const t = setup();
    const { received } = await t.connect();
    expect(received).toEqual([{ type: "ready" }]);
  });

  it("ignores a port offered with another id, and says nothing", async () => {
    const t = setup();
    const { received, port } = await t.connect(OTHER);
    expect(received).toEqual([]);
    expect(port.disconnected).toBe(false);
    // The real port still gets in afterwards.
    expect((await t.connect()).received).toEqual([{ type: "ready" }]);
  });

  it("accepts exactly one port: a second one with the same id is ignored", async () => {
    const t = setup();
    const first = await t.connect();
    const second = await t.connect();
    expect(second.received).toEqual([]);
    first.port.post(focus());
    second.port.post(focus(2));
    await t.frame.idle();
    expect(t.frame.boxes).toBe(1);
  });

  it("is a no-op for the messages of a port it did not accept", async () => {
    const t = setup();
    const { port } = await t.connect(OTHER);
    port.post(focus());
    await t.frame.idle();
    expect(t.frame.boxes).toBe(0);
  });

  it("the connect message names the frame by the id only", () => {
    expect(connectMessage(ID)).toEqual({ type: "english-tutor-page-ui", id: ID });
  });
});

describe("PageFrame: the claim at the background script", () => {
  it("says ready only after the claim is granted, and claims its own id", async () => {
    const t = setup();
    const mine = t.bus.connector.connect({ window: {} as Window, origin: "moz-extension://x" }, ID);
    const received: unknown[] = [];
    mine.onMessage((m) => {
      received.push(m);
    });
    expect(t.claim.claimed).toEqual([ID]);
    expect(received).toEqual([]);
    await settle();
    expect(received).toEqual([{ type: "ready" }]);
  });

  it.each([
    { name: "a claim that is refused (a frame a web page made by itself)", refuse: true },
    { name: "a claim that fails (the background script cannot be reached)", refuse: false },
  ])("ignores the port and does nothing after $name", async ({ refuse }) => {
    const t = setup();
    if (refuse) t.claim.granted = false;
    else t.claim.fails = new Error("no background script");
    const { port, received } = await t.connect();
    expect(received).toEqual([]);
    expect(port.disconnected).toBe(true);
    port.post(focus());
    await t.frame.idle();
    expect(t.frame.boxes).toBe(0);
    expect(t.runner.asked).toEqual([]);
    expect(t.logged).toEqual([
      `[english-tutor] the page-mode frame was not started: the claim ${refuse ? "refused" : "failed"}`,
    ]);
  });

  it("does not claim for a port offered with another id", async () => {
    const t = setup();
    await t.connect(OTHER);
    expect(t.claim.claimed).toEqual([]);
  });

  it("claims once: a second port with its id does not start a second claim", async () => {
    const t = setup();
    await t.connect();
    await t.connect();
    expect(t.claim.claimed).toEqual([ID]);
  });
});

describe("PageFrame: the boxes of the page", () => {
  it("makes a session for a focused box, with the content script's source, and checks it", async () => {
    const t = setup();
    t.runner.answer(resultOf([placed(10, 16), placed(22, 27)]));
    const { port, received } = await t.connect();
    port.post(focus());
    await t.frame.idle();
    await settle();
    expect(t.frame.boxes).toBe(1);
    expect(t.frame.session(1)?.source).toBe("session:box-1");
    expect(t.load).toHaveBeenCalledTimes(1);
    const states = received.filter((m) => m.type === "state");
    expect(states.at(-1)).toMatchObject({ box: 1, status: "checked", revision: 0 });
  });

  it("reads the settings again at every focus", async () => {
    const t = setup();
    const { port } = await t.connect();
    port.post(focus(1, "one two"));
    port.post(focus(2, "one two"));
    port.post({ type: "blur", box: 1 });
    port.post(focus(1, "one two"));
    await t.frame.idle();
    expect(t.load).toHaveBeenCalledTimes(3);
  });

  it("keeps the state of each box apart", async () => {
    const t = setup();
    t.runner.answer(resultOf([placed(10, 16)])).answer(resultOf([]));
    const { port, received } = await t.connect();
    port.post(focus(1));
    await t.frame.idle();
    await settle();
    port.post({ type: "blur", box: 1 });
    port.post(focus(2, "Another box with enough words"));
    await t.frame.idle();
    await settle();
    const last = (box: number) =>
      received.filter((m) => m.type === "state" && m.box === box).at(-1);
    expect(last(1)).toMatchObject({ status: "checked" });
    expect((last(1) as { issues: unknown[] }).issues).toHaveLength(1);
    expect((last(2) as { issues: unknown[] }).issues).toHaveLength(0);
  });

  it("applies an edit message to the box's text", async () => {
    const t = setup();
    t.runner.answer(resultOf([]));
    const { port } = await t.connect();
    port.post(focus());
    port.post({ type: "edit", box: 1, revision: 1, start: 0, removed: 0, inserted: "Oh! " });
    await t.frame.idle();
    expect(t.frame.session(1)?.text).toBe(`Oh! ${TEXT}`);
  });

  it("asks for the text again when an edit does not follow", async () => {
    const t = setup();
    const { port, received } = await t.connect();
    port.post(focus());
    port.post({ type: "edit", box: 1, revision: 5, start: 0, removed: 0, inserted: "x" });
    await t.frame.idle();
    expect(received).toContainEqual({ type: "resync", box: 1 });
    port.post({ type: "text", box: 1, revision: 5, text: "The whole new text here" });
    await t.frame.idle();
    expect(t.frame.session(1)?.text).toBe("The whole new text here");
  });

  it("forgets a box: its check is cancelled and its session is gone", async () => {
    const t = setup();
    t.runner.hold();
    const { port } = await t.connect();
    port.post(focus());
    await t.frame.idle();
    await settle();
    port.post({ type: "forget", box: 1 });
    await t.frame.idle();
    expect(t.frame.boxes).toBe(0);
    expect(t.scheduler.pending).toBe(0);
  });

  it("ignores messages for a box it does not have, and messages that are not the protocol's", async () => {
    const t = setup();
    const { port, received } = await t.connect();
    for (const message of [
      { type: "edit", box: 9, revision: 1, start: 0, removed: 0, inserted: "x" },
      { type: "blur", box: 9 },
      { type: "forget", box: 9 },
      { type: "text", box: 9, revision: 1, text: "x" },
      { type: "focus", box: "1", source: "s", revision: 0, text: "x" },
      { type: "focus", box: 1, source: 5, revision: 0, text: "x" },
      { type: "edit", box: 1, revision: -1, start: 0, removed: 0, inserted: "x" },
      { type: "state", box: 1 },
      { type: "weird" },
      "text",
      null,
      42,
    ]) {
      port.post(message);
    }
    await t.frame.idle();
    expect(t.frame.boxes).toBe(0);
    expect(received).toEqual([{ type: "ready" }]);
    expect(t.logged).toEqual([]);
  });

  it("disposes every session when the page goes away, and takes no other port: a claim works once", async () => {
    const t = setup();
    t.runner.hold();
    const { port } = await t.connect();
    port.post(focus());
    await t.frame.idle();
    port.disconnect();
    expect(t.frame.boxes).toBe(0);
    expect((await t.connect()).received).toEqual([]);
    expect(t.claim.claimed).toEqual([ID]);
  });
});

describe("PageFrame: while the store opens", () => {
  it("accepts the port at once and handles the messages, in order, when the store is open", async () => {
    let open: (services: FrameServices) => void = () => undefined;
    const slow = new Promise<FrameServices>((resolve) => {
      open = resolve;
    });
    const t = setup({ services: slow });
    const { port, received } = await t.connect();
    expect(received).toEqual([{ type: "ready" }]);
    port.post(focus(1, "one two"));
    port.post({ type: "edit", box: 1, revision: 1, start: 7, removed: 0, inserted: " three" });
    await settle();
    expect(t.frame.boxes).toBe(0);
    const runner = new FakeRunner().answer(resultOf([]));
    open({
      clock: new FakeClock(0),
      scheduler: new FakeScheduler(),
      runner,
      settings: { delaySeconds: 3, getModel: () => MODEL, load: () => Promise.resolve() },
    });
    await t.frame.idle();
    expect(t.frame.session(1)?.text).toBe("one two three");
  });

  it("logs a store that cannot be opened and drops the messages", async () => {
    const t = setup({ services: Promise.reject(new Error("no database")) });
    const { port } = await t.connect();
    port.post(focus());
    await t.frame.idle();
    expect(t.frame.boxes).toBe(0);
    expect(t.logged).toContain("[english-tutor] the page-mode frame could not open the store");
  });
});
