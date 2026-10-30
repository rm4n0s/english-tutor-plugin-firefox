import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { freshStore } from "./testing/db";
import type { LLMConfigInput } from "./types";

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

function config(overrides: Partial<LLMConfigInput> = {}): LLMConfigInput {
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

describe("Store LLM configurations", () => {
  it("creates a configuration with an id and both times from the clock", async () => {
    const { store } = await freshStore({}, 5_000);
    const created = await store.createConfig(config({ temperature: 0.2, timeout_seconds: 60 }));
    expect(created).toEqual({
      ...config({ temperature: 0.2, timeout_seconds: 60 }),
      id: 1,
      created_at: 5_000,
      updated_at: 5_000,
    });
    expect(await store.getConfig(created.id)).toEqual(created);
  });

  it("gives each configuration a new id", async () => {
    const { store } = await freshStore();
    const a = await store.createConfig(config({ name: "A" }));
    const b = await store.createConfig(config({ name: "B" }));
    expect(b.id).not.toBe(a.id);
  });

  it("stores only the fields of the input", async () => {
    const { store } = await freshStore();
    const dirty = { ...config(), id: 99, created_at: 1, updated_at: 2, extra: "x" };
    const created = await store.createConfig(dirty);
    expect(created.id).not.toBe(99);
    expect(created.created_at).toBe(1_000);
    expect(Object.keys(await store.getConfig(created.id)).sort()).toEqual(
      [...Object.keys(config()), "id", "created_at", "updated_at"].sort(),
    );
  });

  it.each([
    { name: "no configurations", names: [], expected: [] },
    { name: "names in order", names: ["b", "c", "a"], expected: ["a", "b", "c"] },
    { name: "capitals before lower case", names: ["b", "B", "a"], expected: ["B", "a", "b"] },
  ])("lists $name", async ({ names, expected }) => {
    const { store } = await freshStore();
    for (const name of names) await store.createConfig(config({ name }));
    expect((await store.listConfigs()).map((c) => c.name)).toEqual(expected);
  });

  it("updates the fields, keeps created_at and id, and sets updated_at", async () => {
    const { store, clock } = await freshStore({}, 1_000);
    const created = await store.createConfig(config({ api_key: "secret" }));
    clock.advance(500);
    const updated = await store.updateConfig(
      created.id,
      config({ name: "Renamed", model: "other", api_key: "", max_parallel: 4 }),
    );
    expect(updated).toEqual({
      ...config({ name: "Renamed", model: "other", api_key: "", max_parallel: 4 }),
      id: created.id,
      created_at: 1_000,
      updated_at: 1_500,
    });
    expect(await store.getConfig(created.id)).toEqual(updated);
    expect(await store.listConfigs()).toEqual([updated]);
  });

  it("allows an update that keeps the configuration's own name", async () => {
    const { store } = await freshStore();
    const created = await store.createConfig(config());
    const updated = await store.updateConfig(created.id, config({ model: "m2" }));
    expect(updated.model).toBe("m2");
  });

  it("deletes a configuration and only that one", async () => {
    const { store } = await freshStore();
    const a = await store.createConfig(config({ name: "A" }));
    const b = await store.createConfig(config({ name: "B" }));
    await store.deleteConfig(a.id);
    expect(await store.listConfigs()).toEqual([b]);
  });

  it("frees the name of a deleted configuration", async () => {
    const { store } = await freshStore();
    const a = await store.createConfig(config());
    await store.deleteConfig(a.id);
    await expect(store.createConfig(config())).resolves.toMatchObject({ name: "Local" });
  });

  describe("name is unique (LLMConfigNameTaken)", () => {
    it.each([
      {
        name: "creating a second configuration with the name",
        act: async (s: Awaited<ReturnType<typeof freshStore>>["store"]) => {
          await s.createConfig(config());
          return s.createConfig(config({ model: "other" }));
        },
        check: (e: AppError) => e.hasRoute("Store.createConfig->LLMConfigNameTaken"),
      },
      {
        name: "renaming a configuration to a name in use",
        act: async (s: Awaited<ReturnType<typeof freshStore>>["store"]) => {
          await s.createConfig(config({ name: "A" }));
          const b = await s.createConfig(config({ name: "B" }));
          return s.updateConfig(b.id, config({ name: "A" }));
        },
        check: (e: AppError) => e.hasRoute("Store.updateConfig->LLMConfigNameTaken"),
      },
    ])("fails when $name", async ({ act, check }) => {
      const { store } = await freshStore();
      const err = await caught(act(store));
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).tag).toBe("LLMConfigNameTaken");
      expect(check(err as AppError)).toBe(true);
      expect((err as AppError).cause).toBeInstanceOf(DOMException);
    });

    it("leaves the stored data as it was", async () => {
      const { store } = await freshStore();
      const a = await store.createConfig(config({ name: "A" }));
      const b = await store.createConfig(config({ name: "B" }));
      await caught(store.updateConfig(b.id, config({ name: "A", model: "changed" })));
      await caught(store.createConfig(config({ name: "A" })));
      expect(await store.listConfigs()).toEqual([a, b]);
    });

    it("does not put the name in the error", async () => {
      const { store } = await freshStore();
      await store.createConfig(config({ name: "private-name", api_key: "private-key" }));
      const err = (await caught(
        store.createConfig(config({ name: "private-name", api_key: "private-key" })),
      )) as AppError;
      expect(JSON.stringify([err.message, err.metadata])).not.toMatch(/private/);
    });
  });

  describe("a missing id (LLMConfigNotFound)", () => {
    it.each([
      {
        method: "getConfig",
        call: (s: Awaited<ReturnType<typeof freshStore>>["store"]) => s.getConfig(42),
      },
      {
        method: "updateConfig",
        call: (s: Awaited<ReturnType<typeof freshStore>>["store"]) => s.updateConfig(42, config()),
      },
      {
        method: "deleteConfig",
        call: (s: Awaited<ReturnType<typeof freshStore>>["store"]) => s.deleteConfig(42),
      },
    ])("fails in $method", async ({ method, call }) => {
      const { store } = await freshStore();
      const err = await caught(call(store));
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).hasRoute(`Store.${method}->LLMConfigNotFound`)).toBe(true);
      expect((err as AppError).metadata).toEqual({ id: 42 });
    });

    it("does not create a configuration on update", async () => {
      const { store } = await freshStore();
      await caught(store.updateConfig(1, config()));
      expect(await store.listConfigs()).toEqual([]);
    });
  });

  describe("the validation seam", () => {
    it("calls the validator with the input before storing", async () => {
      const seen: LLMConfigInput[] = [];
      const { store } = await freshStore({ validateConfig: (input) => void seen.push(input) });
      const created = await store.createConfig(config());
      await store.updateConfig(created.id, config({ model: "m2" }));
      expect(seen.map((c) => c.model)).toEqual(["llama3.1", "m2"]);
    });

    it.each([
      { method: "createConfig", route: "Store.createConfig->LLMConfigInvalid" },
      { method: "updateConfig", route: "Store.updateConfig->LLMConfigInvalid" },
    ])(
      "keeps the tag of the validator's error and stores nothing in $method",
      async ({ method, route }) => {
        const { store } = await freshStore({
          validateConfig: (input) => {
            if (input.model === "bad") throw new AppError("LLMConfigInvalid", "bad model", {});
          },
        });
        const good = await store.createConfig(config());
        const bad = config({ name: "Other", model: "bad" });
        const err = await caught(
          method === "createConfig" ? store.createConfig(bad) : store.updateConfig(good.id, bad),
        );
        expect((err as AppError).hasRoute(route)).toBe(true);
        expect(await store.listConfigs()).toEqual([good]);
      },
    );
  });
});
