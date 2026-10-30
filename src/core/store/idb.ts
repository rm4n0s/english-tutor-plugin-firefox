/* eslint-disable @typescript-eslint/prefer-promise-reject-errors --
   IndexedDB errors are DOMExceptions, and a cancelled AbortSignal may carry any reason; all of
   them are passed on unchanged. */

/**
 * A small promise wrapper over IndexedDB. It knows nothing about this application's stores and
 * throws the browser's own errors (DOMException); `Store` and `openDatabase` turn them into
 * `AppError`s.
 *
 * A transaction commits as soon as it has no pending request, so inside `transact` only `await`
 * the helpers of this file (or other requests of the same transaction), never a timer or a fetch.
 */

/** Options of the operations that can be cancelled. */
export interface AbortOptions {
  signal?: AbortSignal;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** The error of a failed request, which the types allow to be missing. */
function requestError(request: IDBRequest | IDBTransaction): unknown {
  return request.error ?? new DOMException("The request failed.", "UnknownError");
}

/** True for the error that a cancelled `AbortSignal` produces. Cancelling is not a failure. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** True for a violated unique index or key. */
export function isConstraintError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "ConstraintError";
}

/** Resolves with the result of a request, rejects with its error. */
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(requestError(request));
    };
  });
}

/**
 * Calls `visit` with the value of each record of a store or index, in the order of `direction`,
 * until the records end or `visit` returns `false` (any other result continues).
 */
export function walk(
  source: IDBObjectStore | IDBIndex,
  visit: (value: unknown) => unknown,
  options: { range?: IDBKeyRange; direction?: IDBCursorDirection } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = source.openCursor(options.range, options.direction);
    request.onerror = () => {
      reject(requestError(request));
    };
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }
      try {
        if (visit(cursor.value) === false) {
          resolve();
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      cursor.continue();
    };
  });
}

/**
 * Like `walk`, but over the keys of an index only, so no record is read: `visit` gets the index
 * key and the primary key. Stops when `visit` returns `false`.
 */
export function walkKeys(
  index: IDBIndex,
  visit: (key: IDBValidKey, primaryKey: IDBValidKey) => unknown,
  options: { range?: IDBKeyRange; direction?: IDBCursorDirection } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = index.openKeyCursor(options.range, options.direction);
    request.onerror = () => {
      reject(requestError(request));
    };
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }
      try {
        if (visit(cursor.key, cursor.primaryKey) === false) {
          resolve();
          return;
        }
      } catch (err) {
        reject(err);
        return;
      }
      cursor.continue();
    };
  });
}

/**
 * Runs `work` in one transaction and resolves with its result once the transaction has
 * committed. If `work` rejects, or `signal` aborts, the transaction is rolled back and the
 * promise rejects with that error (for a signal, its reason, normally an `AbortError`). If the
 * database rolls the transaction back itself (a violated unique index), it rejects with the
 * transaction's error.
 */
export function transact<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
  options: AbortOptions = {},
): Promise<T> {
  const { signal } = options;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (err) {
      reject(err);
      return;
    }

    let failed = false;
    let failure: unknown;
    let result: T | undefined;
    const fail = (err: unknown) => {
      if (failed) return;
      failed = true;
      failure = err;
    };
    const rollBack = () => {
      try {
        tx.abort();
      } catch {
        // Already finished: nothing to roll back.
      }
    };
    const onAbort = () => {
      fail(abortReason(signal));
      rollBack();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // `work` starts now, in this task, so that the transaction is still active.
    const done = new Promise<T>((run) => {
      run(work(tx));
    }).then(
      (value) => {
        result = value;
      },
      (err: unknown) => {
        fail(err);
        rollBack();
      },
    );

    tx.oncomplete = () => {
      signal?.removeEventListener("abort", onAbort);
      void done.then(() => {
        if (failed) reject(failure);
        else resolve(result as T);
      });
    };
    tx.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      fail(requestError(tx));
      reject(failure);
    };
  });
}
