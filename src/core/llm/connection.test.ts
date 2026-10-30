import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { FakeClock } from "../testing/fake-clock";
import type { ClientConfig } from "./client";
import { TEST_PROMPT, testConnection } from "./connection";
import { TEST_TIMEOUT_MS } from "./timeouts";
import { anthropic, ollama, openai } from "./testing/canned";
import { FakeFetch, type FakeScript } from "./testing/fake-fetch";

const CONFIG: ClientConfig = {
  provider: "openai-compatible",
  model: "m",
  base_url: "http://127.0.0.1:9/v1",
  api_key: "",
  temperature: null,
  no_thinking: true,
};

function setup(script: FakeScript, granted = true) {
  const clock = new FakeClock(1_000);
  const fake = new FakeFetch(script);
  const deps = {
    fetch: fake.fetch,
    clock,
    permissions: { contains: () => Promise.resolve(granted) },
  };
  return { clock, fake, deps };
}

describe("testConnection", () => {
  it("sends the test prompt with the typed values and reports the time taken", async () => {
    const clock = new FakeClock(1_000);
    const fake = new FakeFetch(() => {
      clock.advance(420);
      return { kind: "json", body: openai.json({ content: "ok" }) };
    });
    const result = await testConnection(
      { ...CONFIG, api_key: "k", temperature: 0.5 },
      { fetch: fake.fetch, clock, permissions: { contains: () => Promise.resolve(true) } },
      { name: "Typed" },
    );
    expect(result).toEqual({ elapsedMs: 420 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer k");
    expect(fake.requests[0]?.body).toMatchObject({
      model: "m",
      temperature: 0.5,
      stream: false,
      enable_thinking: false,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });
  });

  it("uses the desktop app's prompt and a 60 second timeout", () => {
    expect(TEST_PROMPT).toBe("Reply with the single word: ok");
    expect(TEST_TIMEOUT_MS).toBe(60_000);
  });

  it.each([
    {
      provider: "ollama",
      base_url: "http://localhost:11434",
      body: ollama.json({ content: "ok" }),
    },
    { provider: "anthropic", base_url: "", body: anthropic.json({ content: "ok" }) },
  ] as const)("works for $provider", async ({ provider, base_url, body }) => {
    const { deps } = setup({ kind: "json", body });
    await expect(
      testConnection({ ...CONFIG, provider, base_url, api_key: "k" }, deps),
    ).resolves.toEqual({ elapsedMs: 0 });
  });

  it("succeeds whatever the model answers (an empty answer is still a connection)", async () => {
    const { deps } = setup({ kind: "json", body: openai.json({ content: "" }) });
    await expect(testConnection(CONFIG, deps)).resolves.toEqual({ elapsedMs: 0 });
  });

  it("fails with the HTTP status and the provider's message", async () => {
    const { deps } = setup({ kind: "json", status: 401, body: openai.error("Invalid API key") });
    const err = await testConnection(CONFIG, deps, { name: "Work" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("testConnection->OpenAIClient.generate->LLMCallFailed")).toBe(
      true,
    );
    expect((err as AppError).message).toBe(
      "The request to Work failed (HTTP 401): Invalid API key",
    );
  });

  it("times out after the given time", async () => {
    const { deps } = setup({ kind: "hang" });
    const err = await testConnection(CONFIG, deps, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(
      (err as AppError).hasRoute("testConnection->OpenAIClient.generate->LLMCallTimeout"),
    ).toBe(true);
  });

  it("is not an error when cancelled", async () => {
    const { deps } = setup({ kind: "hang" });
    const controller = new AbortController();
    const pending = testConnection(CONFIG, deps, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(AppError);
    expect(err).toBe(controller.signal.reason);
  });

  it("refuses without the host permission and sends nothing", async () => {
    const { deps, fake } = setup({ kind: "hang" }, false);
    const err = await testConnection(CONFIG, deps).catch((e: unknown) => e);
    expect(
      (err as AppError).hasRoute("testConnection->OpenAIClient.generate->HostPermissionDenied"),
    ).toBe(true);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    {
      name: "an unknown provider",
      config: { ...CONFIG, provider: "gemini" },
      route: "testConnection->createClient->parseProvider->UnknownProvider",
    },
    {
      name: "a bad base URL",
      config: { ...CONFIG, base_url: "nope" },
      route: "testConnection->createClient->LLMConfigInvalid",
    },
  ])("refuses $name before any request", async ({ config, route }) => {
    const { deps, fake } = setup({ kind: "hang" });
    const err = await testConnection(config, deps).catch((e: unknown) => e);
    expect((err as AppError).route()).toBe(route);
    expect(fake.requests).toEqual([]);
  });
});
