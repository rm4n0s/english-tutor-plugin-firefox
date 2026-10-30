import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import type { LLMConfigInput } from "../store/types";
import { configProblems, validateConfig } from "./config";

function config(overrides: Partial<LLMConfigInput> = {}): LLMConfigInput {
  return {
    name: "Local",
    provider: "openai-compatible",
    model: "gpt-4o",
    base_url: "http://localhost:8080/v1",
    api_key: "",
    temperature: null,
    timeout_seconds: null,
    max_parallel: 1,
    no_thinking: true,
    ...overrides,
  };
}

describe("configProblems", () => {
  it.each([
    { name: "a complete OpenAI-compatible LLM", input: config(), expected: [] },
    {
      name: "Ollama without a key",
      input: config({ provider: "ollama", base_url: "http://localhost:11434" }),
      expected: [],
    },
    {
      name: "Anthropic with a key and no base URL",
      input: config({ provider: "anthropic", base_url: "", api_key: "sk-ant-1" }),
      expected: [],
    },
    { name: "a missing name", input: config({ name: "  " }), expected: ["name"] },
    { name: "a missing model", input: config({ model: "" }), expected: ["model"] },
    {
      name: "a missing base URL for openai-compatible",
      input: config({ base_url: "" }),
      expected: ["base_url"],
    },
    {
      name: "a missing base URL for ollama",
      input: config({ provider: "ollama", base_url: " " }),
      expected: ["base_url"],
    },
    {
      name: "a base URL without a scheme",
      input: config({ base_url: "localhost:11434" }),
      expected: ["base_url"],
    },
    {
      name: "a base URL with another scheme",
      input: config({ base_url: "ftp://example.com" }),
      expected: ["base_url"],
    },
    {
      name: "a base URL without a host",
      input: config({ base_url: "http://" }),
      expected: ["base_url"],
    },
    {
      name: "a malformed base URL on Anthropic",
      input: config({ provider: "anthropic", base_url: "not a url", api_key: "k" }),
      expected: ["base_url"],
    },
    {
      name: "Anthropic without a key",
      input: config({ provider: "anthropic", base_url: "", api_key: " " }),
      expected: ["api_key"],
    },
    { name: "temperature 0", input: config({ temperature: 0 }), expected: [] },
    { name: "temperature 2", input: config({ temperature: 2 }), expected: [] },
    { name: "temperature 2.1", input: config({ temperature: 2.1 }), expected: ["temperature"] },
    { name: "temperature -0.1", input: config({ temperature: -0.1 }), expected: ["temperature"] },
    {
      name: "temperature NaN",
      input: config({ temperature: Number.NaN }),
      expected: ["temperature"],
    },
    { name: "timeout 0 (default)", input: config({ timeout_seconds: 0 }), expected: [] },
    { name: "timeout 10", input: config({ timeout_seconds: 10 }), expected: [] },
    { name: "timeout 3600", input: config({ timeout_seconds: 3600 }), expected: [] },
    { name: "timeout 9", input: config({ timeout_seconds: 9 }), expected: ["timeout_seconds"] },
    {
      name: "timeout 3601",
      input: config({ timeout_seconds: 3601 }),
      expected: ["timeout_seconds"],
    },
    { name: "parallel 16", input: config({ max_parallel: 16 }), expected: [] },
    { name: "parallel 0", input: config({ max_parallel: 0 }), expected: ["max_parallel"] },
    { name: "parallel 17", input: config({ max_parallel: 17 }), expected: ["max_parallel"] },
    { name: "parallel 1.5", input: config({ max_parallel: 1.5 }), expected: ["max_parallel"] },
    {
      name: "several problems, in field order",
      input: config({ name: "", model: "", temperature: 5, max_parallel: 0 }),
      expected: ["name", "model", "temperature", "max_parallel"],
    },
  ])("$name", ({ input, expected }) => {
    expect(configProblems(input).map((problem) => problem.field)).toEqual(expected);
  });

  it("gives every problem a message for the user", () => {
    for (const problem of configProblems(config({ name: "", model: "", base_url: "" }))) {
      expect(problem.message).toMatch(/\.$/);
    }
  });
});

describe("validateConfig", () => {
  it("accepts a valid configuration", () => {
    expect(() => {
      validateConfig(config());
    }).not.toThrow();
  });

  it.each([
    { name: "no model", input: config({ model: "" }), field: "model" },
    {
      name: "no key for Anthropic",
      input: config({ provider: "anthropic", base_url: "" }),
      field: "api_key",
    },
    { name: "a bad timeout", input: config({ timeout_seconds: 5 }), field: "timeout_seconds" },
  ])("throws LLMConfigInvalid for $name", ({ input, field }) => {
    const err = captured(() => {
      validateConfig(input);
    });
    expect(err).toBeInstanceOf(AppError);
    expect(err.hasRoute("validateConfig->LLMConfigInvalid")).toBe(true);
    expect(err.metadata).toEqual({ field });
  });

  it("throws UnknownProvider before anything else", () => {
    const err = captured(() => {
      validateConfig(config({ provider: "gemini" as never, model: "" }));
    });
    expect(err.hasRoute("validateConfig->parseProvider->UnknownProvider")).toBe(true);
    expect(err.metadata).toEqual({ provider: "gemini" });
  });
});

function captured(run: () => void): AppError {
  try {
    run();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an error");
}
