import { IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { isAbortError, isConstraintError, requestResult, transact, walk } from "./idb";
import { freshFactory } from "./testing/db";

async function openPlain(): Promise<IDBDatabase> {
  const request = freshFactory().open("t", 1);
  request.onupgradeneeded = () => {
    const things = request.result.createObjectStore("things", { keyPath: "id" });
    things.createIndex("label", "label", { unique: true });
  };
  return requestResult(request);
}

const ALL = ["a", "b", "c"].map((label, i) => ({ id: i + 1, label }));

async function seeded(): Promise<IDBDatabase> {
  const db = await openPlain();
  await transact(db, "things", "readwrite", async (tx) => {
    for (const row of ALL) await requestResult(tx.objectStore("things").add(row));
  });
  return db;
}

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("transact", () => {
  it("resolves with the result once committed", async () => {
    const db = await seeded();
    const rows = await transact(db, "things", "readonly", (tx) =>
      requestResult(tx.objectStore("things").getAll()),
    );
    expect(rows).toEqual(ALL);
  });

  it("rolls back and rejects with the error of work", async () => {
    const db = await seeded();
    const failure = new RangeError("boom");
    const err = await caught(
      transact(db, "things", "readwrite", async (tx) => {
        await requestResult(tx.objectStore("things").put({ id: 9, label: "z" }));
        throw failure;
      }),
    );
    expect(err).toBe(failure);
    const rows = await transact(db, "things", "readonly", (tx) =>
      requestResult(tx.objectStore("things").getAll()),
    );
    expect(rows).toEqual(ALL);
  });

  it("rejects with the request's error and rolls back on a unique violation", async () => {
    const db = await seeded();
    const err = await caught(
      transact(db, "things", "readwrite", async (tx) => {
        await requestResult(tx.objectStore("things").put({ id: 8, label: "new" }));
        await requestResult(tx.objectStore("things").put({ id: 9, label: "a" }));
      }),
    );
    expect(isConstraintError(err)).toBe(true);
    const count = await transact(db, "things", "readonly", (tx) =>
      requestResult(tx.objectStore("things").count()),
    );
    expect(count).toBe(3);
  });

  it("rejects with a synchronous throw of work", async () => {
    const db = await seeded();
    const err = await caught(
      transact(db, "things", "readonly", () => {
        throw new TypeError("sync");
      }),
    );
    expect(err).toBeInstanceOf(TypeError);
  });

  it("rejects with the browser's error when the transaction cannot start", async () => {
    const db = await seeded();
    const err = await caught(transact(db, "missing", "readonly", () => Promise.resolve()));
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("NotFoundError");
  });

  describe("with a signal", () => {
    it("rejects at once when it is already aborted, without a transaction", async () => {
      const db = await seeded();
      let started = false;
      const err = await caught(
        transact(
          db,
          "things",
          "readonly",
          () => {
            started = true;
            return Promise.resolve();
          },
          { signal: AbortSignal.abort() },
        ),
      );
      expect(isAbortError(err)).toBe(true);
      expect(started).toBe(false);
    });

    it.each([
      { name: "its default reason", reason: undefined },
      { name: "a custom reason", reason: "stop" },
    ])("rolls back when aborted in the middle and rejects with $name", async ({ reason }) => {
      const db = await seeded();
      const controller = new AbortController();
      const err = await caught(
        transact(
          db,
          "things",
          "readwrite",
          async (tx) => {
            await requestResult(tx.objectStore("things").put({ id: 9, label: "z" }));
            if (reason === undefined) controller.abort();
            else controller.abort(reason);
            await requestResult(tx.objectStore("things").put({ id: 10, label: "y" }));
          },
          { signal: controller.signal },
        ),
      );
      if (reason === undefined) expect(isAbortError(err)).toBe(true);
      else expect(err).toBe(reason);
      const count = await transact(db, "things", "readonly", (tx) =>
        requestResult(tx.objectStore("things").count()),
      );
      expect(count).toBe(3);
    });
  });
});

describe("walk", () => {
  it.each([
    { name: "forward", direction: "next" as const, stopAfter: Infinity, expected: [1, 2, 3] },
    { name: "backward", direction: "prev" as const, stopAfter: Infinity, expected: [3, 2, 1] },
    { name: "stopping early", direction: "next" as const, stopAfter: 2, expected: [1, 2] },
  ])("visits records $name", async ({ direction, stopAfter, expected }) => {
    const db = await seeded();
    const seen = await transact(db, "things", "readonly", async (tx) => {
      const ids: number[] = [];
      await walk(
        tx.objectStore("things"),
        (row) => {
          ids.push((row as { id: number }).id);
          return ids.length < stopAfter;
        },
        { direction },
      );
      return ids;
    });
    expect(seen).toEqual(expected);
  });

  it("walks an index with a range", async () => {
    const db = await seeded();
    const labels = await transact(db, "things", "readonly", async (tx) => {
      const found: string[] = [];
      await walk(
        tx.objectStore("things").index("label"),
        (row) => {
          found.push((row as { label: string }).label);
        },
        { range: IDBKeyRange.lowerBound("b") },
      );
      return found;
    });
    expect(labels).toEqual(["b", "c"]);
  });

  it("rejects with the error of the visitor", async () => {
    const db = await seeded();
    const err = await caught(
      transact(db, "things", "readonly", (tx) =>
        walk(tx.objectStore("things"), () => {
          throw new RangeError("visit");
        }),
      ),
    );
    expect(err).toBeInstanceOf(RangeError);
  });
});
