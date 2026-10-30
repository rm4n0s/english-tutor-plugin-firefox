import { createClient, type ClientConfig, type ClientDeps, type LLMClient } from "../llm";

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

/** The fields of a stored LLM configuration that make a model (`LLMConfig` fits). */
export interface ModelConfig extends ClientConfig {
  name: string;
  timeout_seconds: number | null;
  max_parallel: number;
}

/**
 * The model of a stored configuration. Throws `UnknownProvider`, or `LLMConfigInvalid` when the
 * base URL is not an `http(s)` address (see `createClient`).
 */
export function modelFromConfig(config: ModelConfig, deps: ClientDeps): AnalysisModel {
  return {
    client: createClient(config, deps, { name: config.name }),
    name: config.name,
    timeoutSeconds: config.timeout_seconds,
    parallel: config.max_parallel,
  };
}
