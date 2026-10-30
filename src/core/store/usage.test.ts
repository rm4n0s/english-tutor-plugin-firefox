import { describe, expect, it } from "vitest";
import { Analyzer } from "../analysis/analyzer";
import { CountingRandom, issuesJson, reply, setup } from "../analysis/testing/helpers";
import { AppError } from "../errors";
import { Logger } from "../log";
import { requestResult } from "./idb";
import { STORES } from "./migrations";
import { freshStore } from "./testing/db";
import { StoreUsageRecorder } from "./usage-recorder";

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

const input = {
  llm_name: "Local",
  kind: "check",
  input_tokens: 812,
  output_tokens: 164,
  estimated: false,
} as const;

async function rows(db: IDBDatabase): Promise<unknown[]> {
  return requestResult(db.transaction(STORES.llmUsage).objectStore(STORES.llmUsage).getAll());
}

describe("Store.recordUsage", () => {
  it.each([
    { name: "a reported check", input },
    { name: "an estimated explanation", input: { ...input, kind: "explain", estimated: true } },
    { name: "an alternatives request", input: { ...input, kind: "alternatives" } },
  ] as const)("stores $name with the time of the clock", async ({ input: usage }) => {
    const { store, db } = await freshStore({}, 5_000);
    await store.recordUsage(usage);
    expect(await rows(db)).toEqual([{ ...usage, id: 1, created_at: 5_000 }]);
  });

  it("keeps one row per request, in order", async () => {
    const { store, db, clock } = await freshStore();
    await store.recordUsage(input);
    clock.advance(10);
    await store.recordUsage({ ...input, input_tokens: 1 });
    const stored = (await rows(db)) as { id: number; created_at: number; input_tokens: number }[];
    expect(stored.map((r) => [r.id, r.created_at, r.input_tokens])).toEqual([
      [1, 1_000, 812],
      [2, 1_010, 1],
    ]);
  });

  it("fails with Store.recordUsage->UsageSaveFailed and keeps the cause", async () => {
    const { store } = await freshStore();
    store.close();
    const err = await caught(store.recordUsage(input));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("Store.recordUsage->UsageSaveFailed")).toBe(true);
    expect((err as AppError).cause).toBeInstanceOf(DOMException);
    expect((err as AppError).metadata).toEqual({ store: "llm_usage" });
  });

  it("fails with UsageSaveFailed when the request inside the transaction fails", async () => {
    const { store, db } = await freshStore();
    // A function cannot be cloned into the database: the add request fails with DataCloneError.
    const err = await caught(
      store.recordUsage({ ...input, llm_name: (() => 1) as unknown as string }),
    );
    expect((err as AppError).hasRoute("Store.recordUsage->UsageSaveFailed")).toBe(true);
    expect(await rows(db)).toEqual([]);
  });

  it("rejects with the signal's reason, not an AppError, when cancelled", async () => {
    const { store, db } = await freshStore();
    const err = await caught(store.recordUsage(input, { signal: AbortSignal.abort("stop") }));
    expect(err).toBe("stop");
    expect(await rows(db)).toEqual([]);
  });
});

describe("StoreUsageRecorder", () => {
  it("writes the analysis records of a check as rows", async () => {
    const { store, db } = await freshStore();
    const { model } = setup(reply(issuesJson("He go"), { usage: { input: 50, output: 10 } }));
    const analyzer = new Analyzer({
      random: new CountingRandom(),
      usage: new StoreUsageRecorder(store),
    });
    const result = await analyzer.check(model, "He go home.");
    expect(result.placed).toHaveLength(1);
    expect(await rows(db)).toMatchObject([
      { llm_name: "local", kind: "check", input_tokens: 50, output_tokens: 10, estimated: false },
    ]);
  });

  it("does not fail the check when the usage cannot be saved: it is logged and the result is shown", async () => {
    const { store } = await freshStore();
    store.close();
    const warnings: { message: string; fields: unknown }[] = [];
    const noop = () => undefined;
    const logger = new Logger({
      debug: noop,
      info: noop,
      error: noop,
      warn: (message, fields) => warnings.push({ message, fields }),
    });
    const { model } = setup(reply(issuesJson("He go"), { usage: { input: 50, output: 10 } }));
    const analyzer = new Analyzer({
      random: new CountingRandom(),
      usage: new StoreUsageRecorder(store),
      logger,
    });
    const result = await analyzer.check(model, "He go home.");
    expect(result.placed).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    const logged = warnings[0]?.fields as { err: { tag: string; route: string } };
    expect(logged.err.tag).toBe("UsageSaveFailed");
    expect(logged.err.route).toBe("Store.recordUsage->UsageSaveFailed");
  });
});
