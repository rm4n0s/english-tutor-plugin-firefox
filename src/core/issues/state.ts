import type { CheckedIssue, Category, ErrorType, Issue } from "../analysis";
import { CATEGORIES } from "../analysis";
import type { Clock } from "../clock";
import { EditLog, rebaseIssues, type Edit } from "./edits";

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
  /**
   * True when a manual check found it. Issues of an auto-check are not counted in the statistics
   * and get no count badge (SPEC sections 4.4 and 5.7).
   */
  readonly manual: boolean;
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
 * An edit of the text goes through `applyEdit` (SPEC section 5.5): the issues it touches go at
 * once, the ones after it move, and while a check runs the edit is logged so that the check's
 * result can be rebased across it.
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
  private resultCheckId = 0;
  private readonly log: EditLog;

  /** `editLogLimit` is the most edits kept while a check runs (SPEC section 5.5). */
  constructor(clock: Clock, options: { editLogLimit?: number } = {}) {
    this.clock = clock;
    this.log = new EditLog(options.editLogLimit);
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

  /**
   * The id of the check whose result the issues are, or 0 when there is none (nothing checked yet,
   * or a text was loaded). A new result changes it, so that what was keyed by it (the cached
   * explanations) is known to be out of date (SPEC section 5.4).
   */
  get checkId(): number {
    return this.resultCheckId;
  }

  /** Issues the model reported that are not in the text (SPEC section 5.3). */
  get unplaced(): number {
    return this.notPlaced;
  }

  /**
   * The edits made since the pending check began, in order, to rebase its result across; or
   * undefined when there were too many, or a text was loaded meanwhile, and the result must be
   * discarded. Empty when the text did not change.
   */
  get editsDuringCheck(): readonly Edit[] | undefined {
    return this.log.edits;
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
    this.log.clear();
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
   * offsets of `placed` point (the snippets are cut from it). `edits` are the ones made to the
   * text since then (`editsDuringCheck`): the issues are rebased across them in order, and the
   * ones an edit touched are dropped.
   */
  finishCheck(
    placed: readonly CheckedIssue[],
    text: string,
    unplaced: number,
    edits: readonly Edit[] = [],
  ): void {
    const manual = this.running?.manual ?? true;
    this.resultCheckId = this.running?.id ?? this.nextCheckId++;
    this.running = null;
    let issues = placed.map((p) => this.toTextIssue(p, text, manual));
    for (const edit of edits) issues = rebaseIssues(issues, edit);
    this.current = issues;
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

  /**
   * Ends the pending check and throws its result away because it cannot be applied (SPEC section
   * 5.5): the issues and the outcome of the earlier check stay as they were.
   */
  discardCheck(): void {
    this.running = null;
    this.emit("pending");
  }

  // Text changes

  /**
   * A text was loaded (New, Open, a hand-off): the issues go, the selection with them, and the
   * revision moves on. A pending check is left to its controller; it finds its snapshot outdated
   * and, as a loaded text is not an edit, discards its result.
   */
  reset(): void {
    this.bumpRevision();
    this.resultCheckId = 0;
    const had = this.current.length > 0 || this.end !== "none" || this.hasResult;
    this.current = [];
    this.selection = null;
    this.notPlaced = 0;
    this.end = "none";
    this.hasResult = false;
    if (had) this.emit("issues", "selection", "outcome");
  }

  /**
   * The text was edited (SPEC section 5.5). The revision moves on; an issue the edit touched is
   * removed at once (and the selection with it), the ones after the edit move; while a check
   * runs, the edit is logged. When no issue is left, the check's result no longer says anything
   * about the text, so the state goes back to "not checked" (status `Ready`).
   */
  applyEdit(edit: Edit): void {
    if (this.running !== null) this.log.push(edit);
    this.currentRevision++;
    const before = this.current;
    const after = rebaseIssues(before, edit);
    const changed = after.length !== before.length || after.some((issue, i) => issue !== before[i]);
    const hadSelection = this.selection !== null;
    this.current = after;
    if (this.selection !== null && !after.some((issue) => issue.id === this.selection)) {
      this.selection = null;
    }
    const changes: IssueChange[] = ["revision"];
    if (changed) changes.push("issues");
    if (hadSelection && this.selection === null) changes.push("selection");
    if (after.length === 0 && (this.end !== "none" || this.hasResult || this.notPlaced > 0)) {
      this.end = "none";
      this.hasResult = false;
      this.notPlaced = 0;
      if (!changed) changes.push("issues");
      changes.push("outcome");
    }
    this.emit(...changes);
  }

  /**
   * Counts a change of the text that is not an edit (a loaded text). A pending check can no longer
   * be rebased across it, so its result will be discarded.
   */
  bumpRevision(): number {
    this.currentRevision++;
    this.log.invalidate();
    this.emit("revision");
    return this.currentRevision;
  }

  /**
   * Replaces the issues with a merged list (step 10) and keeps the selection if that issue is
   * still there.
   */
  replaceIssues(issues: readonly TextIssue[]): void {
    this.current = issues;
    if (this.selection !== null && !this.visibleIssues.some((i) => i.id === this.selection)) {
      this.selection = null;
      this.emit("issues", "selection");
    } else this.emit("issues");
  }

  private toTextIssue(placed: CheckedIssue, text: string, manual: boolean): TextIssue {
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
      manual,
    };
  }

  private emit(...changes: IssueChange[]): void {
    for (const change of changes) {
      for (const listener of [...this.listeners]) listener(change);
    }
  }
}
