import type { Usage } from "../llm";
import type { UsageRecord, UsageRecorder } from "../analysis/usage";

/** Tokens as the status bar shows them (SPEC section 5.8). */
export interface TokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** True if any of the counts is an estimate; the page marks it with `~`. */
  readonly estimated: boolean;
}

const NONE: TokenTotals = { inputTokens: 0, outputTokens: 0, estimated: false };

/**
 * The tokens of a tab: the last request (a whole check, all its chunks and retries) and the
 * session total, which starts at zero when the tab opens (SPEC section 5.8). It is also a
 * `UsageRecorder`, so every request that reports usage, whatever its outcome, counts in the
 * session; the controller sets the last request when a check ends.
 */
export class TokenTally implements UsageRecorder {
  private lastUsage: TokenTotals | null = null;
  private total: TokenTotals = NONE;
  private readonly listeners = new Set<() => void>();

  /** The last request's tokens, or null before the first one. */
  get last(): TokenTotals | null {
    return this.lastUsage;
  }

  get session(): TokenTotals {
    return this.total;
  }

  /** Adds one request to the session total (`UsageRecorder`). */
  record(record: UsageRecord): void {
    this.total = add(this.total, record.usage);
    this.notify();
  }

  /** Sets the last request. Empty usage (a request that reported nothing) is ignored. */
  setLast(usage: Usage): void {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
    this.lastUsage = { ...usage };
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function add(a: TokenTotals, b: Usage): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    estimated: a.estimated || b.estimated,
  };
}

/** 0 to 999 as they are, then `1.2k` (one decimal, none when it would be `.0`) and `3.4M`. */
export function formatCount(n: number): string {
  const rounded = (value: number, unit: string): string => {
    const text = value.toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text}${unit}`;
  };
  if (n < 1000) return String(n);
  if (n < 999_950) return rounded(n / 1000, "k");
  return rounded(n / 1_000_000, "M");
}

function formatTotals(totals: TokenTotals): string {
  const mark = totals.estimated ? "~" : "";
  return `${mark}${formatCount(totals.inputTokens)} in / ${mark}${formatCount(totals.outputTokens)} out`;
}

/** `last: 812 in / 164 out · session: 5.2k in / 1.1k out`, with `~` before estimated counts. */
export function tokenStatusText(last: TokenTotals | null, session: TokenTotals): string {
  return `last: ${last === null ? "none" : formatTotals(last)} · session: ${formatTotals(session)}`;
}
