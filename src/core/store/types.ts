/** Records and values of the store (SPEC section 9). Times are milliseconds since the epoch. */

export type Provider = "ollama" | "openai-compatible" | "anthropic";

/** The fields of an LLM configuration that the caller chooses. */
export interface LLMConfigInput {
  name: string;
  provider: Provider;
  model: string;
  /** "" when the provider needs none. */
  base_url: string;
  /** "" when there is none. Stored as plain text (SPEC section 9). */
  api_key: string;
  /** null uses the default of 0.2 (SPEC section 4.7). */
  temperature: number | null;
  /** null (or 0) uses the default timeouts of SPEC section 7. */
  timeout_seconds: number | null;
  max_parallel: number;
  no_thinking: boolean;
}

export interface LLMConfig extends LLMConfigInput {
  id: number;
  created_at: number;
  updated_at: number;
}

/** "lf" or "crlf": the line ending a file used, restored when saving. */
export type LineEnding = "lf" | "crlf";

export interface DocumentInput {
  title: string;
  content: string;
  line_ending: LineEnding;
}

/** A text of the library. */
export interface LibraryDocument extends DocumentInput {
  id: number;
  created_at: number;
  updated_at: number;
}

/**
 * The seam for checking the values of an LLM configuration. It throws an `AppError`
 * (`LLMConfigInvalid`, SPEC section 10) for a value that is not allowed. The store checks
 * nothing about the values itself; the `llm` package supplies the real check (step 4).
 */
export type ConfigValidator = (input: LLMConfigInput) => void;

/** What a request was for (SPEC section 5.8). */
export type UsageKind = "check" | "explain" | "alternatives";

/** The token usage of one request, as it is stored in `llm_usage`. */
export interface UsageInput {
  /** The display name of the LLM at the time of the request. */
  llm_name: string;
  kind: UsageKind;
  input_tokens: number;
  output_tokens: number;
  /** True when the counts are estimates (the provider reported none). */
  estimated: boolean;
}

/** A mistake found by a manual check, ready to be recorded (SPEC section 5.7). */
export interface MistakeInput {
  /** The taxonomy id, for example `subject_verb_agreement`. */
  error_type: string;
  /** `grammar`, `syntax` or `vocabulary`. */
  category: string;
  /** The wrong words as checked. */
  snippet: string;
  /** Hex SHA-256 of the snippet and its occurrence number (SPEC section 5.7). */
  fingerprint: string;
}

/** A recorded mistake, as it is stored in `error_events`. */
export interface ErrorEvent extends MistakeInput {
  id: number;
  /** `session:<uuid>` or `doc:<id>` (SPEC section 5.7). */
  source_key: string;
  /** The display name of the LLM that found it. */
  llm_name: string;
  created_at: number;
}

/** What `Stats.record` did with a batch of mistakes. */
export interface RecordResult {
  inserted: number;
  /** Already recorded under this source: nothing was written, the first type stays. */
  duplicate: number;
  /** In the Not-an-error ignore set: skipped. */
  ignored: number;
}

/** What `Stats.moveSource` did. */
export interface MoveResult {
  moved: number;
  /** Events whose (source, fingerprint) pair already existed under the new source. */
  dropped: number;
}

/** The period of the Statistics dialog (SPEC section 4.8). */
export type Period = "all" | "30d" | "7d";

/** The counts of one error type (SPEC section 5.7). A window is now minus N days, inclusive. */
export interface TypeCounts {
  total: number;
  last30: number;
  last7: number;
}

/** One row of the Mistakes tab: the counts of an error type with at least one mistake. */
export interface TypeStats extends TypeCounts {
  error_type: string;
  category: string;
  /** `created_at` of the newest event of the type. */
  last_seen: number;
}

/** The summary line of the Mistakes tab: how many mistakes, and the most frequent type. */
export interface Summary {
  period: Period;
  total: number;
  /** The error type id with the most mistakes in the period; undefined when there are none. */
  mostFrequent: string | undefined;
}

/** Tokens summed over some requests. `estimated` is true if any of them was an estimate. */
export interface TokenSums {
  input_tokens: number;
  output_tokens: number;
  estimated: boolean;
}

/** The token usage of one LLM (by its name at the time of the requests), per period. */
export interface UsageTotals {
  llm_name: string;
  all: TokenSums;
  last30: TokenSums;
  last7: TokenSums;
}
