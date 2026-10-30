import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import {
  createClient,
  isCancelled,
  OLLAMA_FORBIDDEN_MESSAGE,
  type ClientConfig,
  type GenerateRequest,
  type GenerateResult,
  type LLMClient,
} from "./client";
import type { Provider } from "./provider";
import {
  anthropic,
  anthropicStreamError,
  CHECK_REPLY_TEXT,
  ollama,
  openai,
  splitEvery,
  type CannedReply,
} from "./testing/canned";
import { FakeFetch, type FakeScript } from "./testing/fake-fetch";

const PROVIDERS = ["ollama", "openai-compatible", "anthropic"] as const;

const CLIENT_NAMES: Record<Provider, string> = {
  ollama: "OllamaClient",
  "openai-compatible": "OpenAIClient",
  anthropic: "AnthropicClient",
};

const BASE_URLS: Record<Provider, string> = {
  ollama: "http://localhost:11434",
  "openai-compatible": "https://api.example.com/v1/",
  anthropic: "",
};

const ENDPOINTS: Record<Provider, string> = {
  ollama: "http://localhost:11434/api/chat",
  "openai-compatible": "https://api.example.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};

const SECRET_KEY = "sk-secret-key-123";
const PROMPT = "Check this text: He go to school.";

function config(provider: Provider, overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    provider,
    model: "test-model",
    base_url: BASE_URLS[provider],
    api_key: provider === "ollama" ? "" : SECRET_KEY,
    temperature: null,
    no_thinking: false,
    ...overrides,
  };
}

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    system: "You are a tutor.",
    prompt: PROMPT,
    maxTokens: 8192,
    timeoutMs: 5000,
    ...overrides,
  };
}

function setup(
  provider: Provider,
  script: FakeScript,
  overrides: Partial<ClientConfig> = {},
  granted = true,
) {
  const fake = new FakeFetch(script);
  const checked: string[] = [];
  const client = createClient(
    config(provider, overrides),
    {
      fetch: fake.fetch,
      permissions: {
        contains: (baseUrl) => {
          checked.push(baseUrl);
          return Promise.resolve(granted);
        },
      },
    },
    { name: "My LLM" },
  );
  return { client, fake, checked };
}

/** The canned non-streamed and streamed responses of a provider. */
function responses(provider: Provider, reply: CannedReply, chunkSize?: number) {
  const canned = { ollama, "openai-compatible": openai, anthropic }[provider];
  const wire = "ndjson" in canned ? canned.ndjson(reply) : canned.sse(reply);
  return {
    json: { kind: "json", body: canned.json(reply) } as const,
    stream: {
      kind: "stream",
      chunks: chunkSize === undefined ? [wire] : splitEvery(wire, chunkSize),
    } as const,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (err: unknown) => err,
  );
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  const err = await rejection(promise);
  if (!(err instanceof AppError)) throw new Error(`not an AppError: ${String(err)}`);
  return err;
}

function call(
  client: LLMClient,
  mode: "generate" | "stream",
  req: GenerateRequest,
): Promise<GenerateResult> {
  return mode === "generate"
    ? client.generate(req)
    : client.stream(req, { onText: () => undefined });
}

describe("requests", () => {
  it.each([
    {
      name: "ollama",
      provider: "ollama",
      overrides: {},
      headers: { "content-type": "application/json" },
      body: {
        model: "test-model",
        messages: [
          { role: "system", content: "You are a tutor." },
          { role: "user", content: PROMPT },
        ],
        stream: false,
        options: { temperature: 0.2 },
      },
    },
    {
      name: "ollama with No thinking and a temperature",
      provider: "ollama",
      overrides: { no_thinking: true, temperature: 0.7 },
      headers: { "content-type": "application/json" },
      body: {
        model: "test-model",
        messages: [
          { role: "system", content: "You are a tutor." },
          { role: "user", content: PROMPT },
        ],
        stream: false,
        options: { temperature: 0.7 },
        think: false,
      },
    },
    {
      name: "openai-compatible with a key",
      provider: "openai-compatible",
      overrides: {},
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET_KEY}` },
      body: {
        model: "test-model",
        messages: [
          { role: "system", content: "You are a tutor." },
          { role: "user", content: PROMPT },
        ],
        temperature: 0.2,
        stream: false,
      },
    },
    {
      name: "openai-compatible without a key and with No thinking",
      provider: "openai-compatible",
      overrides: { api_key: "", no_thinking: true, temperature: 0 },
      headers: { "content-type": "application/json" },
      body: {
        model: "test-model",
        messages: [
          { role: "system", content: "You are a tutor." },
          { role: "user", content: PROMPT },
        ],
        temperature: 0,
        stream: false,
        thinking: { type: "disabled" },
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      },
    },
    {
      name: "anthropic",
      provider: "anthropic",
      overrides: {},
      headers: {
        "content-type": "application/json",
        "x-api-key": SECRET_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: {
        model: "test-model",
        system: "You are a tutor.",
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 8192,
        temperature: 0.2,
        stream: false,
      },
    },
    {
      name: "anthropic never gets the No thinking fields",
      provider: "anthropic",
      overrides: { no_thinking: true },
      headers: {
        "content-type": "application/json",
        "x-api-key": SECRET_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: {
        model: "test-model",
        system: "You are a tutor.",
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: 8192,
        temperature: 0.2,
        stream: false,
      },
    },
  ] as {
    name: string;
    provider: Provider;
    overrides: Partial<ClientConfig>;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }[])("$name (not streamed)", async ({ provider, overrides, headers, body }) => {
    const { client, fake } = setup(
      provider,
      responses(provider, { content: "ok" }).json,
      overrides,
    );
    await client.generate(request());
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toEqual({
      url: ENDPOINTS[provider],
      method: "POST",
      headers,
      body,
    });
  });

  it.each([
    { provider: "ollama", extra: {} },
    { provider: "openai-compatible", extra: { stream_options: { include_usage: true } } },
    { provider: "anthropic", extra: {} },
  ] as const)("$provider streams with stream: true $extra", async ({ provider, extra }) => {
    const { client, fake } = setup(provider, responses(provider, { content: "ok" }).stream);
    await client.stream(request(), { onText: () => undefined });
    const body = fake.requests[0]?.body ?? {};
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual((extra as { stream_options?: unknown }).stream_options);
    // stream_options is for OpenAI-compatible servers only.
    expect("stream_options" in body).toBe(provider === "openai-compatible");
  });

  it.each([
    { name: "a missing system prompt (openai)", provider: "openai-compatible", key: "messages" },
    { name: "a missing system prompt (ollama)", provider: "ollama", key: "messages" },
  ] as const)("omits the system message for $name", async ({ provider, key }) => {
    const { client, fake } = setup(provider, responses(provider, { content: "ok" }).json);
    await client.generate(request({ system: "" }));
    expect(fake.requests[0]?.body[key]).toEqual([{ role: "user", content: PROMPT }]);
  });

  it("omits the system field of Anthropic when there is no system prompt", async () => {
    const { client, fake } = setup("anthropic", responses("anthropic", { content: "ok" }).json);
    await client.generate({ prompt: PROMPT, maxTokens: 4096, timeoutMs: 5000 });
    expect(fake.requests[0]?.body).not.toHaveProperty("system");
    expect(fake.requests[0]?.body.max_tokens).toBe(4096);
  });

  it.each([
    {
      base: "https://api.example.com/v1///",
      expected: "https://api.example.com/v1/chat/completions",
    },
    {
      base: " https://api.example.com/v1 ",
      expected: "https://api.example.com/v1/chat/completions",
    },
  ])("cleans the base URL $base", async ({ base, expected }) => {
    const { client, fake } = setup(
      "openai-compatible",
      responses("openai-compatible", { content: "ok" }).json,
      { base_url: base },
    );
    await client.generate(request());
    expect(fake.requests[0]?.url).toBe(expected);
  });

  it("uses the Anthropic base URL when one is given", async () => {
    const { client, fake, checked } = setup(
      "anthropic",
      responses("anthropic", { content: "ok" }).json,
      { base_url: "https://proxy.example.com/" },
    );
    await client.generate(request());
    expect(fake.requests[0]?.url).toBe("https://proxy.example.com/v1/messages");
    expect(checked).toEqual(["https://proxy.example.com"]);
  });
});

describe("results", () => {
  const reply: CannedReply = {
    content: CHECK_REPLY_TEXT,
    usage: { input: 812, output: 164 },
    stopReason: "stop",
  };

  it.each([
    { provider: "ollama", stopReason: "stop" },
    { provider: "openai-compatible", stopReason: "stop" },
    { provider: "anthropic", stopReason: "end_turn" },
  ] as const)(
    "$provider: text, usage and stop reason (generate)",
    async ({ provider, stopReason }) => {
      const { client } = setup(provider, responses(provider, { ...reply, stopReason }).json);
      expect(await client.generate(request())).toEqual({
        text: CHECK_REPLY_TEXT,
        usage: { inputTokens: 812, outputTokens: 164, estimated: false },
        stopReason,
      });
    },
  );

  it.each(
    PROVIDERS.flatMap((provider) =>
      [undefined, 1, 3, 7].map((chunkSize) => ({ provider, chunkSize })),
    ),
  )(
    "$provider: text, usage and stop reason (stream, chunks of $chunkSize bytes)",
    async ({ provider, chunkSize }) => {
      const stopReason = provider === "anthropic" ? "max_tokens" : "length";
      const { client } = setup(
        provider,
        responses(provider, { ...reply, stopReason }, chunkSize).stream,
      );
      const pieces: string[] = [];
      const result = await client.stream(request(), { onText: (chunk) => pieces.push(chunk) });
      expect(result).toEqual({
        text: CHECK_REPLY_TEXT,
        usage: { inputTokens: 812, outputTokens: 164, estimated: false },
        stopReason,
      });
      expect(pieces.join("").trim()).toBe(CHECK_REPLY_TEXT);
    },
  );

  it.each(
    PROVIDERS.flatMap((provider) =>
      (["generate", "stream"] as const).flatMap((mode) => [
        { provider, mode, name: "no usage", usage: undefined },
        { provider, mode, name: "zero usage", usage: { input: 0, output: 0 } },
      ]),
    ),
  )("$provider $mode estimates tokens for $name", async ({ provider, mode, usage }) => {
    const content = "a".repeat(40);
    const wire = responses(provider, { content, usage });
    const { client } = setup(provider, mode === "generate" ? wire.json : wire.stream);
    const result = await call(
      client,
      mode,
      request({ system: "s".repeat(10), prompt: "p".repeat(10) }),
    );
    // 20 characters in, 40 out, 4 characters per token.
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 10, estimated: true });
  });

  it.each(PROVIDERS)(
    "%s: usage of the stream is read in a stream split byte by byte",
    async (provider) => {
      const { client } = setup(provider, responses(provider, reply, 1).stream);
      const result = await client.stream(request(), { onText: () => undefined });
      expect(result.usage).toEqual({ inputTokens: 812, outputTokens: 164, estimated: false });
    },
  );

  it("reports usage to onUsage as the stream goes", async () => {
    const { client } = setup("anthropic", responses("anthropic", reply).stream);
    const seen: unknown[] = [];
    await client.stream(request(), {
      onText: () => undefined,
      onUsage: (usage) => seen.push(usage),
    });
    // message_start gives the input, message_delta the output.
    expect(seen).toEqual([
      { inputTokens: 812, outputTokens: 1 },
      { inputTokens: 812, outputTokens: 164 },
    ]);
  });

  it("gives an empty stop reason when the provider says none", async () => {
    const { client } = setup("openai-compatible", {
      kind: "json",
      body: { choices: [{ message: { content: "hi" } }] },
    });
    expect((await client.generate(request())).stopReason).toBe("");
  });

  it("trims the text", async () => {
    const { client } = setup("ollama", responses("ollama", { content: "\n  ok \n" }).json);
    expect((await client.generate(request())).text).toBe("ok");
  });

  it("gives empty text for a reply without choices", async () => {
    const { client } = setup("openai-compatible", { kind: "json", body: { choices: [] } });
    expect((await client.generate(request())).text).toBe("");
  });

  it.each([
    { name: "multi-byte text split inside characters", content: "Café naïve 日本語 😀 done" },
    { name: "a line break in the text", content: "line one\nline two\r\nline three" },
  ])("keeps $name whole when streamed byte by byte", async ({ content }) => {
    for (const provider of PROVIDERS) {
      const { client } = setup(
        provider,
        responses(provider, { content, usage: { input: 1, output: 1 } }, 1).stream,
      );
      const pieces: string[] = [];
      const result = await client.stream(request(), { onText: (chunk) => pieces.push(chunk) });
      expect(result.text).toBe(content);
      expect(pieces.join("")).toBe(content);
    }
  });
});

describe("thinking", () => {
  const thinking = "Let me think about the grammar first.";

  it.each(
    PROVIDERS.flatMap((provider) =>
      (["generate", "stream"] as const).map((mode) => ({ provider, mode })),
    ),
  )("$provider $mode never returns thinking from its own field", async ({ provider, mode }) => {
    const wire = responses(
      provider,
      { content: "The answer.", thinking, usage: { input: 5, output: 9 } },
      4,
    );
    const { client } = setup(provider, mode === "generate" ? wire.json : wire.stream);
    const pieces: string[] = [];
    const result =
      mode === "generate"
        ? await client.generate(request())
        : await client.stream(request(), { onText: (chunk) => pieces.push(chunk) });
    expect(result.text).toBe("The answer.");
    expect(JSON.stringify([result, pieces])).not.toContain("think about");
  });

  it.each([
    { name: "a block before the answer", content: "<think>plan it</think>The answer." },
    { name: "a closing tag only", content: "plan it\n</think>\n\nThe answer." },
  ])("generate drops thinking in the text: $name", async ({ content }) => {
    const { client } = setup("ollama", responses("ollama", { content }).json);
    expect((await client.generate(request())).text).toBe("The answer.");
  });

  it("stream hides a leading think block and keeps the final text clean", async () => {
    const content = "<think>plan it</think>\nThe answer.";
    const { client } = setup(
      "openai-compatible",
      responses("openai-compatible", { content }, 3).stream,
    );
    const pieces: string[] = [];
    const result = await client.stream(request(), { onText: (chunk) => pieces.push(chunk) });
    expect(pieces.join("")).toBe("The answer.");
    expect(result.text).toBe("The answer.");
  });

  it("stream with a closing tag only: the final text is clean", async () => {
    const content = "plan it</think>The answer.";
    const { client } = setup("ollama", responses("ollama", { content }).stream);
    const result = await client.stream(request(), { onText: () => undefined });
    expect(result.text).toBe("The answer.");
  });
});

describe("timeout and cancel", () => {
  const modes = PROVIDERS.flatMap((provider) =>
    (["generate", "stream"] as const).map((mode) => ({ provider, mode })),
  );

  it.each(modes)(
    "$provider $mode: a timeout before the answer is LLMCallTimeout",
    async ({ provider, mode }) => {
      const { client } = setup(provider, { kind: "hang" });
      const err = await appError(call(client, mode, request({ timeoutMs: 20 })));
      expect(err.tag).toBe("LLMCallTimeout");
      expect(err.route()).toBe(`${CLIENT_NAMES[provider]}.${mode}->LLMCallTimeout`);
      expect(err.metadata).toEqual({ provider, timeout_s: 0 });
      expect(err.message).toBe("The request to My LLM took longer than 0 seconds.");
    },
  );

  it.each(["ollama", "openai-compatible", "anthropic"] as const)(
    "%s: a timeout while the stream is open is LLMCallTimeout",
    async (provider) => {
      const wire = responses(provider, { content: "partial" }).stream;
      const { client } = setup(provider, { ...wire, hold: true });
      const err = await appError(call(client, "stream", request({ timeoutMs: 30 })));
      expect(err.tag).toBe("LLMCallTimeout");
    },
  );

  it("the timeout message names the time in seconds", async () => {
    const { client } = setup("ollama", { kind: "hang" });
    const err = await appError(client.generate(request({ timeoutMs: 20 })));
    expect(err.message).toContain("seconds");
  });

  it.each(modes)(
    "$provider $mode: a cancel while waiting is not an AppError",
    async ({ provider, mode }) => {
      const { client } = setup(provider, { kind: "hang" });
      const controller = new AbortController();
      const pending = rejection(call(client, mode, request({ signal: controller.signal })));
      controller.abort();
      const err = await pending;
      expect(err).not.toBeInstanceOf(AppError);
      expect(isCancelled(err, controller.signal)).toBe(true);
      expect(err).toBe(controller.signal.reason);
    },
  );

  it.each(["ollama", "openai-compatible", "anthropic"] as const)(
    "%s: a cancel while the stream is open is not an AppError",
    async (provider) => {
      const wire = responses(provider, { content: "partial" }).stream;
      const { client } = setup(provider, { ...wire, hold: true });
      const controller = new AbortController();
      const seen: string[] = [];
      const pending = rejection(
        client.stream(request({ signal: controller.signal }), {
          onText: (chunk) => {
            seen.push(chunk);
            controller.abort();
          },
        }),
      );
      const err = await pending;
      expect(err).not.toBeInstanceOf(AppError);
      expect(isCancelled(err, controller.signal)).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
    },
  );

  it("a signal that is already aborted sends nothing and checks no permission", async () => {
    const { client, fake, checked } = setup("openai-compatible", { kind: "hang" });
    const controller = new AbortController();
    controller.abort();
    const err = await rejection(client.generate(request({ signal: controller.signal })));
    expect(err).not.toBeInstanceOf(AppError);
    expect(fake.requests).toEqual([]);
    expect(checked).toEqual([]);
  });

  it("keeps the reason of an abort with a custom reason", async () => {
    const { client } = setup("ollama", { kind: "hang" });
    const controller = new AbortController();
    const pending = rejection(client.generate(request({ signal: controller.signal })));
    const reason = new DOMException("superseded", "AbortError");
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });

  it("a cancel that comes after the timeout does not turn it into a cancel", async () => {
    const { client } = setup("ollama", { kind: "hang" });
    const controller = new AbortController();
    const pending = rejection(
      client.generate(request({ signal: controller.signal, timeoutMs: 20 })),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    // The timeout fired first, so this is a timeout; the cancel came too late to change it.
    expect(await pending).toBeInstanceOf(AppError);
  });

  it("a request that finishes before its timeout is not affected by it", async () => {
    const { client } = setup("ollama", responses("ollama", { content: "ok" }).json);
    await expect(client.generate(request({ timeoutMs: 5000 }))).resolves.toMatchObject({
      text: "ok",
    });
  });

  it.each([
    { aborted: false, expected: false },
    { aborted: true, expected: true },
  ])("isCancelled for a DOMException with an aborted=$aborted signal", ({ aborted, expected }) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    expect(isCancelled(new DOMException("x", "AbortError"), controller.signal)).toBe(expected);
  });

  it("isCancelled is false for an AppError, even with an aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isCancelled(new AppError("LLMCallFailed", "x"), controller.signal)).toBe(false);
    expect(isCancelled(new DOMException("x", "AbortError"), undefined)).toBe(false);
  });
});

describe("host permission", () => {
  it.each(
    PROVIDERS.flatMap((provider) =>
      (["generate", "stream"] as const).map((mode) => ({ provider, mode })),
    ),
  )("$provider $mode: sends nothing without the permission", async ({ provider, mode }) => {
    const { client, fake, checked } = setup(
      provider,
      responses(provider, { content: "ok" }).json,
      {},
      false,
    );
    const err = await appError(call(client, mode, request()));
    expect(err.tag).toBe("HostPermissionDenied");
    expect(err.route()).toBe(`${CLIENT_NAMES[provider]}.${mode}->HostPermissionDenied`);
    expect(fake.requests).toEqual([]);
    expect(checked).toEqual([
      {
        ollama: "http://localhost:11434",
        "openai-compatible": "https://api.example.com/v1",
        anthropic: "https://api.anthropic.com",
      }[provider],
    ]);
    expect(err.metadata.origin).toBe(new URL(checked[0] ?? "").origin);
  });

  it("checks the permission before every request", async () => {
    const { client, checked } = setup("ollama", responses("ollama", { content: "ok" }).json);
    await client.generate(request());
    await client.generate(request());
    expect(checked).toHaveLength(2);
  });

  it("a permission check that fails is LLMCallFailed", async () => {
    const fake = new FakeFetch({ kind: "hang" });
    const client = createClient(config("ollama"), {
      fetch: fake.fetch,
      permissions: { contains: () => Promise.reject(new TypeError("bad pattern")) },
    });
    const err = await appError(client.generate(request()));
    expect(err.tag).toBe("LLMCallFailed");
    expect(fake.requests).toEqual([]);
  });
});

describe("failures", () => {
  it.each([
    {
      name: "openai 401 with error.message",
      provider: "openai-compatible",
      status: 401,
      body: openai.error("Incorrect API key provided"),
      message: "The request to My LLM failed (HTTP 401): Incorrect API key provided",
      provider_message: "Incorrect API key provided",
    },
    {
      name: "anthropic 429 with error.message",
      provider: "anthropic",
      status: 429,
      body: anthropic.error("Rate limited"),
      message: "The request to My LLM failed (HTTP 429): Rate limited",
      provider_message: "Rate limited",
    },
    {
      name: "ollama 500 with error as text",
      provider: "ollama",
      status: 500,
      body: ollama.error("model 'x' not found"),
      message: "The request to My LLM failed (HTTP 500): model 'x' not found",
      provider_message: "model 'x' not found",
    },
    {
      name: "openai 400 with error as text",
      provider: "openai-compatible",
      status: 400,
      body: { error: "bad request" },
      message: "The request to My LLM failed (HTTP 400): bad request",
      provider_message: "bad request",
    },
    {
      name: "a JSON body without a message",
      provider: "openai-compatible",
      status: 502,
      body: { ok: false },
      message: "The request to My LLM failed (HTTP 502).",
      provider_message: undefined,
    },
    {
      name: "ollama 403 on a server that refuses the origin",
      provider: "ollama",
      status: 403,
      body: "",
      message: OLLAMA_FORBIDDEN_MESSAGE,
      provider_message: undefined,
    },
    {
      name: "ollama 403 with a body",
      provider: "ollama",
      status: 403,
      body: ollama.error("forbidden"),
      message: OLLAMA_FORBIDDEN_MESSAGE,
      provider_message: "forbidden",
    },
    {
      name: "openai 403 is an ordinary failure",
      provider: "openai-compatible",
      status: 403,
      body: openai.error("no access"),
      message: "The request to My LLM failed (HTTP 403): no access",
      provider_message: "no access",
    },
  ] as {
    name: string;
    provider: Provider;
    status: number;
    body: unknown;
    message: string;
    provider_message: string | undefined;
  }[])("$name", async ({ provider, status, body, message, provider_message }) => {
    for (const mode of ["generate", "stream"] as const) {
      const { client } = setup(
        provider,
        body === "" ? { kind: "text", body: "", status } : { kind: "json", body, status },
      );
      const err = await appError(call(client, mode, request()));
      expect(err.route()).toBe(`${CLIENT_NAMES[provider]}.${mode}->LLMCallFailed`);
      expect(err.message).toBe(message);
      expect(err.metadata).toEqual({
        provider,
        status,
        ...(provider_message === undefined ? {} : { provider_message }),
      });
    }
  });

  it("cuts the provider's message to 300 characters", async () => {
    const { client } = setup("openai-compatible", {
      kind: "json",
      status: 500,
      body: openai.error("x".repeat(1000)),
    });
    const err = await appError(client.generate(request()));
    expect(err.metadata.provider_message).toBe("x".repeat(300));
    expect(err.message.length).toBeLessThan(400);
  });

  it("does not use a body that is not JSON", async () => {
    const { client } = setup("openai-compatible", {
      kind: "text",
      body: "<html>Bad gateway</html>",
      status: 502,
    });
    const err = await appError(client.generate(request()));
    expect(err.message).toBe("The request to My LLM failed (HTTP 502).");
    expect(err.metadata).toEqual({ provider: "openai-compatible", status: 502 });
  });

  it.each(PROVIDERS)(
    "%s: neither the request body nor the key is in the error",
    async (provider) => {
      const { client } = setup(provider, {
        kind: "json",
        status: 500,
        body: { error: { message: "boom" } },
      });
      const err = await appError(client.generate(request()));
      const text = JSON.stringify([err.message, err.metadata, err.route()]);
      expect(text).not.toContain(PROMPT);
      expect(text).not.toContain("He go");
      expect(text).not.toContain(SECRET_KEY);
    },
  );

  it.each(
    PROVIDERS.flatMap((provider) =>
      (["generate", "stream"] as const).map((mode) => ({ provider, mode })),
    ),
  )("$provider $mode: a network error is LLMCallFailed", async ({ provider, mode }) => {
    const { client } = setup(provider, {
      kind: "network-error",
      message: "NetworkError when attempting to fetch resource.",
    });
    const err = await appError(call(client, mode, request()));
    expect(err.route()).toBe(`${CLIENT_NAMES[provider]}.${mode}->LLMCallFailed`);
    expect(err.message).toBe(
      "The request to My LLM failed: NetworkError when attempting to fetch resource.",
    );
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it.each(PROVIDERS)("%s: a connection dropped mid-stream is LLMCallFailed", async (provider) => {
    const wire = responses(provider, { content: "partial text" }).stream;
    const { client } = setup(provider, {
      ...wire,
      chunks: [wire.chunks[0]?.toString().slice(0, 60) ?? ""],
      breakAfter: true,
    });
    const err = await appError(client.stream(request(), { onText: () => undefined }));
    expect(err.tag).toBe("LLMCallFailed");
  });

  it.each([
    { provider: "ollama", chunks: ['{"message":{"content":"hi"},"done":false}\n'] },
    {
      provider: "openai-compatible",
      chunks: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'],
    },
    { provider: "anthropic", chunks: ['event: ping\ndata: {"type":"ping"}\n\n'] },
  ] as const)(
    "$provider: a stream that ends before the reply is complete is LLMCallFailed",
    async ({ provider, chunks }) => {
      const { client } = setup(provider, { kind: "stream", chunks });
      const err = await appError(client.stream(request(), { onText: () => undefined }));
      expect(err.route()).toBe(`${CLIENT_NAMES[provider]}.stream->LLMCallFailed`);
      expect(err.message).toBe("The reply from the server ended before it was complete.");
    },
  );

  it.each(PROVIDERS)("%s: a 200 reply that is not JSON is LLMCallFailed", async (provider) => {
    const { client } = setup(provider, { kind: "text", body: "this is not json at all" });
    const err = await appError(client.generate(request()));
    expect(err.tag).toBe("LLMCallFailed");
    expect(err.message).toBe("The server sent a reply that is not valid JSON.");
    expect(JSON.stringify(err.metadata)).not.toContain("this is not");
  });

  it.each([
    {
      provider: "ollama",
      chunks: ['{"message":{"content":"hi"},"done":false}\n', '{"error":"model crashed"}\n'],
    },
    {
      provider: "openai-compatible",
      chunks: [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"error":{"message":"model crashed"}}\n\n',
      ],
    },
    { provider: "anthropic", chunks: [anthropicStreamError("model crashed")] },
  ] as const)(
    "$provider: an error message in the stream is LLMCallFailed",
    async ({ provider, chunks }) => {
      const { client } = setup(provider, { kind: "stream", chunks });
      const err = await appError(client.stream(request(), { onText: () => undefined }));
      expect(err.route()).toBe(`${CLIENT_NAMES[provider]}.stream->LLMCallFailed`);
      expect(err.message).toBe("The server reported an error: model crashed");
    },
  );

  it.each([
    { provider: "ollama", chunks: ["not json\n"] },
    { provider: "openai-compatible", chunks: ["data: not json\n\n"] },
    { provider: "anthropic", chunks: ["data: not json\n\n"] },
  ] as const)(
    "$provider: a stream message that is not JSON is LLMCallFailed",
    async ({ provider, chunks }) => {
      const { client } = setup(provider, { kind: "stream", chunks });
      const err = await appError(client.stream(request(), { onText: () => undefined }));
      expect(err.tag).toBe("LLMCallFailed");
    },
  );

  it("an error in a non-streamed 200 reply is LLMCallFailed", async () => {
    const { client } = setup("anthropic", { kind: "json", body: anthropic.error("overloaded") });
    const err = await appError(client.generate(request()));
    expect(err.message).toBe("The server reported an error: overloaded");
  });

  it("a stream without a body is LLMCallFailed", async () => {
    const fake = (() =>
      Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
    const client = createClient(config("ollama"), {
      fetch: fake,
      permissions: { contains: () => Promise.resolve(true) },
    });
    const err = await appError(client.stream(request(), { onText: () => undefined }));
    expect(err.tag).toBe("LLMCallFailed");
  });
});

describe("createClient", () => {
  const deps = {
    fetch: new FakeFetch({ kind: "hang" }).fetch,
    permissions: { contains: () => Promise.resolve(true) },
  };

  it("exposes the provider", () => {
    expect(createClient(config("anthropic"), deps).provider).toBe("anthropic");
  });

  it.each([
    { provider: "gemini", base: "http://x" },
    { provider: "", base: "http://x" },
  ])("refuses the provider $provider", ({ provider, base }) => {
    expect(() => createClient({ ...config("ollama"), provider, base_url: base }, deps)).toThrow(
      AppError,
    );
    try {
      createClient({ ...config("ollama"), provider, base_url: base }, deps);
    } catch (err) {
      expect((err as AppError).hasRoute("createClient->parseProvider->UnknownProvider")).toBe(true);
    }
  });

  it.each(["", "localhost:11434", "ftp://host", "http://"])("refuses the base URL %j", (base) => {
    try {
      createClient(config("ollama", { base_url: base }), deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).hasRoute("createClient->LLMConfigInvalid")).toBe(true);
      expect((err as AppError).metadata).toEqual({ field: "base_url" });
    }
  });
});

// One literal route test per tag of SPEC section 10 that this package owns.
describe("route tests", () => {
  it("LLMCallTimeout", async () => {
    const { client } = setup("openai-compatible", { kind: "hang" });
    const err = await appError(client.generate(request({ timeoutMs: 20 })));
    expect(err.hasRoute("OpenAIClient.generate->LLMCallTimeout")).toBe(true);
  });

  it("LLMCallFailed", async () => {
    const { client } = setup("anthropic", {
      kind: "json",
      status: 500,
      body: anthropic.error("boom"),
    });
    const err = await appError(client.stream(request(), { onText: () => undefined }));
    expect(err.hasRoute("AnthropicClient.stream->LLMCallFailed")).toBe(true);
  });

  it("HostPermissionDenied", async () => {
    const { client } = setup("ollama", { kind: "hang" }, {}, false);
    const err = await appError(client.generate(request()));
    expect(err.hasRoute("OllamaClient.generate->HostPermissionDenied")).toBe(true);
  });
});
