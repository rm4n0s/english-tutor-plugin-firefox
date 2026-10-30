import type { Clock } from "../clock";
import { AppError } from "../errors";
import { requestResult, transact, walk, walkKeys, type AbortOptions } from "./idb";
import { STORES } from "./migrations";
import type {
  ErrorEvent,
  MistakeInput,
  MoveResult,
  Period,
  RecordResult,
  Summary,
  TokenSums,
  TypeCounts,
  TypeStats,
  UsageTotals,
} from "./types";

const DAY_MS = 86_400_000;

/** The Not-an-error ignore set (SPEC section 5.7), kept by the platform in `storage.session`. */
export interface IgnoreSet {
  has(source: string, fingerprint: string): Promise<boolean>;
  add(source: string, fingerprint: string): Promise<void>;
}

/** What a failing method reports: the tag of SPEC section 10 and a message the page can show. */
interface Failure {
  tag: string;
  message: string;
}

const SAVE_FAILED: Failure = {
  tag: "ErrorEventSaveFailed",
  message: "The mistakes of this check could not be saved.",
};
const QUERY_FAILED: Failure = {
  tag: "StatsQueryFailed",
  message: "The mistake counts could not be read.",
};
const USAGE_QUERY_FAILED: Failure = {
  tag: "UsageQueryFailed",
  message: "The token usage could not be read.",
};

/** Where a window of `days` days starts: now minus that many days, inclusive. */
function since(now: number, days: number): number {
  return now - days * DAY_MS;
}

/** The index range of one error type: every `[type, created_at]` key. */
function typeRange(errorType: string, from = -Infinity): IDBKeyRange {
  return IDBKeyRange.bound([errorType, from], [errorType, Infinity]);
}

/** The days of a period, or undefined for all time. */
export function periodDays(period: Period): number | undefined {
  return period === "all" ? undefined : period === "30d" ? 30 : 7;
}

/** The mistakes of `row` in `period`. */
export function countInPeriod(row: TypeCounts, period: Period): number {
  return period === "all" ? row.total : period === "30d" ? row.last30 : row.last7;
}

/**
 * The summary of rows (SPEC section 4.8): the mistakes in the period and the type with the most.
 * Types with none in the period do not count. `tieBreak` orders types with the same count (the
 * first wins); the default is the type id.
 */
export function summarizeRows(
  rows: readonly TypeStats[],
  period: Period,
  tieBreak: (a: TypeStats, b: TypeStats) => number = (a, b) =>
    a.error_type < b.error_type ? -1 : a.error_type > b.error_type ? 1 : 0,
): Summary {
  let total = 0;
  let best: TypeStats | undefined;
  for (const row of rows) {
    const n = countInPeriod(row, period);
    if (n === 0) continue;
    total += n;
    if (best === undefined) best = row;
    else {
      const bn = countInPeriod(best, period);
      if (n > bn || (n === bn && tieBreak(row, best) < 0)) best = row;
    }
  }
  return { period, total, mostFrequent: best?.error_type };
}

function emptySums(): TokenSums {
  return { input_tokens: 0, output_tokens: 0, estimated: false };
}

interface UsageRow {
  llm_name: string;
  input_tokens: number;
  output_tokens: number;
  estimated: boolean;
  created_at: number;
}

function addTo(sums: TokenSums, row: UsageRow): void {
  sums.input_tokens += row.input_tokens;
  sums.output_tokens += row.output_tokens;
  if (row.estimated) sums.estimated = true;
}

/**
 * Counting mistakes and token usage (SPEC sections 5.7 and 5.8), on an open database. It mirrors
 * the desktop app's statistics API. Time comes from the injected clock; the Not-an-error ignore
 * set is injected too, because it lives in `storage.session`, not in the database.
 *
 * Failures are `AppError`s whose route starts with `Stats.<method>`: `ErrorEventSaveFailed`
 * (`record`, `moveSource`), `StatsQueryFailed` (`typeStats`, `countForType`, `recentExamples`,
 * `summarize`), `StatsResetFailed` (`notAnError`, `resetMistakes`, `resetUsage`) and
 * `UsageQueryFailed` (`usageTotals`). A cancelled `signal` rolls back and rejects with its reason,
 * which is not an `AppError`.
 */
export class Stats {
  private readonly db: IDBDatabase;
  private readonly clock: Clock;
  private readonly ignore: IgnoreSet;

  constructor(db: IDBDatabase, clock: Clock, ignore: IgnoreSet) {
    this.db = db;
    this.clock = clock;
    this.ignore = ignore;
  }

  // Recording

  /**
   * Records the mistakes of a manual check under `source`, with the time of the clock. A pair
   * (source, fingerprint) that is already recorded does nothing, so a re-check counts nothing
   * twice and the first type stays; a pair in the ignore set is skipped.
   */
  record(
    source: string,
    llmName: string,
    mistakes: readonly MistakeInput[],
    options: AbortOptions = {},
  ): Promise<RecordResult> {
    return this.guard("Stats.record", SAVE_FAILED, options, async () => {
      // The ignore set is not in the database, so it is read before the transaction starts.
      const ignored = await Promise.all(
        mistakes.map((m) => this.ignore.has(source, m.fingerprint)),
      );
      const now = this.clock.now();
      return transact(
        this.db,
        STORES.errorEvents,
        "readwrite",
        async (tx) => {
          const events = tx.objectStore(STORES.errorEvents);
          const pairs = events.index("source_key_fingerprint");
          const result: RecordResult = { inserted: 0, duplicate: 0, ignored: 0 };
          for (const [i, mistake] of mistakes.entries()) {
            if (ignored[i] === true) {
              result.ignored++;
              continue;
            }
            const existing = await requestResult(pairs.getKey([source, mistake.fingerprint]));
            if (existing !== undefined) {
              result.duplicate++;
              continue;
            }
            const event: Omit<ErrorEvent, "id"> = {
              error_type: mistake.error_type,
              category: mistake.category,
              snippet: mistake.snippet,
              source_key: source,
              fingerprint: mistake.fingerprint,
              llm_name: llmName,
              created_at: now,
            };
            await requestResult(events.add(event));
            result.inserted++;
          }
          return result;
        },
        options,
      );
    });
  }

  /**
   * Not an error (SPEC section 5.7): adds the pair to the ignore set, so that a re-check does not
   * record it again, and deletes its event. Resolves with whether an event was deleted.
   */
  notAnError(source: string, fingerprint: string, options: AbortOptions = {}): Promise<boolean> {
    return this.guard(
      "Stats.notAnError",
      { tag: "StatsResetFailed", message: "The mistake could not be removed from the statistics." },
      options,
      async () => {
        await this.ignore.add(source, fingerprint);
        return transact(
          this.db,
          STORES.errorEvents,
          "readwrite",
          async (tx) => {
            const events = tx.objectStore(STORES.errorEvents);
            const key = await requestResult(
              events.index("source_key_fingerprint").getKey([source, fingerprint]),
            );
            if (key === undefined) return false;
            await requestResult(events.delete(key));
            return true;
          },
          options,
        );
      },
    );
  }

  /**
   * Moves the events of source `from` to source `to` (Save to library, SPEC section 5.7). An
   * event whose fingerprint `to` already has is deleted instead of moved.
   */
  moveSource(from: string, to: string, options: AbortOptions = {}): Promise<MoveResult> {
    return this.guard("Stats.moveSource", SAVE_FAILED, options, () =>
      transact(
        this.db,
        STORES.errorEvents,
        "readwrite",
        async (tx) => {
          const result: MoveResult = { moved: 0, dropped: 0 };
          if (from === to) return result;
          const events = tx.objectStore(STORES.errorEvents);
          const pairs = events.index("source_key_fingerprint");
          const moving = (await requestResult(
            events.index("source_key").getAll(IDBKeyRange.only(from)),
          )) as ErrorEvent[];
          for (const event of moving) {
            const taken = await requestResult(pairs.getKey([to, event.fingerprint]));
            if (taken === undefined) {
              await requestResult(events.put({ ...event, source_key: to }));
              result.moved++;
            } else {
              await requestResult(events.delete(event.id));
              result.dropped++;
            }
          }
          return result;
        },
        options,
      ),
    );
  }

  // Counting

  /**
   * One entry per error type with at least one mistake, in the order of the type ids: total,
   * last 30 days, last 7 days and the newest time. It reads only the keys of the
   * `error_type_created_at` index, which are `[type, created_at]` in ascending order, plus one
   * record per type for its category.
   */
  typeStats(options: AbortOptions = {}): Promise<TypeStats[]> {
    return this.guard("Stats.typeStats", QUERY_FAILED, options, () => {
      const now = this.clock.now();
      const from30 = since(now, 30);
      const from7 = since(now, 7);
      return transact(
        this.db,
        STORES.errorEvents,
        "readonly",
        async (tx) => {
          const index = tx.objectStore(STORES.errorEvents).index("error_type_created_at");
          const rows: TypeStats[] = [];
          let current: TypeStats | undefined;
          await walkKeys(index, (key) => {
            const [errorType, createdAt] = key as [string, number];
            if (current?.error_type !== errorType) {
              current = {
                error_type: errorType,
                category: "",
                total: 0,
                last30: 0,
                last7: 0,
                last_seen: createdAt,
              };
              rows.push(current);
            }
            current.total++;
            if (createdAt >= from30) current.last30++;
            if (createdAt >= from7) current.last7++;
            current.last_seen = createdAt;
          });
          for (const row of rows) {
            const sample = (await requestResult(index.get(typeRange(row.error_type)))) as
              ErrorEvent | undefined;
            row.category = sample?.category ?? "";
          }
          return rows;
        },
        options,
      );
    });
  }

  /** The counts of one error type, for the badges and the header of the explanation panel. */
  countForType(errorType: string, options: AbortOptions = {}): Promise<TypeCounts> {
    return this.guard("Stats.countForType", QUERY_FAILED, options, () => {
      const now = this.clock.now();
      return transact(
        this.db,
        STORES.errorEvents,
        "readonly",
        async (tx) => {
          const index = tx.objectStore(STORES.errorEvents).index("error_type_created_at");
          const [total, last30, last7] = await Promise.all([
            requestResult(index.count(typeRange(errorType))),
            requestResult(index.count(typeRange(errorType, since(now, 30)))),
            requestResult(index.count(typeRange(errorType, since(now, 7)))),
          ]);
          return { total, last30, last7 };
        },
        options,
      );
    });
  }

  /** The most recent mistakes of an error type, newest first (the dialog shows three). */
  recentExamples(errorType: string, limit = 3, options: AbortOptions = {}): Promise<ErrorEvent[]> {
    return this.guard("Stats.recentExamples", QUERY_FAILED, options, () =>
      transact(
        this.db,
        STORES.errorEvents,
        "readonly",
        async (tx) => {
          const found: ErrorEvent[] = [];
          if (limit <= 0) return found;
          await walk(
            tx.objectStore(STORES.errorEvents).index("error_type_created_at"),
            (event) => {
              found.push(event as ErrorEvent);
              return found.length < limit;
            },
            { range: typeRange(errorType), direction: "prev" },
          );
          return found;
        },
        options,
      ),
    );
  }

  /** The summary line of a period: see `summarizeRows`. */
  summarize(period: Period, options: AbortOptions = {}): Promise<Summary> {
    return this.typeStats(options).then(
      (rows) => summarizeRows(rows, period),
      (err: unknown) => {
        throw err instanceof AppError ? err.via("Stats.summarize") : err;
      },
    );
  }

  // Resets

  /** Deletes every recorded mistake. Resolves with how many there were. The ignore set stays. */
  resetMistakes(options: AbortOptions = {}): Promise<number> {
    return this.guard(
      "Stats.resetMistakes",
      { tag: "StatsResetFailed", message: "The statistics could not be reset." },
      options,
      () =>
        transact(
          this.db,
          STORES.errorEvents,
          "readwrite",
          async (tx) => {
            const events = tx.objectStore(STORES.errorEvents);
            const count = await requestResult(events.count());
            await requestResult(events.clear());
            return count;
          },
          options,
        ),
    );
  }

  // Token usage

  /**
   * The token usage of every LLM that has any, ordered by name: all time, last 30 days and last
   * 7 days, with the estimated flag (SPEC section 5.8).
   */
  usageTotals(options: AbortOptions = {}): Promise<UsageTotals[]> {
    return this.guard("Stats.usageTotals", USAGE_QUERY_FAILED, options, () => {
      const now = this.clock.now();
      const from30 = since(now, 30);
      const from7 = since(now, 7);
      return transact(
        this.db,
        STORES.llmUsage,
        "readonly",
        async (tx) => {
          const byName = new Map<string, UsageTotals>();
          await walk(tx.objectStore(STORES.llmUsage), (value) => {
            const row = value as UsageRow;
            let totals = byName.get(row.llm_name);
            if (totals === undefined) {
              totals = {
                llm_name: row.llm_name,
                all: emptySums(),
                last30: emptySums(),
                last7: emptySums(),
              };
              byName.set(row.llm_name, totals);
            }
            addTo(totals.all, row);
            if (row.created_at >= from30) addTo(totals.last30, row);
            if (row.created_at >= from7) addTo(totals.last7, row);
          });
          return [...byName.values()].sort((a, b) =>
            a.llm_name < b.llm_name ? -1 : a.llm_name > b.llm_name ? 1 : 0,
          );
        },
        options,
      );
    });
  }

  /** Deletes the stored token usage of every LLM. */
  resetUsage(options: AbortOptions = {}): Promise<void> {
    return this.guard(
      "Stats.resetUsage",
      { tag: "StatsResetFailed", message: "The token usage could not be reset." },
      options,
      () =>
        transact(
          this.db,
          STORES.llmUsage,
          "readwrite",
          async (tx) => {
            await requestResult(tx.objectStore(STORES.llmUsage).clear());
          },
          options,
        ),
    );
  }

  /**
   * Runs `work`. An `AppError` keeps its tag and gets `where`; a cancelled signal's reason passes
   * through; anything else (an IndexedDB error, a failing ignore set) becomes `failure.tag`.
   */
  private async guard<T>(
    where: string,
    failure: Failure,
    options: AbortOptions,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof AppError) throw err.via(where);
      if (options.signal?.aborted === true) throw err;
      throw new AppError(failure.tag, failure.message, {}, { cause: err }).via(where);
    }
  }
}
