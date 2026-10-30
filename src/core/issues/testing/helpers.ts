import { lookupErrorType, type CheckedIssue, type CheckResult } from "../../analysis";
import { FakeClock } from "../../testing/fake-clock";
import { IssueState } from "../state";

/** A placed issue of the given type (default `verb_form`, a grammar issue) at `start`..`end`. */
export function placed(
  start: number,
  end: number,
  typeId = "verb_form",
  message = "m",
): CheckedIssue {
  const type = lookupErrorType(typeId);
  if (type === undefined) throw new RangeError(`unknown type ${typeId}`);
  return {
    issue: { text: "", type, message, contextBefore: "", contextAfter: "" },
    start,
    end,
    fingerprint: `fp-${String(start)}-${String(end)}`,
  };
}

/** The result of an analyzer that found `issues`. */
export function resultOf(
  issues: readonly CheckedIssue[],
  extra: Partial<CheckResult> = {},
): CheckResult {
  return {
    placed: issues,
    unplaced: 0,
    overlapping: 0,
    usage: { inputTokens: 100, outputTokens: 20, estimated: false },
    chunks: 1,
    cancelled: false,
    ...extra,
  };
}

/** Five issues of the three categories in "aaaa bbbb cccc dddd eeee": G, G, V, V, S. */
export const FIVE_TEXT = "aaaa bbbb cccc dddd eeee";
export function fiveIssues(): CheckedIssue[] {
  return [
    placed(0, 4, "verb_form"),
    placed(5, 9, "article"),
    placed(10, 14, "collocation"),
    placed(15, 19, "spelling"),
    placed(20, 24, "word_order"),
  ];
}

export function newState(): { state: IssueState; clock: FakeClock } {
  const clock = new FakeClock(1_000);
  return { state: new IssueState(clock), clock };
}

/** A promise that a test settles by hand. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
