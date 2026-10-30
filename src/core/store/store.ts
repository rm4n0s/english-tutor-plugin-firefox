import type { Clock } from "../clock";
import { AppError, type ErrorMetadata } from "../errors";
import { isConstraintError, requestResult, transact, walk, type AbortOptions } from "./idb";
import { STORES } from "./migrations";
import {
  decodeSetting,
  encodeSetting,
  isSettingKey,
  SETTING_KEYS,
  type SettingKey,
  type Settings,
} from "./settings";
import type {
  ConfigValidator,
  DocumentInput,
  LibraryDocument,
  LLMConfig,
  LLMConfigInput,
  UsageInput,
} from "./types";

export interface StoreOptions {
  /** Checks the values of an LLM configuration before it is stored. Default: checks nothing. */
  validateConfig?: ConfigValidator;
}

interface SettingRecord {
  key: string;
  value: unknown;
}

/** The fields of a configuration that the caller chooses, and nothing else. */
function configFields(input: LLMConfigInput): LLMConfigInput {
  return {
    name: input.name,
    provider: input.provider,
    model: input.model,
    base_url: input.base_url,
    api_key: input.api_key,
    temperature: input.temperature,
    timeout_seconds: input.timeout_seconds,
    max_parallel: input.max_parallel,
    no_thinking: input.no_thinking,
  };
}

function documentFields(input: DocumentInput): DocumentInput {
  return { title: input.title, content: input.content, line_ending: input.line_ending };
}

/**
 * LLM configurations, library documents and settings, in IndexedDB (SPEC section 9). It is built
 * on an open database and a clock, and keeps no other state. Every method may be given
 * `{ signal }`; a cancelled call rolls back and rejects with the signal's reason, which is not an
 * `AppError`.
 *
 * Failures are `AppError`s whose route starts with `Store.<method>`: the tag of the failure
 * (`LLMConfigNameTaken`, `LLMConfigNotFound`, `DocumentNotFound`, `SettingInvalid`) or
 * `DatabaseQueryFailed` for any other failing request.
 *
 * Token usage is written with `recordUsage` (failure: `UsageSaveFailed`). The error events store
 * and the usage queries come in step 9.
 */
export class Store {
  private readonly db: IDBDatabase;
  private readonly clock: Clock;
  private readonly validateConfig: ConfigValidator;

  constructor(db: IDBDatabase, clock: Clock, options: StoreOptions = {}) {
    this.db = db;
    this.clock = clock;
    this.validateConfig = options.validateConfig ?? (() => undefined);
  }

  /** Closes the connection. The store cannot be used afterwards. */
  close(): void {
    this.db.close();
  }

  // LLM configurations

  /** All configurations, ordered by name. */
  listConfigs(options: AbortOptions = {}): Promise<LLMConfig[]> {
    return this.run(
      "Store.listConfigs",
      STORES.llmConfigs,
      "readonly",
      async (tx) =>
        (await requestResult(
          tx.objectStore(STORES.llmConfigs).index("name").getAll(),
        )) as LLMConfig[],
      options,
    );
  }

  /** Throws `LLMConfigNotFound` when there is no configuration with this id. */
  getConfig(id: number, options: AbortOptions = {}): Promise<LLMConfig> {
    return this.run(
      "Store.getConfig",
      STORES.llmConfigs,
      "readonly",
      async (tx) => {
        const config = (await requestResult(tx.objectStore(STORES.llmConfigs).get(id))) as
          LLMConfig | undefined;
        if (config === undefined) throw configNotFound(id);
        return config;
      },
      options,
    );
  }

  /** Throws `LLMConfigNameTaken` when another configuration has the name. */
  createConfig(input: LLMConfigInput, options: AbortOptions = {}): Promise<LLMConfig> {
    return this.run(
      "Store.createConfig",
      STORES.llmConfigs,
      "readwrite",
      async (tx) => {
        this.validateConfig(input);
        const now = this.clock.now();
        const record = { ...configFields(input), created_at: now, updated_at: now };
        const id = await this.writeConfig(tx, "add", record);
        return { ...record, id };
      },
      options,
    );
  }

  /**
   * Replaces the editable fields of a configuration; `created_at` stays. Throws
   * `LLMConfigNotFound` or `LLMConfigNameTaken`.
   */
  updateConfig(id: number, input: LLMConfigInput, options: AbortOptions = {}): Promise<LLMConfig> {
    return this.run(
      "Store.updateConfig",
      STORES.llmConfigs,
      "readwrite",
      async (tx) => {
        this.validateConfig(input);
        const existing = (await requestResult(tx.objectStore(STORES.llmConfigs).get(id))) as
          LLMConfig | undefined;
        if (existing === undefined) throw configNotFound(id);
        const record: LLMConfig = {
          ...configFields(input),
          id,
          created_at: existing.created_at,
          updated_at: this.clock.now(),
        };
        await this.writeConfig(tx, "put", record);
        return record;
      },
      options,
    );
  }

  /**
   * Deletes a configuration. Throws `LLMConfigNotFound`. The selected LLM setting is not
   * touched: the caller picks the next selection (SPEC section 4.7).
   */
  deleteConfig(id: number, options: AbortOptions = {}): Promise<void> {
    return this.run(
      "Store.deleteConfig",
      STORES.llmConfigs,
      "readwrite",
      async (tx) => {
        const objects = tx.objectStore(STORES.llmConfigs);
        if ((await requestResult(objects.getKey(id))) === undefined) throw configNotFound(id);
        await requestResult(objects.delete(id));
      },
      options,
    );
  }

  private async writeConfig(
    tx: IDBTransaction,
    method: "add" | "put",
    record: object,
  ): Promise<number> {
    try {
      const key = await requestResult(tx.objectStore(STORES.llmConfigs)[method](record));
      return key as number;
    } catch (err) {
      // The name is the only unique index of the store.
      if (isConstraintError(err)) {
        throw new AppError(
          "LLMConfigNameTaken",
          "an LLM with this name already exists",
          {},
          {
            cause: err,
          },
        );
      }
      throw err;
    }
  }

  // Documents

  /** All documents, the most recently updated first. */
  listDocuments(options: AbortOptions = {}): Promise<LibraryDocument[]> {
    return this.run(
      "Store.listDocuments",
      STORES.documents,
      "readonly",
      async (tx) => {
        const documents: LibraryDocument[] = [];
        await walk(
          tx.objectStore(STORES.documents).index("updated_at"),
          (document) => {
            documents.push(document as LibraryDocument);
          },
          { direction: "prev" },
        );
        return documents;
      },
      options,
    );
  }

  /** Throws `DocumentNotFound`. */
  getDocument(id: number, options: AbortOptions = {}): Promise<LibraryDocument> {
    return this.run(
      "Store.getDocument",
      STORES.documents,
      "readonly",
      async (tx) => {
        const document = (await requestResult(tx.objectStore(STORES.documents).get(id))) as
          LibraryDocument | undefined;
        if (document === undefined) throw documentNotFound(id);
        return document;
      },
      options,
    );
  }

  createDocument(input: DocumentInput, options: AbortOptions = {}): Promise<LibraryDocument> {
    return this.run(
      "Store.createDocument",
      STORES.documents,
      "readwrite",
      async (tx) => {
        const now = this.clock.now();
        const record = { ...documentFields(input), created_at: now, updated_at: now };
        const id = (await requestResult(tx.objectStore(STORES.documents).add(record))) as number;
        return { ...record, id };
      },
      options,
    );
  }

  /** Replaces title, content and line ending, and sets `updated_at`. Throws `DocumentNotFound`. */
  updateDocument(
    id: number,
    input: DocumentInput,
    options: AbortOptions = {},
  ): Promise<LibraryDocument> {
    return this.changeDocument("Store.updateDocument", id, () => documentFields(input), options);
  }

  /** Changes the title only, and sets `updated_at`. Throws `DocumentNotFound`. */
  renameDocument(id: number, title: string, options: AbortOptions = {}): Promise<LibraryDocument> {
    return this.changeDocument("Store.renameDocument", id, () => ({ title }), options);
  }

  /** Throws `DocumentNotFound`. */
  deleteDocument(id: number, options: AbortOptions = {}): Promise<void> {
    return this.run(
      "Store.deleteDocument",
      STORES.documents,
      "readwrite",
      async (tx) => {
        const documents = tx.objectStore(STORES.documents);
        if ((await requestResult(documents.getKey(id))) === undefined) throw documentNotFound(id);
        await requestResult(documents.delete(id));
      },
      options,
    );
  }

  private changeDocument(
    where: string,
    id: number,
    change: () => Partial<DocumentInput>,
    options: AbortOptions,
  ): Promise<LibraryDocument> {
    return this.run(
      where,
      STORES.documents,
      "readwrite",
      async (tx) => {
        const documents = tx.objectStore(STORES.documents);
        const existing = (await requestResult(documents.get(id))) as LibraryDocument | undefined;
        if (existing === undefined) throw documentNotFound(id);
        const record: LibraryDocument = { ...existing, ...change(), updated_at: this.clock.now() };
        await requestResult(documents.put(record));
        return record;
      },
      options,
    );
  }

  // Token usage

  /**
   * Stores the token usage of one request (SPEC section 5.8) with the time from the clock. A
   * failing write is `UsageSaveFailed`, route `Store.recordUsage->UsageSaveFailed`, which callers
   * log and otherwise ignore: the request's result is still shown.
   */
  recordUsage(input: UsageInput, options: AbortOptions = {}): Promise<void> {
    return this.run(
      "Store.recordUsage",
      STORES.llmUsage,
      "readwrite",
      async (tx) => {
        const record = {
          llm_name: input.llm_name,
          kind: input.kind,
          input_tokens: input.input_tokens,
          output_tokens: input.output_tokens,
          estimated: input.estimated,
          created_at: this.clock.now(),
        };
        await requestResult(tx.objectStore(STORES.llmUsage).add(record));
      },
      options,
      "UsageSaveFailed",
    );
  }

  // Settings

  /** One setting: the stored value if it is valid, else the default (SPEC section 9). */
  getSetting<K extends SettingKey>(key: K, options: AbortOptions = {}): Promise<Settings[K]> {
    return this.run(
      "Store.getSetting",
      STORES.settings,
      "readonly",
      async (tx) => {
        const record = (await requestResult(tx.objectStore(STORES.settings).get(key))) as
          SettingRecord | undefined;
        return decodeSetting(key, record?.value);
      },
      options,
    );
  }

  /** Every setting, with the default for each one that is missing or invalid. */
  getSettings(options: AbortOptions = {}): Promise<Settings> {
    return this.run(
      "Store.getSettings",
      STORES.settings,
      "readonly",
      async (tx) => {
        const records = (await requestResult(
          tx.objectStore(STORES.settings).getAll(),
        )) as SettingRecord[];
        const stored = new Map(records.map((record) => [record.key, record.value]));
        const settings: Record<string, unknown> = {};
        for (const key of SETTING_KEYS) settings[key] = decodeSetting(key, stored.get(key));
        return settings as unknown as Settings;
      },
      options,
    );
  }

  /** Stores one setting. Throws `SettingInvalid` for a value the key does not allow. */
  setSetting<K extends SettingKey>(
    key: K,
    value: Settings[K],
    options: AbortOptions = {},
  ): Promise<void> {
    return this.run(
      "Store.setSetting",
      STORES.settings,
      "readwrite",
      async (tx) => {
        const encoded = isSettingKey(key) ? encodeSetting(key, value) : undefined;
        if (encoded === undefined) {
          throw new AppError("SettingInvalid", "the value is not allowed for this setting", {
            key,
          });
        }
        await requestResult(tx.objectStore(STORES.settings).put({ key, value: encoded.raw }));
      },
      options,
    );
  }

  /**
   * Runs `work` in a transaction. An `AppError` keeps its tag and gets `where`; a cancelled
   * signal's reason passes through; anything else is `failureTag` (`DatabaseQueryFailed` unless
   * the caller has a tag of its own).
   */
  private async run<T>(
    where: string,
    storeName: string,
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T>,
    options: AbortOptions,
    failureTag = "DatabaseQueryFailed",
  ): Promise<T> {
    try {
      return await transact(this.db, storeName, mode, work, options);
    } catch (err) {
      if (err instanceof AppError) throw err.via(where);
      if (options.signal?.aborted === true) throw err;
      const metadata: ErrorMetadata = { store: storeName };
      throw AppError.wrap(failureTag, err, metadata).via(where);
    }
  }
}

function configNotFound(id: number): AppError {
  return new AppError("LLMConfigNotFound", "no LLM with this id", { id });
}

function documentNotFound(id: number): AppError {
  return new AppError("DocumentNotFound", "no document with this id", { id });
}
