import type { CheckedIssue, Category, ErrorType, Issue } from "../analysis";
import { CATEGORIES } from "../analysis";
import type { Clock } from "../clock";

/**
 * An issue of the text, as the editor and the list show it. Offsets are UTF-16 offsets in the
 * text the state belongs to (SPEC section 5.1).
 */
export interface TextIssue {
  /** Unique within the state and never reused, so a selection never lands on a different issue. */
  readonly id: number;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly type: ErrorType;
  readonly category: Category;
  /** The one-line summary shown as the tooltip. */
  readonly message: string;
  /** The text between `start` and `end` at the time of the check. */
  readonly snippet: string;
  /** For counting mistakes (SPEC section 5.7). */
  readonly fingerprint: string;
  /** As the model reported it, with the contexts the explanation prompt needs (step 8). */
  readonly issue: Issue;
}

/** The check that is running. At most one per state. */
export interface PendingCheck {
  readonly id: number;
  /** The state's revision when the check took its snapshot of the text. */
  readonly revision: number;
  /** A manual check records its mistakes; an auto-check does not (SPEC section 5.1). */
  readonly manual: boolean;
  /** `Clock.now()` when the check started. */
  readonly startedAt: number;
}

/** How the last check of this text ended. A text that was loaded or edited starts at `none`. */
export type CheckEnd = "none" | "finished" | "cancelled" | "failed";

/** What changed, so that an observer can redraw only what it shows. */
export type IssueChange =
  "issues" | "selection" | "visibility" | "pending" | "outcome" | "revision";

export type IssueListener = (change: IssueChange) => void;

/**
 * The issues of one text, with the selection, the hidden categories, the revision counter and the
 * pending check (SPEC sections 4.4 and 5.1). A plain observable object: the editor's mirror, the
 * issues list and the status bar observe it, and none of them talks to another. It does not know
 * the text itself (the editor owns that) or how checks run (`CheckController` drives it).
 *
 * Step 7 adds edit rebasing here: it replaces `issues` through `replaceIssues` and bumps the
 * revision with `bumpRevision`.
 */
export class IssueState {
  private readonly clock: Clock;
  private readonly listeners = new Set<IssueListener>();
  private current: readonly TextIssue[] = [];
  private selection: number | null = null;
  private readonly hidden = new Set<Category>();
  private currentRevision = 0;
  private running: PendingCheck | null = null;
  private end: CheckEnd = "none";
  private notPlaced = 0;
  private hasResult = false;
  private nextIssueId = 1;
  private nextCheckId = 1;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  // Reading

  /** All issues of the text in text order, hidden categories included. */
  get issues(): readonly TextIssue[] {
    return this.current;
  }

  /** The issues whose category is shown, in text order. */
  get visibleIssues(): readonly TextIssue[] {
    return this.hidden.size === 0
      ? this.current
      : this.current.filter((issue) => !this.hidden.has(issue.category));
  }

  /** The selected issue's id, or null. */
  get selectedId(): number | null {
    return this.selection;
  }

  get selected(): TextIssue | undefined {
    return this.selection === null
      ? undefined
      : this.current.find((issue) => issue.id === this.selection);
  }

  isHidden(category: Category): boolean {
    return this.hidden.has(category);
  }

  /** Counts every edit and every loaded text, so that a check can tell its snapshot is outdated. */
  get revision(): number {
    return this.currentRevision;
  }

  get pending(): PendingCheck | null {
    return this.running;
  }

  /** How the last check ended. */
  get outcome(): CheckEnd {
    return this.end;
  }

  /**
   * True when `issues` is the result of a finished check, even after a later check was cancelled
   * or failed (so an empty list means "no errors found", not "not checked yet").
   */
  get checked(): boolean {
    return this.hasResult;
  }

  /** Issues the model reported that are not in the text (SPEC section 5.3). */
  get unplaced(): number {
    return this.notPlaced;
  }

  /** Observers. Returns the function that removes the listener. */
  subscribe(listener: IssueListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Selection and visibility

  /** Selects an issue, or nothing with `null`. An id that is not in the list selects nothing. */
  select(id: number | null): void {
    const next = id !== null && this.visibleIssues.some((issue) => issue.id === id) ? id : null;
    if (next === this.selection) return;
    this.selection = next;
    this.emit("selection");
  }

  /** Hides or shows a category. Hiding it also deselects an issue of it. */
  setHidden(category: Category, hidden: boolean): void {
    if (this.hidden.has(category) === hidden) return;
    if (hidden) this.hidden.add(category);
    else this.hidden.delete(category);
    const selected = this.selected;
    const deselect = hidden && selected?.category === category;
    if (deselect) this.selection = null;
    this.emit("visibility", ...(deselect ? (["selection"] as const) : []));
  }

  toggleCategory(category: Category): void {
    this.setHidden(category, !this.hidden.has(category));
  }

  /** The categories that are hidden, in legend order. */
  get hiddenCategories(): readonly Category[] {
    return CATEGORIES.filter((category) => this.hidden.has(category));
  }

  // Checks

  /**
   * Records that a check starts on the current revision. A check that was pending is replaced: its
   * controller finds out that it is no longer the pending one when it ends.
   */
  beginCheck(manual: boolean): PendingCheck {
    this.running = {
      id: this.nextCheckId++,
      revision: this.currentRevision,
      manual,
      startedAt: this.clock.now(),
    };
    this.emit("pending");
    return this.running;
  }

  /**
   * Ends the pending check with its result: the issues replace the old ones, the selection is
   * cleared, and the check counts as finished. `text` is the text that was checked, where the
   * offsets of `placed` point (the snippets are cut from it).
   */
  finishCheck(placed: readonly CheckedIssue[], text: string, unplaced: number): void {
    this.running = null;
    this.current = placed.map((p) => this.toTextIssue(p, text));
    this.selection = null;
    this.notPlaced = unplaced;
    this.end = "finished";
    this.hasResult = true;
    this.emit("pending", "issues", "selection", "outcome");
  }

  /** Ends the pending check without a result: the issues stay as they were. */
  endCheck(outcome: "cancelled" | "failed" | "none"): void {
    this.running = null;
    this.end = outcome;
    this.emit("pending", "outcome");
  }

  // Text changes

  /**
   * The text was loaded or changed in a way that the issues cannot follow: they go, the selection
   * with them, and the revision moves on. A pending check is left to its controller (it will find
   * its snapshot outdated). Step 7 replaces this, for edits, by rebasing.
   */
  reset(): void {
    this.bumpRevision();
    const had = this.current.length > 0 || this.end !== "none" || this.hasResult;
    this.current = [];
    this.selection = null;
    this.notPlaced = 0;
    this.end = "none";
    this.hasResult = false;
    if (had) this.emit("issues", "selection", "outcome");
  }

  /** Counts an edit or a loaded text. */
  bumpRevision(): number {
    this.currentRevision++;
    this.emit("revision");
    return this.currentRevision;
  }

  /**
   * Replaces the issues with a rebased or merged list (step 7 and step 10) and keeps the
   * selection if that issue is still there.
   */
  replaceIssues(issues: readonly TextIssue[]): void {
    this.current = issues;
    if (this.selection !== null && !this.visibleIssues.some((i) => i.id === this.selection)) {
      this.selection = null;
      this.emit("issues", "selection");
    } else this.emit("issues");
  }

  private toTextIssue(placed: CheckedIssue, text: string): TextIssue {
    return {
      id: this.nextIssueId++,
      start: placed.start,
      end: placed.end,
      type: placed.issue.type,
      category: placed.issue.type.category,
      message: placed.issue.message,
      snippet: text.slice(placed.start, placed.end),
      fingerprint: placed.fingerprint,
      issue: placed.issue,
    };
  }

  private emit(...changes: IssueChange[]): void {
    for (const change of changes) {
      for (const listener of [...this.listeners]) listener(change);
    }
  }
}
