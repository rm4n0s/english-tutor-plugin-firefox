import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { requestResult } from "./idb";
import { STORES } from "./migrations";
import { summarizeRows } from "./stats";
import { freshStats } from "./testing/db";
import type { ErrorEvent, MistakeInput, TypeStats } from "./types";

const DAY = 86_400_000;
const NOW = 100 * DAY;

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

function mistake(
  fingerprint: string,
  error_type = "article",
  category = "grammar",
  snippet = `snippet ${fingerprint}`,
): MistakeInput {
  return { error_type, category, snippet, fingerprint };
}

async function events(db: IDBDatabase): Promise<ErrorEvent[]> {
  return requestResult(
    db.transaction(STORES.errorEvents).objectStore(STORES.errorEvents).getAll(),
  ) as Promise<ErrorEvent[]>;
}

async function setup(start = NOW) {
  return freshStats(start);
}

describe("Stats.record", () => {
  it("stores each mistake with the source, the LLM and the time of the clock", async () => {
    const { stats, db } = await setup(5_000);
    const result = await stats.record("session:a", "Local", [
      mistake("f1", "article", "grammar", "a apple"),
      mistake("f2", "wrong_word", "vocabulary", "make a photo"),
    ]);
    expect(result).toEqual({ inserted: 2, duplicate: 0, ignored: 0 });
    expect(await events(db)).toEqual([
      {
        id: 1,
        error_type: "article",
        category: "grammar",
        snippet: "a apple",
        source_key: "session:a",
        fingerprint: "f1",
        llm_name: "Local",
        created_at: 5_000,
      },
      {
        id: 2,
        error_type: "wrong_word",
        category: "vocabulary",
        snippet: "make a photo",
        source_key: "session:a",
        fingerprint: "f2",
        llm_name: "Local",
        created_at: 5_000,
      },
    ]);
  });

  it.each([
    {
      name: "an empty batch",
      first: [] as MistakeInput[],
      second: [] as MistakeInput[],
      stored: 0,
      expected: { inserted: 0, duplicate: 0, ignored: 0 },
    },
    {
      name: "the same pair recorded twice counts once",
      first: [mistake("f1")],
      second: [mistake("f1")],
      stored: 1,
      expected: { inserted: 0, duplicate: 1, ignored: 0 },
    },
    {
      name: "a second check with one old and one new mistake",
      first: [mistake("f1"), mistake("f2")],
      second: [mistake("f2"), mistake("f3")],
      stored: 3,
      expected: { inserted: 1, duplicate: 1, ignored: 0 },
    },
  ])("$name", async ({ first, second, stored, expected }) => {
    const { stats, db } = await setup();
    await stats.record("session:a", "Local", first);
    expect(await stats.record("session:a", "Local", second)).toEqual(expected);
    expect(await events(db)).toHaveLength(stored);
  });

  it("keeps the first type and time when a later check gives the same pair another type", async () => {
    const { stats, db, clock } = await setup(1_000);
    await stats.record("session:a", "Local", [mistake("f1", "article", "grammar")]);
    clock.advance(500);
    const result = await stats.record("session:a", "Other", [
      mistake("f1", "wrong_word", "vocabulary"),
    ]);
    expect(result.duplicate).toBe(1);
    const [only] = await events(db);
    expect(only).toMatchObject({ error_type: "article", llm_name: "Local", created_at: 1_000 });
  });

  it("counts the same snippet in two sources twice", async () => {
    const { stats } = await setup();
    await stats.record("session:a", "Local", [mistake("same")]);
    await stats.record("doc:7", "Local", [mistake("same")]);
    expect((await stats.countForType("article")).total).toBe(2);
  });

  it("skips pairs of the ignore set and reports them", async () => {
    const { stats, ignore } = await setup();
    ignore.pairs.add("session:a|f2");
    const result = await stats.record("session:a", "Local", [mistake("f1"), mistake("f2")]);
    expect(result).toEqual({ inserted: 1, duplicate: 0, ignored: 1 });
    expect((await stats.countForType("article")).total).toBe(1);
  });

  it("ignores a pair only under its own source", async () => {
    const { stats, ignore } = await setup();
    ignore.pairs.add("session:a|f1");
    const result = await stats.record("session:b", "Local", [mistake("f1")]);
    expect(result.inserted).toBe(1);
  });

  it("rejects with the signal's reason, not an AppError, when cancelled", async () => {
    const { stats, db } = await setup();
    const err = await caught(
      stats.record("session:a", "Local", [mistake("f1")], { signal: AbortSignal.abort() }),
    );
    expect(err).toBeInstanceOf(DOMException);
    expect(err).not.toBeInstanceOf(AppError);
    expect(await events(db)).toEqual([]);
  });
});

describe("Stats.notAnError", () => {
  it("deletes the event, adds the pair to the ignore set, and a re-check does not record it", async () => {
    const { stats, db, ignore } = await setup();
    await stats.record("session:a", "Local", [mistake("f1"), mistake("f2")]);
    expect(await stats.notAnError("session:a", "f1")).toBe(true);
    expect((await events(db)).map((e) => e.fingerprint)).toEqual(["f2"]);
    expect(ignore.pairs.has("session:a|f1")).toBe(true);
    const again = await stats.record("session:a", "Local", [mistake("f1"), mistake("f2")]);
    expect(again).toEqual({ inserted: 0, duplicate: 1, ignored: 1 });
  });

  it("still ignores a pair that was never recorded (an auto-check issue), and says so", async () => {
    const { stats, ignore } = await setup();
    expect(await stats.notAnError("session:a", "f9")).toBe(false);
    expect(ignore.pairs.has("session:a|f9")).toBe(true);
  });

  it("leaves the same fingerprint of another source alone", async () => {
    const { stats, db } = await setup();
    await stats.record("session:a", "Local", [mistake("same")]);
    await stats.record("doc:1", "Local", [mistake("same")]);
    await stats.notAnError("session:a", "same");
    expect((await events(db)).map((e) => e.source_key)).toEqual(["doc:1"]);
  });
});

describe("Stats.moveSource", () => {
  it.each([
    {
      name: "moves every event of the session to the document",
      from: [mistake("f1"), mistake("f2")],
      to: [] as MistakeInput[],
      expected: { moved: 2, dropped: 0 },
      remaining: [
        ["doc:7", "f1"],
        ["doc:7", "f2"],
      ],
    },
    {
      name: "drops the events whose pair the document already has",
      from: [mistake("f1"), mistake("f2")],
      to: [mistake("f2", "wrong_word", "vocabulary"), mistake("f3")],
      expected: { moved: 1, dropped: 1 },
      remaining: [
        ["doc:7", "f2"],
        ["doc:7", "f3"],
        ["doc:7", "f1"],
      ],
    },
    {
      name: "does nothing for a source without events",
      from: [] as MistakeInput[],
      to: [mistake("f3")],
      expected: { moved: 0, dropped: 0 },
      remaining: [["doc:7", "f3"]],
    },
  ])("$name", async ({ from, to, expected, remaining }) => {
    const { stats, db } = await setup();
    await stats.record("session:a", "Local", from);
    await stats.record("doc:7", "Local", to);
    expect(await stats.moveSource("session:a", "doc:7")).toEqual(expected);
    const stored = await events(db);
    expect(stored.map((e) => [e.source_key, e.fingerprint]).sort()).toEqual([...remaining].sort());
  });

  it("keeps the time, type and snippet of a moved event, and the documents' own type on a duplicate", async () => {
    const { stats, db, clock } = await setup(1_000);
    await stats.record("session:a", "Local", [mistake("f1", "article", "grammar", "a apple")]);
    clock.advance(10);
    await stats.record("doc:7", "Other", [mistake("f2", "verb_tense", "grammar")]);
    await stats.moveSource("session:a", "doc:7");
    const moved = (await events(db)).find((e) => e.fingerprint === "f1");
    expect(moved).toMatchObject({
      source_key: "doc:7",
      error_type: "article",
      snippet: "a apple",
      created_at: 1_000,
      llm_name: "Local",
    });
  });

  it("leaves the events of other sources and moving a source onto itself alone", async () => {
    const { stats, db } = await setup();
    await stats.record("session:a", "Local", [mistake("f1")]);
    await stats.record("session:b", "Local", [mistake("f2")]);
    expect(await stats.moveSource("session:a", "session:a")).toEqual({ moved: 0, dropped: 0 });
    await stats.moveSource("session:a", "doc:1");
    expect((await events(db)).map((e) => e.source_key).sort()).toEqual(["doc:1", "session:b"]);
  });
});

describe("Stats.typeStats and countForType", () => {
  /** Records one mistake of `type` `ageDays` days before NOW (fractions allowed). */
  async function recordAt(
    ctx: Awaited<ReturnType<typeof setup>>,
    type: string,
    category: string,
    ageMs: number,
    fingerprint: string,
  ) {
    ctx.clock.set(NOW - ageMs);
    await ctx.stats.record("session:a", "Local", [mistake(fingerprint, type, category)]);
    ctx.clock.set(NOW);
  }

  it("is empty without mistakes", async () => {
    const { stats } = await setup();
    expect(await stats.typeStats()).toEqual([]);
    expect(await stats.countForType("article")).toEqual({ total: 0, last30: 0, last7: 0 });
  });

  it.each([
    { name: "now", age: 0, counted: { total: 1, last30: 1, last7: 1 } },
    {
      name: "exactly 7 days ago (inclusive)",
      age: 7 * DAY,
      counted: { total: 1, last30: 1, last7: 1 },
    },
    {
      name: "1 ms older than 7 days",
      age: 7 * DAY + 1,
      counted: { total: 1, last30: 1, last7: 0 },
    },
    {
      name: "exactly 30 days ago (inclusive)",
      age: 30 * DAY,
      counted: { total: 1, last30: 1, last7: 0 },
    },
    {
      name: "1 ms older than 30 days",
      age: 30 * DAY + 1,
      counted: { total: 1, last30: 0, last7: 0 },
    },
  ])("windows: a mistake $name", async ({ age, counted }) => {
    const ctx = await setup();
    await recordAt(ctx, "article", "grammar", age, "f1");
    expect(await ctx.stats.countForType("article")).toEqual(counted);
    const [row] = await ctx.stats.typeStats();
    expect(row).toMatchObject({ error_type: "article", category: "grammar", ...counted });
    expect(row?.last_seen).toBe(NOW - age);
  });

  it("gives one row per type with its counts, category and newest time", async () => {
    const ctx = await setup();
    await recordAt(ctx, "article", "grammar", 40 * DAY, "a1");
    await recordAt(ctx, "article", "grammar", 10 * DAY, "a2");
    await recordAt(ctx, "article", "grammar", 2 * DAY, "a3");
    await recordAt(ctx, "article", "grammar", 3 * DAY, "a4");
    await recordAt(ctx, "wrong_word", "vocabulary", 1 * DAY, "w1");
    await recordAt(ctx, "word_order", "syntax", 20 * DAY, "o1");
    const rows = await ctx.stats.typeStats();
    expect(rows).toEqual<TypeStats[]>([
      {
        error_type: "article",
        category: "grammar",
        total: 4,
        last30: 3,
        last7: 2,
        last_seen: NOW - 2 * DAY,
      },
      {
        error_type: "word_order",
        category: "syntax",
        total: 1,
        last30: 1,
        last7: 0,
        last_seen: NOW - 20 * DAY,
      },
      {
        error_type: "wrong_word",
        category: "vocabulary",
        total: 1,
        last30: 1,
        last7: 1,
        last_seen: NOW - 1 * DAY,
      },
    ]);
    expect(await ctx.stats.countForType("article")).toEqual({ total: 4, last30: 3, last7: 2 });
    expect(await ctx.stats.countForType("verb_tense")).toEqual({ total: 0, last30: 0, last7: 0 });
  });

  it("does not mix a type with another whose id starts the same", async () => {
    const ctx = await setup();
    await recordAt(ctx, "grammar", "grammar", 0, "g1");
    await recordAt(ctx, "grammar_other", "grammar", 0, "g2");
    expect((await ctx.stats.countForType("grammar")).total).toBe(1);
    expect((await ctx.stats.countForType("grammar_other")).total).toBe(1);
  });

  it("follows the clock: a mistake leaves the 7 day window as time passes", async () => {
    const ctx = await setup();
    await recordAt(ctx, "article", "grammar", 6 * DAY, "f1");
    expect((await ctx.stats.countForType("article")).last7).toBe(1);
    ctx.clock.advance(2 * DAY);
    expect((await ctx.stats.countForType("article")).last7).toBe(0);
    expect((await ctx.stats.countForType("article")).last30).toBe(1);
  });
});

describe("Stats.recentExamples", () => {
  it("lists the newest first, at most three by default, of the one type", async () => {
    const { stats, clock } = await setup(1_000);
    for (const [i, type] of ["article", "article", "wrong_word", "article", "article"].entries()) {
      clock.set(1_000 + i * 10);
      await stats.record("session:a", "Local", [mistake(`f${String(i)}`, type)]);
    }
    const examples = await stats.recentExamples("article");
    expect(examples.map((e) => e.snippet)).toEqual(["snippet f4", "snippet f3", "snippet f1"]);
    expect(examples.map((e) => e.created_at)).toEqual([1_040, 1_030, 1_010]);
  });

  it.each([
    { limit: 1, expected: 1 },
    { limit: 2, expected: 2 },
    { limit: 10, expected: 4 },
    { limit: 0, expected: 0 },
  ])("honours a limit of $limit", async ({ limit, expected }) => {
    const { stats, clock } = await setup();
    for (let i = 0; i < 4; i++) {
      clock.advance(1);
      await stats.record("session:a", "Local", [mistake(`f${String(i)}`)]);
    }
    expect(await stats.recentExamples("article", limit)).toHaveLength(expected);
  });

  it("is empty for a type without mistakes", async () => {
    const { stats } = await setup();
    expect(await stats.recentExamples("article")).toEqual([]);
  });
});

describe("summarize", () => {
  const row = (error_type: string, total: number, last30: number, last7: number): TypeStats => ({
    error_type,
    category: "grammar",
    total,
    last30,
    last7,
    last_seen: 0,
  });

  it.each([
    { period: "all", total: 24, top: "article" },
    { period: "30d", total: 9, top: "verb_tense" },
    { period: "7d", total: 2, top: "article" },
  ] as const)("sums and picks the most frequent type for $period", ({ period, total, top }) => {
    const rows = [row("article", 10, 3, 2), row("verb_tense", 9, 5, 0), row("wrong_word", 5, 1, 0)];
    expect(summarizeRows(rows, period)).toEqual({ period, total, mostFrequent: top });
  });

  it("has no most frequent type when nothing was recorded in the period", () => {
    expect(summarizeRows([row("article", 3, 0, 0)], "7d")).toEqual({
      period: "7d",
      total: 0,
      mostFrequent: undefined,
    });
    expect(summarizeRows([], "all").mostFrequent).toBeUndefined();
  });

  it.each([
    { name: "by type id by default", tieBreak: undefined, expected: "article" },
    {
      name: "by the caller's order",
      tieBreak: (a: TypeStats, b: TypeStats) =>
        b.total - a.total || (a.error_type < b.error_type ? 1 : -1),
      expected: "wrong_word",
    },
  ])("breaks a tie $name", ({ tieBreak, expected }) => {
    const rows = [row("wrong_word", 4, 4, 4), row("article", 4, 4, 4)];
    expect(summarizeRows(rows, "all", tieBreak).mostFrequent).toBe(expected);
  });

  it("is read from the store by Stats.summarize", async () => {
    const { stats } = await setup();
    await stats.record("session:a", "Local", [
      mistake("f1", "article"),
      mistake("f2", "article"),
      mistake("f3", "wrong_word", "vocabulary"),
    ]);
    expect(await stats.summarize("all")).toEqual({
      period: "all",
      total: 3,
      mostFrequent: "article",
    });
  });
});

describe("resets", () => {
  it("resetMistakes deletes every event, reports how many, and keeps the ignore set", async () => {
    const { stats, db, ignore } = await setup();
    await stats.record("session:a", "Local", [mistake("f1"), mistake("f2")]);
    await stats.record("doc:1", "Local", [mistake("f3")]);
    await stats.notAnError("session:a", "f1");
    expect(await stats.resetMistakes()).toBe(2);
    expect(await events(db)).toEqual([]);
    expect(await stats.typeStats()).toEqual([]);
    expect(ignore.pairs.has("session:a|f1")).toBe(true);
    expect(await stats.resetMistakes()).toBe(0);
  });

  it("resetUsage deletes the usage and leaves the mistakes", async () => {
    const { stats, store } = await setup();
    await stats.record("session:a", "Local", [mistake("f1")]);
    await store.recordUsage({
      llm_name: "Local",
      kind: "check",
      input_tokens: 10,
      output_tokens: 5,
      estimated: false,
    });
    await stats.resetUsage();
    expect(await stats.usageTotals()).toEqual([]);
    expect((await stats.countForType("article")).total).toBe(1);
  });
});

describe("Stats.usageTotals", () => {
  const usage = (llm_name: string, input: number, output: number, estimated = false) => ({
    llm_name,
    kind: "check" as const,
    input_tokens: input,
    output_tokens: output,
    estimated,
  });

  it("is empty without requests", async () => {
    expect(await (await setup()).stats.usageTotals()).toEqual([]);
  });

  it("sums per LLM for all time, 30 days and 7 days, ordered by name", async () => {
    const { stats, store, clock } = await setup();
    const at = async (ageMs: number, input: ReturnType<typeof usage>) => {
      clock.set(NOW - ageMs);
      await store.recordUsage(input);
    };
    await at(60 * DAY, usage("Zed", 1000, 100));
    await at(20 * DAY, usage("Zed", 200, 20));
    await at(3 * DAY, usage("Zed", 30, 3));
    await at(0, usage("Alpha", 4, 1));
    clock.set(NOW);
    expect(await stats.usageTotals()).toEqual([
      {
        llm_name: "Alpha",
        all: { input_tokens: 4, output_tokens: 1, estimated: false },
        last30: { input_tokens: 4, output_tokens: 1, estimated: false },
        last7: { input_tokens: 4, output_tokens: 1, estimated: false },
      },
      {
        llm_name: "Zed",
        all: { input_tokens: 1230, output_tokens: 123, estimated: false },
        last30: { input_tokens: 230, output_tokens: 23, estimated: false },
        last7: { input_tokens: 30, output_tokens: 3, estimated: false },
      },
    ]);
  });

  it.each([
    {
      name: "an old estimate marks only all time",
      old: true,
      recent: false,
      flags: [true, false, false],
    },
    {
      name: "a recent estimate marks every period",
      old: false,
      recent: true,
      flags: [true, true, true],
    },
    { name: "no estimate marks nothing", old: false, recent: false, flags: [false, false, false] },
  ])("$name", async ({ old, recent, flags }) => {
    const { stats, store, clock } = await setup();
    clock.set(NOW - 90 * DAY);
    await store.recordUsage(usage("Local", 5, 5, old));
    clock.set(NOW - DAY);
    await store.recordUsage(usage("Local", 5, 5, recent));
    clock.set(NOW);
    const [totals] = await stats.usageTotals();
    expect([totals?.all.estimated, totals?.last30.estimated, totals?.last7.estimated]).toEqual(
      flags,
    );
  });
});

describe("failures", () => {
  type Ctx = Awaited<ReturnType<typeof setup>>;

  // A closed connection fails every request the way a browser failure would.
  describe.each<{
    route: string;
    matches: (e: AppError) => boolean;
    call: (ctx: Ctx) => Promise<unknown>;
  }>([
    {
      route: "Stats.record->ErrorEventSaveFailed",
      matches: (e) => e.hasRoute("Stats.record->ErrorEventSaveFailed"),
      call: (c) => c.stats.record("session:a", "Local", [mistake("f1")]),
    },
    {
      route: "Stats.moveSource->ErrorEventSaveFailed",
      matches: (e) => e.hasRoute("Stats.moveSource->ErrorEventSaveFailed"),
      call: (c) => c.stats.moveSource("session:a", "doc:1"),
    },
    {
      route: "Stats.typeStats->StatsQueryFailed",
      matches: (e) => e.hasRoute("Stats.typeStats->StatsQueryFailed"),
      call: (c) => c.stats.typeStats(),
    },
    {
      route: "Stats.countForType->StatsQueryFailed",
      matches: (e) => e.hasRoute("Stats.countForType->StatsQueryFailed"),
      call: (c) => c.stats.countForType("article"),
    },
    {
      route: "Stats.recentExamples->StatsQueryFailed",
      matches: (e) => e.hasRoute("Stats.recentExamples->StatsQueryFailed"),
      call: (c) => c.stats.recentExamples("article"),
    },
    {
      route: "Stats.summarize->Stats.typeStats->StatsQueryFailed",
      matches: (e) => e.hasRoute("Stats.summarize->Stats.typeStats->StatsQueryFailed"),
      call: (c) => c.stats.summarize("all"),
    },
    {
      route: "Stats.notAnError->StatsResetFailed",
      matches: (e) => e.hasRoute("Stats.notAnError->StatsResetFailed"),
      call: (c) => c.stats.notAnError("session:a", "f1"),
    },
    {
      route: "Stats.resetMistakes->StatsResetFailed",
      matches: (e) => e.hasRoute("Stats.resetMistakes->StatsResetFailed"),
      call: (c) => c.stats.resetMistakes(),
    },
    {
      route: "Stats.resetUsage->StatsResetFailed",
      matches: (e) => e.hasRoute("Stats.resetUsage->StatsResetFailed"),
      call: (c) => c.stats.resetUsage(),
    },
    {
      route: "Stats.usageTotals->UsageQueryFailed",
      matches: (e) => e.hasRoute("Stats.usageTotals->UsageQueryFailed"),
      call: (c) => c.stats.usageTotals(),
    },
  ])("$route", ({ matches, call }) => {
    it("fails with that route and keeps the cause", async () => {
      const ctx = await setup();
      ctx.db.close();
      const err = await caught(call(ctx));
      expect(err).toBeInstanceOf(AppError);
      expect(matches(err as AppError)).toBe(true);
      expect((err as AppError).cause).toBeInstanceOf(DOMException);
    });
  });

  it.each([
    {
      route: "Stats.record->ErrorEventSaveFailed",
      matches: (e: AppError) => e.hasRoute("Stats.record->ErrorEventSaveFailed"),
      call: (c: Ctx) => c.stats.record("session:a", "Local", [mistake("f1")]),
    },
    {
      route: "Stats.notAnError->StatsResetFailed",
      matches: (e: AppError) => e.hasRoute("Stats.notAnError->StatsResetFailed"),
      call: (c: Ctx) => c.stats.notAnError("session:a", "f1"),
    },
  ])("$route also when the ignore set fails", async ({ matches, call }) => {
    const ctx = await setup();
    ctx.ignore.failWith = new Error("storage.session is not available");
    const err = await caught(call(ctx));
    expect(err).toBeInstanceOf(AppError);
    expect(matches(err as AppError)).toBe(true);
    expect((err as AppError).cause).toBeInstanceOf(Error);
  });

  it("keeps the mistakes and their messages free of the user's text", async () => {
    const ctx = await setup();
    ctx.db.close();
    const err = (await caught(
      ctx.stats.record("session:a", "Local", [
        mistake("f1", "article", "grammar", "my secret text"),
      ]),
    )) as AppError;
    expect(err.message).not.toContain("my secret text");
    expect(JSON.stringify(err.metadata)).not.toContain("my secret text");
  });

  it("does not turn a cancelled query into a failure", async () => {
    const ctx = await setup();
    const err = await caught(ctx.stats.typeStats({ signal: AbortSignal.abort() }));
    expect(err).not.toBeInstanceOf(AppError);
  });
});
