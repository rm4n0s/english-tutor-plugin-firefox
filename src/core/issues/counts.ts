import type { TypeCounts } from "../store/types";
import type { IssueState, TextIssue } from "./state";

/** What the counts need from the statistics. `Stats` fits. */
export interface CountSource {
  countForType(errorType: string): Promise<TypeCounts>;
}

/** The end of the header line of an issue that an auto-check found (SPEC section 4.5). */
export const NOT_COUNTED_TEXT = "This one is not counted: only the Check button counts.";

function times(n: number): string {
  return n === 1 ? "1 time" : `${String(n)} times`;
}

/**
 * The header line of the explanation panel (SPEC section 4.5):
 * "Subject-verb agreement: you have made this mistake 7 times (2 in the last 7 days)", or
 * "<label>: no mistake of this type recorded yet". For an issue of an auto-check it ends with
 * "This one is not counted: only the Check button counts.". Undefined until the counts are known,
 * and the panel then shows the label alone.
 */
export function headerLineText(
  label: string,
  counts: TypeCounts | undefined,
  manual: boolean,
): string | undefined {
  if (counts === undefined) return undefined;
  const base =
    counts.total === 0
      ? `${label}: no mistake of this type recorded yet`
      : `${label}: you have made this mistake ${times(counts.total)} (${String(counts.last7)} in the last 7 days)`;
  return manual ? base : `${base}. ${NOT_COUNTED_TEXT}`;
}

/**
 * How often the user has made the mistakes of the issues on screen (SPEC sections 4.4 and 4.5):
 * the counts per error type that the badges (`x7`) and the header line show. It reads them from a
 * `CountSource` when `refresh` is called (after recording a check, and when another tab announces
 * `stats-changed`) and for the selected issue's type when that is not known yet. Loads run one
 * after another, so the latest answer wins. A failed read is handed to `onError`; the counts
 * stay as they were.
 *
 * It knows nothing about the DOM or the page, so page mode uses one per text box.
 */
export class IssueCounts {
  private readonly state: IssueState;
  private readonly source: CountSource;
  private readonly onError: (err: unknown) => void;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private known = new Map<string, TypeCounts>();
  private queue: Promise<void> = Promise.resolve();

  constructor(state: IssueState, source: CountSource, onError: (err: unknown) => void) {
    this.state = state;
    this.source = source;
    this.onError = onError;
    this.unsubscribe = state.subscribe((change) => {
      if (change !== "selection") return;
      const type = state.selected?.type.id;
      if (type !== undefined && !this.known.has(type)) void this.enqueue([type], false);
    });
  }

  destroy(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  /** The counts of an error type, or undefined when they are not known yet. */
  get(errorType: string): TypeCounts | undefined {
    return this.known.get(errorType);
  }

  /**
   * The number on an issue's badge (`x7`): the total of its type, for an issue of a manual check
   * whose type has a recorded mistake. Undefined means no badge.
   */
  badge(issue: TextIssue): number | undefined {
    if (!issue.manual) return undefined;
    const total = this.known.get(issue.type.id)?.total ?? 0;
    return total > 0 ? total : undefined;
  }

  /** The header line of the issue, or undefined while its counts are unknown (SPEC section 4.5). */
  headerLine(issue: TextIssue): string | undefined {
    return headerLineText(issue.type.label, this.known.get(issue.type.id), issue.manual);
  }

  /** Reads the counts of every type that has an issue on screen again. */
  refresh(): Promise<void> {
    return this.enqueue([...new Set(this.state.issues.map((i) => i.type.id))], true);
  }

  /** Called when the counts change. Returns the function that removes the listener. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private enqueue(types: readonly string[], replaceAll: boolean): Promise<void> {
    const next = this.queue.then(() => this.load(types, replaceAll));
    this.queue = next;
    return next;
  }

  private async load(types: readonly string[], replaceAll: boolean): Promise<void> {
    try {
      const entries = await Promise.all(
        types.map(async (type) => [type, await this.source.countForType(type)] as const),
      );
      this.known = replaceAll ? new Map(entries) : new Map([...this.known, ...entries]);
    } catch (err) {
      this.onError(err);
      return;
    }
    for (const listener of [...this.listeners]) listener();
  }
}

/** What shows the header line: the explanation panel. */
export interface HeaderLineView {
  setHeaderLine(text: string | undefined): void;
}

/**
 * Keeps the header line of the explanation panel in step with the selected issue and its counts
 * (SPEC section 4.5): the counts text for the selected issue, the plain label for none.
 */
export class SelectedIssueHeader {
  private readonly state: IssueState;
  private readonly counts: IssueCounts;
  private readonly view: HeaderLineView;
  private readonly unsubscribes: (() => void)[];

  constructor(state: IssueState, counts: IssueCounts, view: HeaderLineView) {
    this.state = state;
    this.counts = counts;
    this.view = view;
    this.unsubscribes = [
      state.subscribe((change) => {
        if (change === "selection" || change === "issues") this.update();
      }),
      counts.subscribe(() => {
        this.update();
      }),
    ];
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
  }

  private update(): void {
    const issue = this.state.selected;
    this.view.setHeaderLine(issue === undefined ? undefined : this.counts.headerLine(issue));
  }
}
