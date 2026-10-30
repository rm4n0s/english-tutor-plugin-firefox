import canned from "./canned.json";

/**
 * Canned replies of the three wire formats, as the real servers send them (SPEC section 6). The
 * values in `canned.json` are shared with the screenshot harness' fake server
 * (`scripts/fake-llm.mjs`).
 */

/** A valid check reply (SPEC section 5.2), as the model's text. */
export const CHECK_REPLY_TEXT = JSON.stringify(canned.checkReply);
export const TEST_REPLY_TEXT = canned.testReply;
export const CANNED_USAGE = canned.usage;

export interface CannedReply {
  content: string;
  /** Streamed in these pieces, in order, when given; else `content` is split in two. */
  pieces?: readonly string[];
  /** Thinking the model did before answering; it is on the wire and must not come out. */
  thinking?: string;
  /** Tokens the provider reports; undefined reports none, and `{ input: 0, output: 0 }` zeros. */
  usage?: { input: number; output: number } | undefined;
  /** The provider's stop reason. */
  stopReason?: string;
}

function pieces(reply: CannedReply): readonly string[] {
  if (reply.pieces) return reply.pieces;
  const middle = Math.ceil(reply.content.length / 2);
  return [reply.content.slice(0, middle), reply.content.slice(middle)];
}

function sse(events: readonly (readonly [string | undefined, unknown])[]): string {
  return events
    .map(([event, data]) => {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      return `${event === undefined ? "" : `event: ${event}\n`}data: ${text}\n\n`;
    })
    .join("");
}

/** Ollama (`/api/chat`). */
export const ollama = {
  json(reply: CannedReply): unknown {
    return {
      model: "llama3.1",
      message: {
        role: "assistant",
        content: reply.content,
        ...(reply.thinking === undefined ? {} : { thinking: reply.thinking }),
      },
      done: true,
      done_reason: reply.stopReason ?? "stop",
      ...(reply.usage
        ? { prompt_eval_count: reply.usage.input, eval_count: reply.usage.output }
        : {}),
    };
  },
  /** Newline-delimited JSON, the last object has `done: true`. */
  ndjson(reply: CannedReply): string {
    const lines: unknown[] = [];
    if (reply.thinking !== undefined) {
      lines.push({
        message: { role: "assistant", content: "", thinking: reply.thinking },
        done: false,
      });
    }
    for (const piece of pieces(reply)) {
      lines.push({ message: { role: "assistant", content: piece }, done: false });
    }
    lines.push({
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: reply.stopReason ?? "stop",
      ...(reply.usage
        ? { prompt_eval_count: reply.usage.input, eval_count: reply.usage.output }
        : {}),
    });
    return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  },
  error(message: string): unknown {
    return { error: message };
  },
};

/** OpenAI-compatible (`/chat/completions`). */
export const openai = {
  json(reply: CannedReply): unknown {
    return {
      id: "chatcmpl-fake",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply.content,
            ...(reply.thinking === undefined ? {} : { reasoning_content: reply.thinking }),
          },
          finish_reason: reply.stopReason ?? "stop",
        },
      ],
      ...(reply.usage
        ? {
            usage: {
              prompt_tokens: reply.usage.input,
              completion_tokens: reply.usage.output,
              total_tokens: reply.usage.input + reply.usage.output,
            },
          }
        : {}),
    };
  },
  /** Server-Sent Events: deltas, the finish reason, the usage chunk (`stream_options`), `[DONE]`. */
  sse(reply: CannedReply): string {
    const events: (readonly [string | undefined, unknown])[] = [];
    events.push([undefined, { choices: [{ index: 0, delta: { role: "assistant" } }] }]);
    if (reply.thinking !== undefined) {
      events.push([
        undefined,
        { choices: [{ index: 0, delta: { reasoning_content: reply.thinking } }] },
      ]);
    }
    for (const piece of pieces(reply)) {
      events.push([undefined, { choices: [{ index: 0, delta: { content: piece } }] }]);
    }
    events.push([
      undefined,
      { choices: [{ index: 0, delta: {}, finish_reason: reply.stopReason ?? "stop" }] },
    ]);
    if (reply.usage) {
      events.push([
        undefined,
        {
          choices: [],
          usage: { prompt_tokens: reply.usage.input, completion_tokens: reply.usage.output },
        },
      ]);
    }
    events.push([undefined, "[DONE]"]);
    return sse(events);
  },
  error(message: string): unknown {
    return { error: { message, type: "invalid_request_error" } };
  },
};

/** Anthropic (`/v1/messages`). */
export const anthropic = {
  json(reply: CannedReply): unknown {
    return {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      content: [
        ...(reply.thinking === undefined ? [] : [{ type: "thinking", thinking: reply.thinking }]),
        { type: "text", text: reply.content },
      ],
      stop_reason: reply.stopReason ?? "end_turn",
      ...(reply.usage
        ? { usage: { input_tokens: reply.usage.input, output_tokens: reply.usage.output } }
        : {}),
    };
  },
  /** Server-Sent Events with event names, `message_start` first and `message_stop` last. */
  sse(reply: CannedReply): string {
    const events: (readonly [string | undefined, unknown])[] = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id: "msg_fake",
            role: "assistant",
            content: [],
            usage: { input_tokens: reply.usage?.input ?? 0, output_tokens: 1 },
          },
        },
      ],
      ["ping", { type: "ping" }],
    ];
    let index = 0;
    if (reply.thinking !== undefined) {
      events.push(
        [
          "content_block_start",
          { type: "content_block_start", index, content_block: { type: "thinking" } },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: reply.thinking },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index }],
      );
      index++;
    }
    events.push([
      "content_block_start",
      { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ]);
    for (const piece of pieces(reply)) {
      events.push([
        "content_block_delta",
        { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } },
      ]);
    }
    events.push(
      ["content_block_stop", { type: "content_block_stop", index }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: reply.stopReason ?? "end_turn" },
          usage: { output_tokens: reply.usage?.output ?? 0 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    );
    return sse(events);
  },
  error(message: string): unknown {
    return { type: "error", error: { type: "invalid_request_error", message } };
  },
};

/** A mid-stream error event of Anthropic (`overloaded_error`). */
export function anthropicStreamError(message: string): string {
  return sse([["error", { type: "error", error: { type: "overloaded_error", message } }]]);
}

/** The UTF-8 bytes of `text` cut at the given byte offsets (so a cut can fall inside a character). */
export function splitAtBytes(text: string, offsets: readonly number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const cuts = [
    0,
    ...offsets.filter((offset) => offset > 0 && offset < bytes.length),
    bytes.length,
  ];
  const parts: Uint8Array[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    parts.push(bytes.slice(cuts[i], cuts[i + 1]));
  }
  return parts;
}

/** The UTF-8 bytes of `text` in pieces of `size` bytes. */
export function splitEvery(text: string, size: number): Uint8Array[] {
  const length = new TextEncoder().encode(text).length;
  const offsets: number[] = [];
  for (let offset = size; offset < length; offset += size) offsets.push(offset);
  return splitAtBytes(text, offsets);
}
