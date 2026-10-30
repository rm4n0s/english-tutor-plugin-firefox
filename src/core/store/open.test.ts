import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { requestResult } from "./idb";
import { MIGRATIONS, STORES, type Migration } from "./migrations";
import { openDatabase } from "./open";
import { freshFactory } from "./testing/db";

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

interface IndexShape {
  keyPath: string | string[];
  unique: boolean;
}

const SCHEMA: Record<
  string,
  { keyPath: string; autoIncrement: boolean; indexes: Record<string, IndexShape> }
> = {
  llm_configs: {
    keyPath: "id",
    autoIncrement: true,
    indexes: { name: { keyPath: "name", unique: true } },
  },
  documents: {
    keyPath: "id",
    autoIncrement: true,
    indexes: { updated_at: { keyPath: "updated_at", unique: false } },
  },
  error_events: {
    keyPath: "id",
    autoIncrement: true,
    indexes: {
      source_key_fingerprint: { keyPath: ["source_key", "fingerprint"], unique: true },
      error_type_created_at: { keyPath: ["error_type", "created_at"], unique: false },
      created_at: { keyPath: "created_at", unique: false },
      source_key: { keyPath: "source_key", unique: false },
    },
  },
  llm_usage: {
    keyPath: "id",
    autoIncrement: true,
    indexes: { created_at: { keyPath: "created_at", unique: false } },
  },
  settings: { keyPath: "key", autoIncrement: false, indexes: {} },
};

describe("openDatabase from an empty database (migration 1)", () => {
  it("opens at the version of the last migration and creates exactly the five stores", async () => {
    const db = await openDatabase(freshFactory());
    expect(db.name).toBe("english-tutor");
    expect(db.version).toBe(MIGRATIONS.length);
    expect([...db.objectStoreNames].sort()).toEqual(Object.keys(SCHEMA).sort());
    expect(Object.values(STORES).sort()).toEqual(Object.keys(SCHEMA).sort());
    db.close();
  });

  describe.each(Object.entries(SCHEMA))("object store %s", (name, expected) => {
    it("has the key and the indexes of SPEC section 9, and no others", async () => {
      const db = await openDatabase(freshFactory());
      const store = db.transaction(name, "readonly").objectStore(name);
      expect(store.keyPath).toBe(expected.keyPath);
      expect(store.autoIncrement).toBe(expected.autoIncrement);
      expect([...store.indexNames].sort()).toEqual(Object.keys(expected.indexes).sort());
      for (const [indexName, shape] of Object.entries(expected.indexes)) {
        const index = store.index(indexName);
        expect(index.keyPath).toEqual(shape.keyPath);
        expect(index.unique).toBe(shape.unique);
        expect(index.multiEntry).toBe(false);
      }
      db.close();
    });
  });

  it("enforces the compound unique index of error_events", async () => {
    const db = await openDatabase(freshFactory());
    const tx = db.transaction("error_events", "readwrite");
    const events = tx.objectStore("error_events");
    const event = { error_type: "x", source_key: "s", fingerprint: "f", created_at: 1 };
    await requestResult(events.add(event));
    await requestResult(events.add({ ...event, source_key: "other" }));
    const err = await caught(requestResult(events.add({ ...event, created_at: 2 })));
    expect((err as DOMException).name).toBe("ConstraintError");
    db.close();
  });
});

describe("migrations run in order", () => {
  function recorder(calls: number[]): Migration[] {
    return [1, 2, 3].map((n) => (db) => {
      calls.push(n);
      db.createObjectStore(`s${String(n)}`);
    });
  }

  it.each([
    { name: "all of them on an empty database", existing: 0, expected: [1, 2, 3] },
    { name: "only the new ones on an older database", existing: 1, expected: [2, 3] },
    { name: "none on a current database", existing: 3, expected: [] },
  ])("runs $name", async ({ existing, expected }) => {
    const factory = freshFactory();
    if (existing > 0) {
      const first = await openDatabase(factory, { migrations: recorder([]).slice(0, existing) });
      first.close();
    }
    const calls: number[] = [];
    const db = await openDatabase(factory, { migrations: recorder(calls) });
    expect(calls).toEqual(expected);
    expect(db.version).toBe(3);
    expect([...db.objectStoreNames].sort()).toEqual(["s1", "s2", "s3"]);
    db.close();
  });

  it("keeps the data of an older version", async () => {
    const factory = freshFactory();
    const first = await openDatabase(factory);
    const tx = first.transaction("settings", "readwrite");
    await requestResult(tx.objectStore("settings").put({ key: "auto_check", value: true }));
    first.close();
    const next: Migration = (db) => {
      db.createObjectStore("extra");
    };
    const db = await openDatabase(factory, { migrations: [...MIGRATIONS, next] });
    const row: unknown = await requestResult(
      db.transaction("settings").objectStore("settings").get("auto_check"),
    );
    expect(row).toEqual({ key: "auto_check", value: true });
    db.close();
  });
});

describe("openDatabase failures", () => {
  it("fails with DatabaseOpenFailed when a newer version is stored", async () => {
    const factory = freshFactory();
    const newer = await openDatabase(factory, { migrations: [...MIGRATIONS, () => undefined] });
    newer.close();
    const err = await caught(openDatabase(factory));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("openDatabase->DatabaseOpenFailed")).toBe(true);
    expect((err as AppError).cause).toBeInstanceOf(DOMException);
  });

  it("fails with DatabaseOpenFailed when IndexedDB refuses to open", async () => {
    const factory = freshFactory();
    factory.open = () => {
      throw new DOMException("denied", "SecurityError");
    };
    const err = await caught(openDatabase(factory));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("openDatabase->DatabaseOpenFailed")).toBe(true);
  });

  it("fails with MigrationFailed when a migration throws, and keeps the earlier version intact", async () => {
    const factory = freshFactory();
    const ok: Migration = (db) => {
      db.createObjectStore("s1");
    };
    const bad: Migration = () => {
      throw new RangeError("broken migration");
    };
    const first = await openDatabase(factory, { migrations: [ok] });
    first.close();
    const err = await caught(openDatabase(factory, { migrations: [ok, bad] }));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("openDatabase->MigrationFailed")).toBe(true);
    expect(((err as AppError).cause as Error).message).toBe("broken migration");
    // The upgrade was rolled back: still version 1.
    const again = await openDatabase(factory, { migrations: [ok] });
    expect(again.version).toBe(1);
    again.close();
  });

  it("fails with MigrationFailed when a fresh database's first migration throws", async () => {
    const err = await caught(
      openDatabase(freshFactory(), {
        migrations: [
          () => {
            throw new RangeError("broken");
          },
        ],
      }),
    );
    expect((err as AppError).hasRoute("openDatabase->MigrationFailed")).toBe(true);
  });

  it("fails with MigrationFailed when the upgrade is blocked, and does not leak the late connection", async () => {
    const factory = freshFactory();
    const stuck = await openDatabase(factory, { migrations: [MIGRATIONS[0]!] });
    // Keep the old connection open: do not react to versionchange.
    stuck.onversionchange = null;
    const err = await caught(
      openDatabase(factory, { migrations: [...MIGRATIONS, () => undefined] }),
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("openDatabase->MigrationFailed")).toBe(true);

    // Once the blocker closes, the upgrade goes through and the unused connection must close.
    stuck.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    let blocked = false;
    const deletion = factory.deleteDatabase("english-tutor");
    deletion.onblocked = () => {
      blocked = true;
    };
    await requestResult(deletion);
    expect(blocked).toBe(false);
  });

  it("rejects with the signal's reason when already cancelled", async () => {
    const err = await caught(openDatabase(freshFactory(), { signal: AbortSignal.abort("stop") }));
    expect(err).toBe("stop");
  });

  it("rejects with the signal's reason when cancelled while opening, and closes the connection", async () => {
    const factory = freshFactory();
    const controller = new AbortController();
    const opening = caught(openDatabase(factory, { signal: controller.signal }));
    controller.abort("stop");
    expect(await opening).toBe("stop");
    await new Promise((resolve) => setTimeout(resolve, 10));
    let blocked = false;
    const deletion = factory.deleteDatabase("english-tutor");
    deletion.onblocked = () => {
      blocked = true;
    };
    await requestResult(deletion);
    expect(blocked).toBe(false);
  });
});

describe("versionchange", () => {
  it("closes the connection so that another tab can upgrade", async () => {
    const factory = freshFactory();
    const old = await openDatabase(factory, { migrations: [MIGRATIONS[0]!] });
    const upgraded = await openDatabase(factory, { migrations: [...MIGRATIONS, () => undefined] });
    expect(upgraded.version).toBe(2);
    expect(() => old.transaction("settings")).toThrow(DOMException);
    upgraded.close();
  });
});
