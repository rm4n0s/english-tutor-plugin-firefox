import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import {
  isProvider,
  parseProvider,
  PROVIDERS,
  supportsApiKey,
  supportsNoThinking,
} from "./provider";

describe("parseProvider", () => {
  it.each(PROVIDERS)("accepts %s", (provider) => {
    expect(parseProvider(provider)).toBe(provider);
    expect(isProvider(provider)).toBe(true);
  });

  it.each(["", "openai", "Ollama", "gemini", "x".repeat(200)])(
    "refuses %j with UnknownProvider",
    (value) => {
      let err: unknown;
      try {
        parseProvider(value);
      } catch (caught) {
        err = caught;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).hasRoute("parseProvider->UnknownProvider")).toBe(true);
      expect(String((err as AppError).metadata.provider).length).toBeLessThanOrEqual(50);
    },
  );
});

describe("provider capabilities", () => {
  it.each([
    { provider: "ollama", thinking: true, key: false },
    { provider: "openai-compatible", thinking: true, key: true },
    { provider: "anthropic", thinking: false, key: true },
  ] as const)("$provider", ({ provider, thinking, key }) => {
    expect(supportsNoThinking(provider)).toBe(thinking);
    expect(supportsApiKey(provider)).toBe(key);
  });
});
