import type { LLMClient } from "../llm";

/** The LLM a request is sent to, as the analysis code needs it. */
export interface AnalysisModel {
  readonly client: LLMClient;
  /** The display name of the configured LLM, used in usage records and logs. */
  readonly name: string;
  /** The LLM's own *Timeout* in seconds; `null`, `0` or missing keep the default of the request kind. */
  readonly timeoutSeconds?: number | null;
  /** *Parallel requests* of a check; missing or below 1 means one at a time. */
  readonly parallel?: number;
}
