import { IDBFactory } from "fake-indexeddb";
import { FakeClock } from "../../testing/fake-clock";
import { openDatabase } from "../open";
import { Store, type StoreOptions } from "../store";

/** A new, empty in-memory IndexedDB. Every test makes its own, so none shares a database. */
export function freshFactory(): IDBFactory {
  return new IDBFactory();
}

/** A store on a fresh database with a fake clock. */
export async function freshStore(
  options: StoreOptions = {},
  start = 1_000,
): Promise<{ store: Store; clock: FakeClock; db: IDBDatabase; factory: IDBFactory }> {
  const factory = freshFactory();
  const db = await openDatabase(factory);
  const clock = new FakeClock(start);
  return { store: new Store(db, clock, options), clock, db, factory };
}
