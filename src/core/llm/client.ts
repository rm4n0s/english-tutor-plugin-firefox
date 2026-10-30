import { AppError } from "../errors";
import { effectiveBaseUrl, parseHttpUrl } from "./endpoint";
import { DEFAULT_TEMPERATURE, PROVIDER_LABELS, parseProvider, type Provider } from "./provider";
import { ndjsonMessages, readLines, sseEvents } from "./stream";
import { stripThinking, ThinkFilter } from "./think";
import { resolveUsage, type ReportedUsage, type Usage } from "./usage";
import { anthropicWire } from "./wire/anthropic";
import { ollamaWire } from "./wire/ollama";
import { openaiWire } from "./wire/openai";
import type { Wire } from "./wire/types";
import { cut, parseJson, providerMessage } from "./wire/util";

/** The message of a 403 from Ollama (SPEC sections 4.7 and 6.5). */
export const OLLAMA_FORBIDDEN_MESSAGE =
  "Ollama refused the request from the extension. Allow it by starting Ollama with OLLAMA_ORIGINS=moz-extension://*.";

/** Answers whether the extension may talk to an LLM's server. `src/platform/permissions.ts` is the real one. */
export interface HostPermissionCheck {
  /** `baseUrl` is the effective base URL of the LLM. */
  contains(baseUrl: string): Promise<boolean>;
}

export interface ClientDeps {
  /** The page's `fetch`, or a fake in tests. */
  fetch: typeof fetch;
  permissions: HostPermissionCheck;
}

/** The part of an LLM configuration a client needs. */
export interface ClientConfig {
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
  temperature: number | null;
  no_thinking: boolean;
}

export interface ClientOptions {
  /** The LLM's name, used in messages. Default: the provider's name. */
  name?: string;
}

export interface GenerateRequest {
  /** "" or missing for none. */
  system?: string;
  prompt: string;
  /** Sent where the provider requires it (Anthropic). */
  maxTokens: number;
  /** The request fails with `LLMCallTimeout` after this long. */
  timeoutMs: number;
  /**
   * Cancels the request. A cancel is not a failure: the call rejects with the signal's reason
   * (see `isCancelled`), never with an `AppError`.
   */
  signal?: AbortSignal;
}

export interface GenerateResult {
  /** The answer, trimmed, without the model's thinking. */
  text: string;
  /** What the provider reported, else an estimate from the text lengths (SPEC section 5.8). */
  usage: Usage;
  /** Why the model stopped, as the provider says ("stop", "length", "max_tokens"...); "" if it does not. */
  stopReason: string;
}

export interface StreamHandlers {
  /** Each piece of the answer, as it arrives. Thinking is not passed. */
  onText(chunk: string): void;
  /** The usage the provider has reported so far, when it changes. Lets a cancelled request keep it. */
  onUsage?(usage: ReportedUsage): void;
}

/**
 * One configured LLM. Failures are `AppError`s whose route is `<Client>.generate->Tag` or
 * `<Client>.stream->Tag`: `HostPermissionDenied`, `LLMCallTimeout`, `LLMCallFailed`
 * (and `LLMConfigInvalid` when the base URL is no address, `UnknownProvider` from `createClient`).
 */
export interface LLMClient {
  readonly provider: Provider;
  /** One request, not streamed. */
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /** One streamed request. The result is the whole answer, as `generate` gives it. */
  stream(request: GenerateRequest, handlers: StreamHandlers): Promise<GenerateResult>;
}

const WIRES: Readonly<Record<Provider, Wire>> = {
  ollama: ollamaWire,
  "openai-compatible": openaiWire,
  anthropic: anthropicWire,
};

/**
 * The client of a configuration. Throws `UnknownProvider`, or `LLMConfigInvalid` when the base
 * URL is not an `http(s)` address.
 */
export function createClient(
  config: ClientConfig,
  deps: ClientDeps,
  options: ClientOptions = {},
): LLMClient {
  let provider: Provider;
  try {
    provider = parseProvider(config.provider);
  } catch (err) {
    throw err instanceof AppError ? err.via("createClient") : err;
  }
  const baseUrl = effectiveBaseUrl(provider, config.base_url);
  if (parseHttpUrl(baseUrl) === undefined) {
    throw new AppError(
      "LLMConfigInvalid",
      "Base URL must be an address such as http://localhost:11434.",
      {
        field: "base_url",
      },
    ).via("createClient");
  }
  return new HttpClient(provider, WIRES[provider], baseUrl, config, deps, options.name);
}

/** True for the rejection of a cancelled call: not an `AppError`, and the signal is aborted. */
export function isCancelled(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && !(err instanceof AppError);
}

/** The reason of an aborted signal, as an `Error` (a `DOMException` named `AbortError` by default). */
function cancelReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was aborted.", "AbortError");
}

class HttpClient implements LLMClient {
  readonly provider: Provider;
  private readonly wire: Wire;
  private readonly baseUrl: string;
  private readonly config: ClientConfig;
  private readonly deps: ClientDeps;
  private readonly name: string;

  constructor(
    provider: Provider,
    wire: Wire,
    baseUrl: string,
    config: ClientConfig,
    deps: ClientDeps,
    name: string | undefined,
  ) {
    this.provider = provider;
    this.wire = wire;
    this.baseUrl = baseUrl;
    this.config = config;
    this.deps = deps;
    this.name = name !== undefined && name !== "" ? name : PROVIDER_LABELS[provider];
  }

  generate(request: GenerateRequest): Promise<GenerateResult> {
    return this.run("generate", request, undefined);
  }

  stream(request: GenerateRequest, handlers: StreamHandlers): Promise<GenerateResult> {
    return this.run("stream", request, handlers);
  }

  private async run(
    method: "generate" | "stream",
    request: GenerateRequest,
    handlers: StreamHandlers | undefined,
  ): Promise<GenerateResult> {
    const where = `${this.wire.clientName}.${method}`;
    const cancel = request.signal;
    let timeout: AbortSignal | undefined;
    try {
      cancel?.throwIfAborted();
      await this.requirePermission();
      timeout = AbortSignal.timeout(request.timeoutMs);
      const signal = cancel === undefined ? timeout : AbortSignal.any([cancel, timeout]);
      return await this.exchange(request, signal, handlers);
    } catch (err) {
      // Order matters: a cancel is never an error, and an abort of the timeout is not a failure.
      if (cancel?.aborted === true) throw cancelReason(cancel);
      if (err instanceof AppError) throw err.via(where);
      if (timeout?.aborted === true) {
        throw new AppError(
          "LLMCallTimeout",
          `The request to ${this.name} took longer than ${formatSeconds(request.timeoutMs)}.`,
          { provider: this.provider, timeout_s: Math.round(request.timeoutMs / 1000) },
          { cause: err },
        ).via(where);
      }
      throw new AppError(
        "LLMCallFailed",
        `The request to ${this.name} failed: ${describeNetworkError(err)}`,
        { provider: this.provider },
        { cause: err },
      ).via(where);
    }
  }

  /** `HostPermissionDenied` unless the origin is granted. Nothing has been sent yet. */
  private async requirePermission(): Promise<void> {
    if (await this.deps.permissions.contains(this.baseUrl)) return;
    const origin = parseHttpUrl(this.baseUrl)?.origin ?? "";
    throw new AppError(
      "HostPermissionDenied",
      `Access to ${origin} has not been allowed. Save the LLM again in Preferences to allow it.`,
      { origin },
    );
  }

  private async exchange(
    request: GenerateRequest,
    signal: AbortSignal,
    handlers: StreamHandlers | undefined,
  ): Promise<GenerateResult> {
    const streaming = handlers !== undefined;
    const system = request.system ?? "";
    const body = this.wire.body(
      {
        model: this.config.model,
        apiKey: this.config.api_key,
        temperature: this.config.temperature ?? DEFAULT_TEMPERATURE,
        noThinking: this.config.no_thinking && this.provider !== "anthropic",
      },
      { system, prompt: request.prompt, maxTokens: request.maxTokens },
      streaming,
    );
    const response = await this.deps.fetch(this.wire.url(this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.wire.headers(this.config.api_key) },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await this.httpFailure(response);

    const input = system + request.prompt;
    if (!streaming) {
      const reply = this.wire.parseReply(parseJson(await response.text()));
      return {
        text: stripThinking(reply.text).trim(),
        usage: resolveUsage(reply.usage, input, reply.text),
        stopReason: reply.stopReason,
      };
    }

    if (response.body === null) {
      throw new AppError("LLMCallFailed", "The server sent no reply body.", { stage: "stream" });
    }
    const decoder = this.wire.newDecoder();
    const filter = new ThinkFilter();
    const lines = readLines(response.body, signal);
    const messages = this.wire.framing === "sse" ? sseEvents(lines) : ndjsonMessages(lines);
    let raw = "";
    let shown = "";
    let reported: ReportedUsage | undefined;
    const show = (text: string) => {
      if (text === "") return;
      shown += text;
      handlers.onText(text);
    };
    for await (const message of messages) {
      const delta = decoder.feed(message.data, message.event);
      raw += delta;
      show(filter.push(delta));
      const usage = decoder.usage;
      if (
        usage !== undefined &&
        (usage.inputTokens !== reported?.inputTokens ||
          usage.outputTokens !== reported.outputTokens)
      ) {
        reported = usage;
        handlers.onUsage?.(usage);
      }
    }
    // A reader that was cancelled by the abort ends quietly: the abort is the reason.
    signal.throwIfAborted();
    show(filter.end());
    if (!decoder.complete) {
      throw new AppError(
        "LLMCallFailed",
        "The reply from the server ended before it was complete.",
        {
          stage: "stream",
          provider: this.provider,
        },
      );
    }
    return {
      text: stripThinking(shown).trim(),
      usage: resolveUsage(decoder.usage, input, raw),
      stopReason: decoder.stopReason,
    };
  }

  /** A non-2xx answer. The request body is never part of it (SPEC section 6.5). */
  private async httpFailure(response: Response): Promise<AppError> {
    const status = response.status;
    const text = await response.text();
    let message = "";
    try {
      message = providerMessage(JSON.parse(text));
    } catch {
      // Not JSON: there is no provider message.
    }
    const metadata = {
      provider: this.provider,
      status,
      ...(message === "" ? {} : { provider_message: message }),
    };
    if (status === 403 && this.provider === "ollama") {
      return new AppError("LLMCallFailed", OLLAMA_FORBIDDEN_MESSAGE, metadata);
    }
    const detail = message === "" ? "." : `: ${message}`;
    return new AppError(
      "LLMCallFailed",
      `The request to ${this.name} failed (HTTP ${String(status)})${detail}`,
      metadata,
    );
  }
}

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 120 && seconds % 60 === 0
    ? `${String(seconds / 60)} minutes`
    : `${String(seconds)} seconds`;
}

/** Network errors are `TypeError`s with a fixed browser text; anything else is described by its name. */
function describeNetworkError(err: unknown): string {
  if (err instanceof TypeError) return cut(err.message);
  return err instanceof Error ? err.name : "unexpected error";
}
