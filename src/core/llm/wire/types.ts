import type { ReportedUsage } from "../usage";

/** What a wire format needs to know about the LLM. */
export interface WireConfig {
  model: string;
  apiKey: string;
  /** Always set: the LLM's own, or the default of SPEC section 4.7. */
  temperature: number;
  noThinking: boolean;
}

export interface WireRequest {
  /** "" for none. */
  system: string;
  prompt: string;
  /** Only sent where the provider requires it (Anthropic). */
  maxTokens: number;
}

/** A non-streamed reply, read from the parsed JSON body. */
export interface WireReply {
  /** The model's answer, with its thinking if it put any in the text. */
  text: string;
  usage: ReportedUsage | undefined;
  /** "" when the provider did not say. */
  stopReason: string;
}

/** Reads the messages of one streamed reply, in order. */
export interface StreamDecoder {
  /**
   * Handles one message (`data` is the raw text of an SSE event or an NDJSON line) and returns the
   * text it adds to the answer, "" for none. Throws `LLMCallFailed` for an error message.
   */
  feed(data: string, event: string): string;
  /** True once the provider has said that the reply is complete. */
  readonly complete: boolean;
  /** Usage reported so far (may be partial), for a caller that is cancelled. */
  readonly usage: ReportedUsage | undefined;
  readonly stopReason: string;
}

/** One provider's wire format (SPEC section 6). Pure: it neither fetches nor reads time. */
export interface Wire {
  /** The name of the client, the first part of an error's route (for example `OpenAIClient`). */
  readonly clientName: string;
  readonly framing: "sse" | "ndjson";
  /** The address of the chat endpoint, from the base URL without a trailing slash. */
  url(base: string): string;
  headers(apiKey: string): Record<string, string>;
  body(config: WireConfig, request: WireRequest, stream: boolean): Record<string, unknown>;
  parseReply(json: unknown): WireReply;
  newDecoder(): StreamDecoder;
}
