/* eslint-disable @typescript-eslint/prefer-promise-reject-errors --
   a cancelled AbortSignal may carry any reason; it is passed on unchanged. */
import { AppError } from "../errors";
import { DATABASE_NAME, MIGRATIONS, type Migration } from "./migrations";
import type { AbortOptions } from "./idb";

export interface OpenOptions extends AbortOptions {
  name?: string;
  /** The migrations to run; tests pass their own. The default is the real schema. */
  migrations?: readonly Migration[];
}

/**
 * Opens the database, creating it or upgrading it with the migrations it has not seen yet, in
 * order. The connection closes itself when another connection asks for a newer version
 * (`versionchange`), so an upgrade in another tab is never blocked by this one.
 *
 * Failures: `DatabaseOpenFailed` (the database cannot be opened, for example a newer version is
 * stored), `MigrationFailed` (a migration threw, or the upgrade is blocked by a connection that
 * does not close). A cancelled `signal` rejects with its reason, which is not an `AppError`.
 */
export function openDatabase(factory: IDBFactory, options: OpenOptions = {}): Promise<IDBDatabase> {
  const { name = DATABASE_NAME, migrations = MIGRATIONS, signal } = options;
  const version = migrations.length;

  return new Promise<IDBDatabase>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, version);
    } catch (err) {
      reject(AppError.wrap("DatabaseOpenFailed", err, { version }).via("openDatabase"));
      return;
    }

    let settled = false;
    let upgrading = false;
    let migrationError: unknown;
    let migrationFailed = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      finish();
    };
    const onAbort = () => {
      settle(() => {
        reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    request.onupgradeneeded = (event) => {
      upgrading = true;
      const tx = request.transaction;
      if (tx === null) return;
      try {
        for (let n = event.oldVersion + 1; n <= version; n++) {
          const migration = migrations[n - 1];
          if (migration === undefined) throw new RangeError(`no migration ${String(n)}`);
          migration(request.result, tx);
        }
      } catch (err) {
        migrationFailed = true;
        migrationError = err;
        try {
          tx.abort();
        } catch {
          // Already aborted.
        }
      }
    };
    request.onblocked = () => {
      settle(() => {
        reject(
          new AppError("MigrationFailed", "the upgrade is blocked by another open connection", {
            version,
          }).via("openDatabase"),
        );
      });
    };
    request.onerror = () => {
      const cause = migrationFailed ? migrationError : request.error;
      settle(() => {
        if (migrationFailed || upgrading) {
          reject(AppError.wrap("MigrationFailed", cause, { version }).via("openDatabase"));
        } else {
          reject(AppError.wrap("DatabaseOpenFailed", cause, { version }).via("openDatabase"));
        }
      });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        // The caller already got a failure (blocked, cancelled): do not leak the connection.
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
      };
      settle(() => {
        resolve(db);
      });
    };
  });
}
