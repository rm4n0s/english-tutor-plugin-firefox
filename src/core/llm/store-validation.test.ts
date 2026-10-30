import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { freshStore } from "../store/testing/db";
import type { LLMConfigInput } from "../store/types";
import { validateConfig } from "./config";

function input(overrides: Partial<LLMConfigInput> = {}): LLMConfigInput {
  return {
    name: "Local",
    provider: "ollama",
    model: "llama3.1",
    base_url: "http://localhost:11434",
    api_key: "",
    temperature: null,
    timeout_seconds: null,
    max_parallel: 1,
    no_thinking: true,
    ...overrides,
  };
}

// The store receives `validateConfig` as its validator (SPEC section 9).
describe("Store with validateConfig", () => {
  it("stores a valid configuration", async () => {
    const { store } = await freshStore({ validateConfig });
    await expect(store.createConfig(input())).resolves.toMatchObject({ name: "Local" });
  });

  it.each([
    {
      name: "create",
      run: (s: Awaited<ReturnType<typeof freshStore>>["store"]) =>
        s.createConfig(input({ model: "" })),
    },
    {
      name: "update",
      run: async (s: Awaited<ReturnType<typeof freshStore>>["store"]) => {
        const saved = await s.createConfig(input());
        return s.updateConfig(saved.id, input({ timeout_seconds: 1 }));
      },
    },
  ])("$name refuses an invalid one with LLMConfigInvalid and stores nothing", async ({ run }) => {
    const { store } = await freshStore({ validateConfig });
    const err = await run(store).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("validateConfig->LLMConfigInvalid")).toBe(true);
    expect((await store.listConfigs()).every((c) => c.timeout_seconds === null)).toBe(true);
  });

  it("refuses an unknown provider with UnknownProvider", async () => {
    const { store } = await freshStore({ validateConfig });
    const err = await store
      .createConfig(input({ provider: "gemini" as never }))
      .catch((e: unknown) => e);
    expect((err as AppError).hasRoute("validateConfig->parseProvider->UnknownProvider")).toBe(true);
    expect(await store.listConfigs()).toEqual([]);
  });
});
