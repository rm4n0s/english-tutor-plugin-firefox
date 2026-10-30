import { count } from "../usage";
import type { ReportedUsage } from "../usage";
import type { StreamDecoder, Wire, WireReply } from "./types";
import { asRecord, asString, parseJson, providerMessage, streamError } from "./util";

/** Anthropic: `POST {base}/v1/messages`, Server-Sent Events when streaming (SPEC sections 6.1, 6.2). */

class AnthropicDecoder implements StreamDecoder {
  complete = false;
  stopReason = "";
  private input: number | undefined;
  private output: number | undefined;

  get usage(): ReportedUsage | undefined {
    if (this.input === undefined && this.output === undefined) return undefined;
    return { inputTokens: this.input ?? 0, outputTokens: this.output ?? 0 };
  }

  feed(data: string): string {
    const message = asRecord(parseJson(data));
    switch (message.type) {
      case "message_start": {
        // The input tokens are final here; the output tokens only start to count.
        const usage = asRecord(asRecord(message.message).usage);
        this.input = count(usage.input_tokens) ?? this.input;
        this.output = count(usage.output_tokens) ?? this.output;
        return "";
      }
      case "content_block_delta": {
        // Only `text_delta` is text: a `thinking_delta` is the model's thinking.
        const delta = asRecord(message.delta);
        return delta.type === "text_delta" ? asString(delta.text) : "";
      }
      case "message_delta": {
        const usage = asRecord(message.usage);
        this.input = count(usage.input_tokens) ?? this.input;
        // `output_tokens` of message_delta is the total so far, the last one wins.
        this.output = count(usage.output_tokens) ?? this.output;
        const stop = asString(asRecord(message.delta).stop_reason);
        if (stop !== "") this.stopReason = stop;
        return "";
      }
      case "message_stop":
        this.complete = true;
        return "";
      case "error":
        throw streamError(providerMessage(message));
      default:
        return "";
    }
  }
}

export const anthropicWire: Wire = {
  clientName: "AnthropicClient",
  framing: "sse",
  url: (base) => `${base}/v1/messages`,
  headers: (apiKey) => ({
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  }),
  body(config, request, stream) {
    return {
      model: config.model,
      ...(request.system === "" ? {} : { system: request.system }),
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: request.maxTokens,
      temperature: config.temperature,
      stream,
    };
  },
  parseReply(json): WireReply {
    const body = asRecord(json);
    if (body.type === "error") throw streamError(providerMessage(body));
    const blocks = Array.isArray(body.content) ? (body.content as unknown[]) : [];
    const text = blocks
      .map(asRecord)
      .filter((block) => block.type === "text")
      .map((block) => asString(block.text))
      .join("");
    const usage = asRecord(body.usage);
    const inputTokens = count(usage.input_tokens);
    const outputTokens = count(usage.output_tokens);
    return {
      text,
      usage:
        inputTokens === undefined && outputTokens === undefined
          ? undefined
          : { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 },
      stopReason: asString(body.stop_reason),
    };
  },
  newDecoder: () => new AnthropicDecoder(),
};
