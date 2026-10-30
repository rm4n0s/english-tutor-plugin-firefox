import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { freshStore } from "./testing/db";
import type { DocumentInput } from "./types";

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

function doc(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return { title: "Essay", content: "He go to school.", line_ending: "lf", ...overrides };
}

describe("Store documents", () => {
  it("creates a document with an id and both times from the clock", async () => {
    const { store } = await freshStore({}, 7_000);
    const created = await store.createDocument(doc({ line_ending: "crlf" }));
    expect(created).toEqual({
      ...doc({ line_ending: "crlf" }),
      id: 1,
      created_at: 7_000,
      updated_at: 7_000,
    });
    expect(await store.getDocument(created.id)).toEqual(created);
  });

  it("keeps the text exactly, including line endings and non-ASCII", async () => {
    const { store } = await freshStore();
    const content = "a\r\nb\n\n  é 😀 \t";
    const created = await store.createDocument(doc({ content }));
    expect((await store.getDocument(created.id)).content).toBe(content);
  });

  it("stores only the fields of the input", async () => {
    const { store } = await freshStore();
    const created = await store.createDocument({
      ...doc(),
      id: 50,
      updated_at: 3,
    } as DocumentInput);
    expect(created.id).not.toBe(50);
    expect(created.updated_at).toBe(1_000);
  });

  it.each([
    { name: "no documents", steps: [], expected: [] },
    {
      name: "the most recently updated first",
      steps: [
        { create: "old", at: 100 },
        { create: "new", at: 300 },
        { create: "mid", at: 200 },
      ],
      expected: ["new", "mid", "old"],
    },
    {
      name: "the later one first when the update time is the same",
      steps: [
        { create: "first", at: 100 },
        { create: "second", at: 100 },
      ],
      expected: ["second", "first"],
    },
  ])("lists $name", async ({ steps, expected }) => {
    const { store, clock } = await freshStore();
    for (const step of steps) {
      clock.set(step.at);
      await store.createDocument(doc({ title: step.create }));
    }
    expect((await store.listDocuments()).map((d) => d.title)).toEqual(expected);
  });

  it("moves an updated document to the top of the list", async () => {
    const { store, clock } = await freshStore({}, 100);
    const a = await store.createDocument(doc({ title: "A" }));
    clock.set(200);
    await store.createDocument(doc({ title: "B" }));
    clock.set(300);
    await store.updateDocument(a.id, doc({ title: "A" }));
    expect((await store.listDocuments()).map((d) => d.title)).toEqual(["A", "B"]);
  });

  it("updates title, content and line ending, keeps created_at, and sets updated_at", async () => {
    const { store, clock } = await freshStore({}, 100);
    const created = await store.createDocument(doc());
    clock.set(900);
    const updated = await store.updateDocument(
      created.id,
      doc({ title: "T2", content: "new", line_ending: "crlf" }),
    );
    expect(updated).toEqual({
      id: created.id,
      title: "T2",
      content: "new",
      line_ending: "crlf",
      created_at: 100,
      updated_at: 900,
    });
    expect(await store.getDocument(created.id)).toEqual(updated);
  });

  it("renames a document without touching its text, and sets updated_at", async () => {
    const { store, clock } = await freshStore({}, 100);
    const created = await store.createDocument(doc({ content: "keep", line_ending: "crlf" }));
    clock.set(400);
    const renamed = await store.renameDocument(created.id, "New title");
    expect(renamed).toEqual({ ...created, title: "New title", updated_at: 400 });
    expect(await store.getDocument(created.id)).toEqual(renamed);
  });

  it("deletes a document and only that one", async () => {
    const { store, clock } = await freshStore({}, 100);
    const a = await store.createDocument(doc({ title: "A" }));
    clock.set(200);
    const b = await store.createDocument(doc({ title: "B" }));
    await store.deleteDocument(a.id);
    expect(await store.listDocuments()).toEqual([b]);
  });

  it("allows two documents with the same title", async () => {
    const { store } = await freshStore();
    await store.createDocument(doc());
    await store.createDocument(doc());
    expect(await store.listDocuments()).toHaveLength(2);
  });

  describe("a missing id (DocumentNotFound)", () => {
    type S = Awaited<ReturnType<typeof freshStore>>["store"];
    it.each([
      { method: "getDocument", call: (s: S) => s.getDocument(9) },
      { method: "updateDocument", call: (s: S) => s.updateDocument(9, doc()) },
      { method: "renameDocument", call: (s: S) => s.renameDocument(9, "x") },
      { method: "deleteDocument", call: (s: S) => s.deleteDocument(9) },
    ])("fails in $method", async ({ method, call }) => {
      const { store } = await freshStore();
      const err = await caught(call(store));
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).hasRoute(`Store.${method}->DocumentNotFound`)).toBe(true);
      expect((err as AppError).metadata).toEqual({ id: 9 });
    });

    it("does not create a document on update, and fails after a delete", async () => {
      const { store } = await freshStore();
      const created = await store.createDocument(doc());
      await store.deleteDocument(created.id);
      const err = await caught(store.updateDocument(created.id, doc()));
      expect((err as AppError).hasRoute("Store.updateDocument->DocumentNotFound")).toBe(true);
      expect(await store.listDocuments()).toEqual([]);
    });
  });
});
