import { describe, expect, it, vi } from "vitest";
import type { LLMConfig } from "../core/store";
import { FakeChannelBus } from "../platform/testing/fake-channel";
import { FrameSettings } from "./settings";

function config(id: number, name: string): LLMConfig {
  return {
    id,
    name,
    provider: "openai",
    base_url: "http://127.0.0.1:1/v1",
    model: "m",
  } as unknown as LLMConfig;
}

function setup(configs: LLMConfig[]) {
  const bus = new FakeChannelBus();
  const channel = bus.connect();
  const other = bus.connect();
  const store = {
    getSetting: vi.fn((key: string) =>
      Promise.resolve(key === "auto_check_delay_s" ? 5 : key === "selected_llm_id" ? null : null),
    ),
    listConfigs: vi.fn(() => Promise.resolve(configs)),
  };
  const settings = new FrameSettings({
    store: store as never,
    permissions: { has: () => Promise.resolve(true) } as never,
    fetch: () => Promise.reject(new Error("no network")),
    channel,
  });
  return { settings, store, other, configs };
}

describe("FrameSettings.subscribe", () => {
  it("calls the listener after each read, until it is removed", async () => {
    const t = setup([config(1, "A")]);
    const listener = vi.fn();
    const stop = t.settings.subscribe(listener);
    await t.settings.load();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(t.settings.delaySeconds).toBe(5);
    stop();
    await t.settings.load();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is called when another page changes the settings", async () => {
    const t = setup([config(1, "A")]);
    const listener = vi.fn();
    t.settings.subscribe(listener);
    t.other.post("settings-changed");
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
