/** What a request is for; it decides the default timeout (SPEC section 7). */
export type RequestKind = "check" | "explain" | "alternatives";

export const CHECK_TIMEOUT_MS = 15 * 60 * 1000;
export const EXPLAIN_TIMEOUT_MS = 120 * 1000;
export const ALTERNATIVES_TIMEOUT_MS = 120 * 1000;
export const TEST_TIMEOUT_MS = 60 * 1000;

/** `max_tokens` where the provider needs one (Anthropic), SPEC section 6.1. */
export const CHECK_MAX_TOKENS = 8192;
export const EXPLAIN_MAX_TOKENS = 4096;
export const ALTERNATIVES_MAX_TOKENS = 4096;

/**
 * The timeout of a request: the LLM's own *Timeout* (seconds) if it has one, else the default of
 * the kind. A check's timeout applies to each chunk.
 */
export function timeoutFor(timeoutSeconds: number | null, kind: RequestKind): number {
  if (timeoutSeconds !== null && timeoutSeconds > 0) return timeoutSeconds * 1000;
  switch (kind) {
    case "check":
      return CHECK_TIMEOUT_MS;
    case "explain":
      return EXPLAIN_TIMEOUT_MS;
    case "alternatives":
      return ALTERNATIVES_TIMEOUT_MS;
  }
}
