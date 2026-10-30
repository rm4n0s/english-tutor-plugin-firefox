import type { Logger } from "../log";
import type { Usage } from "../llm";

/** What a request was for (SPEC section 5.8). Test connection is not recorded. */
export type UsageKind = "check" | "explain" | "alternatives";

/** The token usage of one request, ready to be stored (`llm_usage`, step 9). */
export interface UsageRecord {
  /** The display name of the configured LLM. */
  readonly llm: string;
  readonly kind: UsageKind;
  readonly usage: Usage;
}

/**
 * Stores token usage. The store implements it (step 9). A failure to record never fails the
 * request: it is logged and ignored.
 */
export interface UsageRecorder {
  record(record: UsageRecord): void | Promise<void>;
}

export const NO_USAGE: Usage = Object.freeze({ inputTokens: 0, outputTokens: 0, estimated: false });

export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Records `usage` unless it is empty. A cancelled or failed request still used the tokens it
 * reported, so callers record in every outcome.
 */
export async function recordUsage(
  recorder: UsageRecorder | undefined,
  logger: Logger | undefined,
  llm: string,
  kind: UsageKind,
  usage: Usage,
): Promise<void> {
  if (recorder === undefined || totalTokens(usage) === 0) return;
  try {
    await recorder.record({ llm, kind, usage });
  } catch (err) {
    logger?.warn("saving token usage failed", { kind, err });
  }
}
