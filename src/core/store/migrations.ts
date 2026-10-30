/**
 * The schema of the database (SPEC section 9). Migration N is `MIGRATIONS[N - 1]`; version N is
 * reached by running migrations 1..N in order. A released migration is never edited: a change
 * is a new migration at the end of the list.
 */
export type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

export const DATABASE_NAME = "english-tutor";

/** Names of the object stores, shared with `Store`. */
export const STORES = {
  llmConfigs: "llm_configs",
  documents: "documents",
  errorEvents: "error_events",
  llmUsage: "llm_usage",
  settings: "settings",
} as const;

/** Migration 1: all five object stores with their indexes. */
function migration1(db: IDBDatabase): void {
  const configs = db.createObjectStore(STORES.llmConfigs, { keyPath: "id", autoIncrement: true });
  configs.createIndex("name", "name", { unique: true });

  const documents = db.createObjectStore(STORES.documents, { keyPath: "id", autoIncrement: true });
  documents.createIndex("updated_at", "updated_at");

  const events = db.createObjectStore(STORES.errorEvents, { keyPath: "id", autoIncrement: true });
  events.createIndex("source_key_fingerprint", ["source_key", "fingerprint"], { unique: true });
  events.createIndex("error_type_created_at", ["error_type", "created_at"]);
  events.createIndex("created_at", "created_at");
  events.createIndex("source_key", "source_key");

  const usage = db.createObjectStore(STORES.llmUsage, { keyPath: "id", autoIncrement: true });
  usage.createIndex("created_at", "created_at");

  db.createObjectStore(STORES.settings, { keyPath: "key" });
}

export const MIGRATIONS: readonly Migration[] = [migration1];
