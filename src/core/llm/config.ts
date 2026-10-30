import { AppError } from "../errors";
import type { LLMConfigInput } from "../store/types";
import { parseHttpUrl } from "./endpoint";
import { parseProvider } from "./provider";

/** The fields of a configuration that a problem can be about. */
export type ConfigField =
  "name" | "model" | "base_url" | "api_key" | "temperature" | "timeout_seconds" | "max_parallel";

export interface ConfigProblem {
  field: ConfigField;
  /** Meant to be shown to the user, next to the field. */
  message: string;
}

/**
 * Every rule of SPEC sections 4.7 and 10 that `input` breaks, in field order. Numbers may be
 * `NaN` (the form's way to say "typed text that is not a number"), which breaks the rule of the
 * field. The provider is not checked here (see `validateConfig`).
 */
export function configProblems(input: LLMConfigInput): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const add = (field: ConfigField, message: string) => problems.push({ field, message });

  if (input.name.trim() === "") add("name", "Name is required.");
  if (input.model.trim() === "") add("model", "Model is required.");

  const baseUrl = input.base_url.trim();
  if (baseUrl === "") {
    if (input.provider === "ollama" || input.provider === "openai-compatible") {
      add("base_url", "Base URL is required for this provider.");
    }
  } else if (parseHttpUrl(baseUrl) === undefined) {
    add("base_url", "Base URL must be an address such as http://localhost:11434.");
  }

  if (input.provider === "anthropic" && input.api_key.trim() === "") {
    add("api_key", "API key is required for Anthropic.");
  }

  const { temperature, timeout_seconds: timeout, max_parallel: parallel } = input;
  if (temperature !== null && !(temperature >= 0 && temperature <= 2)) {
    add("temperature", "Temperature must be a number between 0 and 2.");
  }
  if (timeout !== null && timeout !== 0 && !(timeout >= 10 && timeout <= 3600)) {
    add(
      "timeout_seconds",
      "Timeout must be between 10 and 3600 seconds, or empty for the default.",
    );
  }
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) {
    add("max_parallel", "Parallel requests must be a whole number from 1 to 16.");
  }
  return problems;
}

/**
 * The `ConfigValidator` the store receives. Throws `UnknownProvider` for a provider that is not
 * supported, otherwise `LLMConfigInvalid` for the first problem, with the field in the metadata.
 */
export function validateConfig(input: LLMConfigInput): void {
  try {
    parseProvider(input.provider);
  } catch (err) {
    throw err instanceof AppError ? err.via("validateConfig") : err;
  }
  const [problem] = configProblems(input);
  if (problem !== undefined) {
    throw new AppError("LLMConfigInvalid", problem.message, { field: problem.field }).via(
      "validateConfig",
    );
  }
}
