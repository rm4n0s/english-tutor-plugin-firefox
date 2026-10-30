import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { modelFromConfig, type ModelConfig } from "./model";

const deps = {
  fetch: (() => Promise.reject(new Error("unused"))) as typeof fetch,
  permissions: { contains: () => Promise.resolve(true) },
};

const config: ModelConfig = {
  name: "Local",
  provider: "openai-compatible",
  model: "gpt-4o",
  base_url: "http://localhost:8080/v1",
  api_key: "",
  temperature: null,
  timeout_seconds: 90,
  max_parallel: 3,
  no_thinking: true,
};

describe("modelFromConfig", () => {
  it("takes the name, timeout and parallel requests of the configuration", () => {
    const model = modelFromConfig(config, deps);
    expect(model).toMatchObject({ name: "Local", timeoutSeconds: 90, parallel: 3 });
    expect(model.client.provider).toBe("openai-compatible");
  });

  it.each([
    { name: "an unknown provider", change: { provider: "x" }, tag: "UnknownProvider" },
    {
      name: "a base URL that is no address",
      change: { base_url: "nope" },
      tag: "LLMConfigInvalid",
    },
  ])("throws for $name", ({ change, tag }) => {
    let thrown: unknown;
    try {
      modelFromConfig({ ...config, ...change }, deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).tag).toBe(tag);
  });
});
