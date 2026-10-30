import { IDBKeyRange } from "fake-indexeddb";

// Vitest setup file. A browser has `IDBKeyRange` as a global, and the store builds its index
// ranges with it. Node has none, so tests use the one of `fake-indexeddb`, which is the class
// that the fake databases expect.
(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= IDBKeyRange;
