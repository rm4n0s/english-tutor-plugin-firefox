import { describe, expect, it } from "vitest";
import {
  BroadcastChangeChannel,
  CHANNEL_MESSAGE_TYPES,
  CHANNEL_NAME,
  parseChannelMessage,
  type ChannelMessage,
} from "./channel";
import { FakeChannelBus } from "./testing/fake-channel";

describe("parseChannelMessage", () => {
  it.each([
    ...CHANNEL_MESSAGE_TYPES.map((type) => ({
      name: `accepts ${type}`,
      data: { type, extra: 1 },
      expected: { type },
    })),
    { name: "refuses an unknown type", data: { type: "other" }, expected: undefined },
    { name: "refuses a missing type", data: {}, expected: undefined },
    { name: "refuses a string", data: "configs-changed", expected: undefined },
    { name: "refuses null", data: null, expected: undefined },
    { name: "refuses a number", data: 3, expected: undefined },
  ])("$name", ({ data, expected }) => {
    expect(parseChannelMessage(data)).toEqual(expected);
  });
});

describe("BroadcastChangeChannel (real BroadcastChannel)", () => {
  function nextMessage(channel: BroadcastChangeChannel): Promise<ChannelMessage> {
    return new Promise((resolve) => {
      const stop = channel.subscribe((message) => {
        stop();
        resolve(message);
      });
    });
  }

  it.each(CHANNEL_MESSAGE_TYPES.map((type) => ({ type })))(
    "delivers $type to another channel with the same name",
    async ({ type }) => {
      const sender = new BroadcastChangeChannel();
      const receiver = new BroadcastChangeChannel();
      const received = nextMessage(receiver);
      sender.post(type);
      expect(await received).toEqual({ type });
      sender.close();
      receiver.close();
    },
  );

  it("does not deliver a message to the channel that posted it", async () => {
    const sender = new BroadcastChangeChannel();
    const receiver = new BroadcastChangeChannel();
    const own: ChannelMessage[] = [];
    sender.subscribe((m) => own.push(m));
    const received = nextMessage(receiver);
    sender.post("settings-changed");
    await received;
    expect(own).toEqual([]);
    sender.close();
    receiver.close();
  });

  it("ignores messages that are not ours", async () => {
    const raw = new BroadcastChannel(CHANNEL_NAME);
    const receiver = new BroadcastChangeChannel();
    const seen: ChannelMessage[] = [];
    receiver.subscribe((m) => seen.push(m));
    const last = nextMessage(receiver);
    raw.postMessage("junk");
    raw.postMessage({ type: "nope" });
    raw.postMessage({ type: "library-changed" });
    expect(await last).toEqual({ type: "library-changed" });
    expect(seen).toEqual([{ type: "library-changed" }]);
    raw.close();
    receiver.close();
  });

  it("stops delivering after unsubscribe", async () => {
    const sender = new BroadcastChangeChannel();
    const receiver = new BroadcastChangeChannel();
    const seen: ChannelMessage[] = [];
    const stop = receiver.subscribe((m) => seen.push(m));
    stop();
    const second = nextMessage(receiver);
    sender.post("stats-changed");
    await second;
    expect(seen).toEqual([]);
    sender.close();
    receiver.close();
  });
});

describe("FakeChannelBus", () => {
  it("delivers a message to every other channel, not to the poster", () => {
    const bus = new FakeChannelBus();
    const [a, b, c] = [bus.connect(), bus.connect(), bus.connect()];
    const seen: string[] = [];
    a.subscribe((m) => seen.push(`a:${m.type}`));
    b.subscribe((m) => seen.push(`b:${m.type}`));
    c.subscribe((m) => seen.push(`c:${m.type}`));
    a.post("configs-changed");
    expect(seen).toEqual(["b:configs-changed", "c:configs-changed"]);
    expect(a.posted).toEqual([{ type: "configs-changed" }]);
  });

  it("stops delivering to a closed channel or an unsubscribed listener", () => {
    const bus = new FakeChannelBus();
    const [a, b, c] = [bus.connect(), bus.connect(), bus.connect()];
    const seen: string[] = [];
    b.subscribe(() => seen.push("b"));
    const stop = c.subscribe(() => seen.push("c"));
    b.close();
    stop();
    a.post("library-changed");
    expect(seen).toEqual([]);
  });
});
