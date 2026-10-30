import { count } from "../usage";
import type { ReportedUsage } from "../usage";
import type { StreamDecoder, Wire, WireReply } from "./types";
import { addMissing, asRecord, asString, parseJson, providerMessage, streamError } from "./util";

/** Ollama: `POST {base}/api/chat`, newline-delimited JSON when streaming (SPEC sections 6.1, 6.2). */

function usageOf(message: Record<string, unknown>): ReportedUsage | undefined {
  const inputTokens = count(message.prompt_eval_count);
  const outputTokens = count(message.eval_count);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

/** `message.content` only: `message.thinking` is the model's thinking and is never returned. */
function contentOf(message: Record<string, unknown>): string {
  return asString(asRecord(message.message).content);
}

class OllamaDecoder implements StreamDecoder {
  complete = false;
  usage: ReportedUsage | undefined;
  stopReason = "";

  feed(data: string): string {
    const message = asRecord(parseJson(data));
    if ("error" in message) throw streamError(providerMessage(message));
    const usage = usageOf(message);
    if (usage !== undefined) this.usage = usage;
    if (message.done === true) {
      this.complete = true;
      this.stopReason = asString(message.done_reason);
    }
    return contentOf(message);
  }
}

export const ollamaWire: Wire = {
  clientName: "OllamaClient",
  framing: "ndjson",
  url: (base) => `${base}/api/chat`,
  headers: () => ({}),
  body(config, request, stream) {
    const messages = [
      ...(request.system === "" ? [] : [{ role: "system", content: request.system }]),
      { role: "user", content: request.prompt },
    ];
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream,
      options: { temperature: config.temperature },
    };
    if (config.noThinking) addMissing(body, { think: false });
    return body;
  },
  parseReply(json): WireReply {
    const message = asRecord(json);
    if ("error" in message) throw streamError(providerMessage(message));
    return {
      text: contentOf(message),
      usage: usageOf(message),
      stopReason: asString(message.done_reason),
    };
  },
  newDecoder: () => new OllamaDecoder(),
};
