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
  /** null leaves the provider's default. */
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
