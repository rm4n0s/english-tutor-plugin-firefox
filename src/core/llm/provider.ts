import { AppError } from "../errors";
import type { Provider } from "../store/types";

export type { Provider };

/** Every supported provider, in the order shown to the user (SPEC section 4.7). */
export const PROVIDERS: readonly Provider[] = ["ollama", "openai-compatible", "anthropic"];

/** The provider a new LLM starts with. */
export const DEFAULT_PROVIDER: Provider = "openai-compatible";

export const PROVIDER_LABELS: Readonly<Record<Provider, string>> = {
  ollama: "Ollama",
  "openai-compatible": "OpenAI-compatible",
  anthropic: "Anthropic",
};

/** Filled into the Base URL field when Ollama is chosen (SPEC section 4.7). */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** Used when an Anthropic LLM has no Base URL (SPEC section 6.1). */
export const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

/** The temperature of an LLM that has none set (SPEC section 4.7). */
export const DEFAULT_TEMPERATURE = 0.2;

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** The provider named by a stored string. Throws `UnknownProvider`. */
export function parseProvider(value: string): Provider {
  if (isProvider(value)) return value;
  throw new AppError(
    "UnknownProvider",
    "Provider must be ollama, openai-compatible or anthropic.",
    {
      provider: value.slice(0, 50),
    },
  ).via("parseProvider");
}

/** True when the "No thinking" option does something for the provider (SPEC section 6.4). */
export function supportsNoThinking(provider: Provider): boolean {
  return provider !== "anthropic";
}

/** True when the provider takes an API key (Ollama's is disabled and not stored). */
export function supportsApiKey(provider: Provider): boolean {
  return provider !== "ollama";
}
