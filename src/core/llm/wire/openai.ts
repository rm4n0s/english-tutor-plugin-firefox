import { count } from "../usage";
import type { ReportedUsage } from "../usage";
import type { StreamDecoder, Wire, WireReply } from "./types";
import { addMissing, asRecord, asString, parseJson, providerMessage, streamError } from "./util";

/**
 * OpenAI-compatible servers: `POST {base}/chat/completions`, Server-Sent Events when streaming
 * (SPEC sections 6.1, 6.2).
 */

function usageOf(value: unknown): ReportedUsage | undefined {
  const usage = asRecord(value);
  const inputTokens = count(usage.prompt_tokens);
  const outputTokens = count(usage.completion_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

function firstChoice(message: Record<string, unknown>): Record<string, unknown> {
  const choices = message.choices;
  return Array.isArray(choices) ? asRecord(choices[0]) : {};
}

/** The No thinking fields of SPEC section 6.4; a field the body already has is kept. */
const NO_THINKING_FIELDS: Readonly<Record<string, unknown>> = {
  thinking: { type: "disabled" },
  enable_thinking: false,
  chat_template_kwargs: { enable_thinking: false },
};

class OpenAIDecoder implements StreamDecoder {
  complete = false;
  usage: ReportedUsage | undefined;
  stopReason = "";

  feed(data: string): string {
    if (data.trim() === "[DONE]") {
      this.complete = true;
      return "";
    }
    const message = asRecord(parseJson(data));
    if ("error" in message) throw streamError(providerMessage(message));
    const usage = usageOf(message.usage);
    if (usage !== undefined) this.usage = usage;
    const choice = firstChoice(message);
    const finish = asString(choice.finish_reason);
    if (finish !== "") {
      this.stopReason = finish;
      this.complete = true;
    }
    // `delta.reasoning_content` is the model's thinking and is never returned.
    return asString(asRecord(choice.delta).content);
  }
}

export const openaiWire: Wire = {
  clientName: "OpenAIClient",
  framing: "sse",
  url: (base) => `${base}/chat/completions`,
  headers: (apiKey) => (apiKey === "" ? {} : { Authorization: `Bearer ${apiKey}` }),
  body(config, request, stream) {
    const messages = [
      ...(request.system === "" ? [] : [{ role: "system", content: request.system }]),
      { role: "user", content: request.prompt },
    ];
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: config.temperature,
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (config.noThinking) addMissing(body, NO_THINKING_FIELDS);
    return body;
  },
  parseReply(json): WireReply {
    const body = asRecord(json);
    if ("error" in body) throw streamError(providerMessage(body));
    const choice = firstChoice(body);
    return {
      text: asString(asRecord(choice.message).content),
      usage: usageOf(body.usage),
      stopReason: asString(choice.finish_reason),
    };
  },
  newDecoder: () => new OpenAIDecoder(),
};
