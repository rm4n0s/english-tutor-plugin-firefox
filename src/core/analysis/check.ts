import { AppError } from "../errors";
import { CHECK_MAX_TOKENS, timeoutFor } from "../llm";
import type { GenerateResult, Usage } from "../llm";
import type { Random } from "../random";
import type { AnalysisModel } from "./model";
import { INVALID_REPLY_MESSAGE, parseResponse, type Parsed } from "./parse";
import { buildCheckPrompt, withRetryReminder } from "./prompt";

/**
 * A reply that stopped because the model ran out of output tokens: `length` for OpenAI-compatible
 * servers and `max_tokens` for Anthropic.
 */
export function isOutputLimit(stopReason: string): boolean {
  return stopReason === "length" || stopReason === "max_tokens";
}

export const CUT_OFF_MESSAGE =
  "The model's answer was cut off because it reached its output limit. Check a shorter text, or set more Parallel requests for this LLM so each part is shorter.";

/**
 * Adds to an `LLMResponseInvalid` error what is known about why the reply was unusable, without
 * the reply itself: its length and the stop reason. A reply that stopped because the model ran out
 * of output tokens gets a message that says what to do about it. The route of `err` is kept.
 */
export function describeInvalid(
  err: AppError,
  reply: Pick<GenerateResult, "stopReason">,
): AppError {
  const described = new AppError(
    err.tag,
    isOutputLimit(reply.stopReason) ? CUT_OFF_MESSAGE : INVALID_REPLY_MESSAGE,
    { ...err.metadata, stop_reason: reply.stopReason },
    { cause: err.cause },
  );
  for (const where of [...err.where].reverse()) described.via(where);
  return described;
}

export interface CheckTextResult {
  readonly parsed: Parsed;
  /** True if the first reply was invalid and a second request was made. */
  readonly retried: boolean;
}

/**
 * Asks the model for the errors in `text` and parses the reply. If the first reply is not valid,
 * it asks once more with a reminder to return JSON only; a second invalid reply throws
 * `LLMResponseInvalid`. An error from the client is thrown untouched and never retried, so the
 * caller can tell a cancel from a failure. `onUsage` gets the usage of each reply that arrived,
 * so the caller has it even when a later request fails.
 */
export async function checkText(
  model: AnalysisModel,
  text: string,
  random: Random,
  signal: AbortSignal,
  onUsage: (usage: Usage) => void,
): Promise<CheckTextResult> {
  let prompt = buildCheckPrompt(text, random);
  const timeoutMs = timeoutFor(model.timeoutSeconds ?? null, "check");
  for (let attempt = 0; ; attempt++) {
    const reply = await model.client.generate({
      system: prompt.system,
      prompt: prompt.user,
      maxTokens: CHECK_MAX_TOKENS,
      timeoutMs,
      signal,
    });
    onUsage(reply.usage);
    try {
      return { parsed: parseResponse(reply.text), retried: attempt > 0 };
    } catch (err) {
      if (!(err instanceof AppError) || err.tag !== "LLMResponseInvalid") throw err;
      if (attempt === 1) throw describeInvalid(err, reply);
      prompt = withRetryReminder(prompt);
    }
  }
}
