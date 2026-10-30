import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { freshStore } from "./testing/db";

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

type S = Awaited<ReturnType<typeof freshStore>>["store"];

const config = {
  name: "n",
  provider: "ollama",
  model: "m",
  base_url: "",
  api_key: "",
  temperature: null,
  timeout_seconds: null,
  max_parallel: 1,
  no_thinking: true,
} as const;
const document = { title: "t", content: "c", line_ending: "lf" } as const;

describe("DatabaseQueryFailed", () => {
  // A closed connection fails every request the same way a browser failure would.
  describe.each<{ method: string; call: (store: S) => Promise<unknown> }>([
    { method: "listConfigs", call: (s) => s.listConfigs() },
    { method: "getConfig", call: (s) => s.getConfig(1) },
    { method: "createConfig", call: (s) => s.createConfig(config) },
    { method: "updateConfig", call: (s) => s.updateConfig(1, config) },
    { method: "deleteConfig", call: (s) => s.deleteConfig(1) },
    { method: "listDocuments", call: (s) => s.listDocuments() },
    { method: "getDocument", call: (s) => s.getDocument(1) },
    { method: "createDocument", call: (s) => s.createDocument(document) },
    { method: "updateDocument", call: (s) => s.updateDocument(1, document) },
    { method: "renameDocument", call: (s) => s.renameDocument(1, "x") },
    { method: "deleteDocument", call: (s) => s.deleteDocument(1) },
    { method: "getSetting", call: (s) => s.getSetting("auto_check") },
    { method: "getSettings", call: (s) => s.getSettings() },
    { method: "setSetting", call: (s) => s.setSetting("auto_check", true) },
  ])("$method on a closed database", ({ method, call }) => {
    it("fails with Store.<method>->DatabaseQueryFailed and keeps the cause", async () => {
      const { store } = await freshStore();
      store.close();
      const err = await caught(call(store));
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).hasRoute(`Store.${method}->DatabaseQueryFailed`)).toBe(true);
      expect((err as AppError).cause).toBeInstanceOf(DOMException);
      expect((err as AppError).metadata).toHaveProperty("store");
    });
  });

  it("fails when a request fails inside the transaction", async () => {
    const { store } = await freshStore();
    // A function cannot be cloned into the database: the put request fails with DataCloneError.
    const err = await caught(
      store.createDocument({ ...document, content: (() => 1) as unknown as string }),
    );
    expect((err as AppError).hasRoute("Store.createDocument->DatabaseQueryFailed")).toBe(true);
    expect(await store.listDocuments()).toEqual([]);
  });
});

describe("cancelling", () => {
  it.each([
    { name: "listConfigs", call: (s: S, signal: AbortSignal) => s.listConfigs({ signal }) },
    {
      name: "createDocument",
      call: (s: S, signal: AbortSignal) => s.createDocument(document, { signal }),
    },
    { name: "getSettings", call: (s: S, signal: AbortSignal) => s.getSettings({ signal }) },
  ])("$name rejects with the signal's reason, not an AppError", async ({ call }) => {
    const { store } = await freshStore();
    const err = await caught(call(store, AbortSignal.abort("stop")));
    expect(err).toBe("stop");
  });

  it("rolls back a write that is cancelled before it commits", async () => {
    const { store } = await freshStore();
    const controller = new AbortController();
    const pending = caught(store.createDocument(document, { signal: controller.signal }));
    controller.abort("stop");
    expect(await pending).toBe("stop");
    expect(await store.listDocuments()).toEqual([]);
  });
});
