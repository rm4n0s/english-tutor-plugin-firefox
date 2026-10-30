import { SystemClock, type Clock } from "../clock";
import { AppError } from "../errors";
import { addUsage, type Usage } from "../llm";
import type { Logger } from "../log";
import type { Random } from "../random";
import { checkText } from "./check";
import { chunkSizeFor, DEFAULT_CHUNK_WORDS, splitChunks } from "./chunk";
import { fingerprint } from "./fingerprint";
import { Flight } from "./flight";
import {
  appendLocated,
  EMPTY_LOCATE_RESULT,
  locate,
  type LocateResult,
  type Placed,
} from "./locate";
import type { AnalysisModel } from "./model";
import { NO_USAGE, recordUsage, type UsageRecorder } from "./usage";

export interface AnalyzerDeps {
  /** The source of delimiter tokens. */
  random: Random;
  /** Gets the usage of every request (kind `check`), one record per chunk, retry included. */
  usage?: UsageRecorder;
  logger?: Logger;
  clock?: Clock;
  /** The largest number of words in one request; default 2000 (SPEC section 5.2). */
  chunkWords?: number;
}

/**
 * A selection check (SPEC section 5.1): the text passed to `check` is the selected text, which
 * starts at `offset` in `fullText`, the whole text of the editor.
 */
export interface SelectionBase {
  readonly offset: number;
  readonly fullText: string;
}

export interface CheckOptions {
  /** Cancels the check. A cancel is a result with `cancelled`, not an error. */
  signal?: AbortSignal;
  selection?: SelectionBase;
}

/** A placed issue with its fingerprint (SPEC section 5.7), computed in the whole text. */
export interface CheckedIssue extends Placed {
  readonly fingerprint: string;
}

export interface CheckResult {
  /**
   * Sorted by `start` and never overlapping. Offsets are UTF-16 offsets in the checked text, or
   * in `selection.fullText` for a selection check.
   */
  readonly placed: readonly CheckedIssue[];
  /** Issues the model reported that are not in the text, plus unusable entries. The UI shows this. */
  readonly unplaced: number;
  /** Issues dropped because they overlap an earlier one. */
  readonly overlapping: number;
  /** The total token usage of the check: all chunks and retries. */
  readonly usage: Usage;
  /** The number of pieces the text was split into. */
  readonly chunks: number;
  /**
   * True if the check was cancelled by `cancel`, by a newer check or by the signal. That is not an
   * error; no issues are returned in that case.
   */
  readonly cancelled: boolean;
}

/**
 * Runs checks. Only one check runs at a time: starting a check cancels the one before it
 * (SPEC section 5.1).
 */
export class Analyzer {
  private readonly deps: AnalyzerDeps;
  private readonly clock: Clock;
  private readonly chunkWords: number;
  private readonly flight = new Flight();

  constructor(deps: AnalyzerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? new SystemClock();
    this.chunkWords =
      deps.chunkWords !== undefined && deps.chunkWords > 0 ? deps.chunkWords : DEFAULT_CHUNK_WORDS;
  }

  /** Cancels the running check, if any. Its `check` call resolves with `cancelled`. */
  cancel(): void {
    this.flight.stop();
  }

  /**
   * Sends `text` to the model in chunks and returns the issues found, placed in the text. Up to
   * `model.parallel` chunks are requested at once and the results are merged in text order. The
   * first chunk that fails cancels the others, and its error is thrown: `LLMCallFailed`,
   * `LLMCallTimeout`, `HostPermissionDenied` or `LLMResponseInvalid`, with the route
   * `Analyzer.check->...`. A cancelled check resolves with `cancelled` and no error. Token usage
   * is recorded for every chunk that reported it, even if the check later fails or is cancelled.
   */
  async check(
    model: AnalysisModel,
    text: string,
    options: CheckOptions = {},
  ): Promise<CheckResult> {
    const run = this.flight.begin(options.signal);
    const started = this.clock.now();
    try {
      return await this.run(model, text, options.selection, run.signal, started);
    } catch (err) {
      throw err instanceof AppError ? err.via("Analyzer.check") : err;
    } finally {
      run.end();
    }
  }

  private async run(
    model: AnalysisModel,
    text: string,
    selection: SelectionBase | undefined,
    runSignal: AbortSignal,
    started: number,
  ): Promise<CheckResult> {
    const parallel = Number.isFinite(model.parallel)
      ? Math.max(1, Math.floor(model.parallel ?? 1))
      : 1;
    const chunks = splitChunks(text, chunkSizeFor(text, parallel, this.chunkWords));

    // `stop` ends when the check is cancelled or when one chunk has failed.
    const stop = new AbortController();
    const onRunAbort = () => {
      stop.abort(runSignal.reason);
    };
    if (runSignal.aborted) stop.abort(runSignal.reason);
    else runSignal.addEventListener("abort", onRunAbort, { once: true });

    // Written by the workers; an object, so that the reads below see their writes.
    const state: { usage: Usage; failure: AppError | undefined; cancelled: boolean } = {
      usage: NO_USAGE,
      failure: undefined,
      cancelled: false,
    };
    const located: (LocateResult | undefined)[] = chunks.map(() => undefined);
    let next = 0;

    const runChunk = async (index: number, chunkText: string) => {
      let chunkUsage = NO_USAGE;
      try {
        const { parsed } = await checkText(model, chunkText, this.deps.random, stop.signal, (u) => {
          chunkUsage = addUsage(chunkUsage, u);
        });
        const result = locate(chunkText, parsed.issues);
        located[index] = { ...result, unplaced: result.unplaced + parsed.dropped };
      } catch (err) {
        if (stop.signal.aborted) {
          // Cancelled by the user, or by the failure of another chunk.
          state.cancelled = true;
        } else {
          state.failure ??= err instanceof AppError ? err : AppError.wrap("LLMCallFailed", err);
          stop.abort();
        }
      }
      state.usage = addUsage(state.usage, chunkUsage);
      await recordUsage(this.deps.usage, this.deps.logger, model.name, "check", chunkUsage);
    };

    const worker = async () => {
      for (;;) {
        const index = next;
        const chunk = chunks[index];
        if (chunk === undefined) return;
        if (stop.signal.aborted) {
          state.cancelled = true; // a chunk was skipped
          return;
        }
        next++;
        await runChunk(index, chunk.text);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
    } finally {
      runSignal.removeEventListener("abort", onRunAbort);
    }

    if (state.failure !== undefined) throw state.failure;
    const usage = state.usage;
    const elapsedMs = this.clock.now() - started;
    if (state.cancelled) {
      this.deps.logger?.info("check cancelled", { chunks: chunks.length, elapsed_ms: elapsedMs });
      return {
        placed: [],
        unplaced: 0,
        overlapping: 0,
        usage,
        chunks: chunks.length,
        cancelled: true,
      };
    }

    let merged = EMPTY_LOCATE_RESULT;
    const base = selection?.offset ?? 0;
    chunks.forEach((chunk, index) => {
      merged = appendLocated(merged, located[index] ?? EMPTY_LOCATE_RESULT, chunk.start + base);
    });
    const fullText = selection?.fullText ?? text;
    const placed = await Promise.all(
      merged.placed.map(async (p): Promise<CheckedIssue> => ({
        ...p,
        fingerprint: await fingerprint(fullText, p.start, p.end),
      })),
    );
    this.deps.logger?.info("check finished", {
      chunks: chunks.length,
      parallel,
      issues: placed.length,
      unplaced: merged.unplaced,
      overlapping: merged.overlapping,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      estimated: usage.estimated,
      elapsed_ms: elapsedMs,
    });
    return {
      placed,
      unplaced: merged.unplaced,
      overlapping: merged.overlapping,
      usage,
      chunks: chunks.length,
      cancelled: false,
    };
  }
}
