import type { AnalysisModel, CheckOptions, CheckResult } from "../analysis";
import { AppError } from "../errors";
import { isCancelled, type Usage } from "../llm";
import type { Logger } from "../log";
import { rebaseRangeAcross, type Edit, type Ranged } from "./edits";
import type { IssueState } from "./state";

/** What the controller needs from the analyzer. `Analyzer` fits. */
export interface CheckRunner {
  check(model: AnalysisModel, text: string, options?: CheckOptions): Promise<CheckResult>;
}

export interface CheckControllerDeps {
  state: IssueState;
  runner: CheckRunner;
  /**
   * The LLM to check with, read at the start of each check; undefined when none is configured.
   * May throw an `AppError` (for example `LLMConfigInvalid`), which ends the check as failed.
   */
  getModel(): AnalysisModel | undefined;
  /** The text of the editor or text box now. */
  getText(): string;
  /** Called with the tokens of a check that ended with a result or was cancelled. */
  onUsage?(usage: Usage): void;
  log?: Logger;
}

/**
 * How a call to `check` ended. Only `failed` is an error to show; `cancelled`, `stale`, `busy`
 * and `no-llm` are normal and show no banner (SPEC section 5.1).
 */
export type CheckOutcome =
  | {
      kind: "finished";
      manual: boolean;
      /** The text that was checked: the snapshot the issues' offsets refer to. */
      text: string;
      result: CheckResult;
    }
  | { kind: "cancelled" }
  | { kind: "failed"; manual: boolean; error: AppError }
  /**
   * The result no longer applies: a newer check replaced this one, or the text changed in a way
   * the result cannot follow (too many edits, a loaded text, or an edit inside a checked
   * selection). The issues the state had stay.
   */
  | { kind: "stale" }
  /** An auto-check was refused because a check is running. Try again after the next pause. */
  | { kind: "busy" }
  | { kind: "no-llm" };

/**
 * Runs the checks of one text (SPEC section 5.1): takes the snapshot of the text and the
 * revision, lets one check run at a time, cancels, tells manual checks from auto-checks, and
 * puts the result in the `IssueState`. It knows nothing about the tutor page, so page mode
 * (steps 13 to 15) uses one per web text box.
 *
 * - A manual check cancels a running one. An auto-check does not: it is refused with `busy`.
 * - Cancelling leaves the issues as they were and is not an error.
 * - A failed check keeps the old issues. The error is in the outcome (route
 *   `CheckController.check->Analyzer.check->...->Tag`).
 * - A result is applied only if its check is still the pending one. If the text was edited
 *   meanwhile, the result is rebased across the edits the state logged (SPEC section 5.5); it is
 *   discarded as `stale` only when the log overflowed, a text was loaded, or (for a selection
 *   check) an edit touched the checked range.
 */
export class CheckController {
  private readonly deps: CheckControllerDeps;
  private controller: AbortController | undefined;

  constructor(deps: CheckControllerDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.deps.state.pending !== null;
  }

  /** Cancels the running check, if any. Its `check` call resolves with `cancelled`. */
  cancel(): void {
    this.controller?.abort();
  }

  /**
   * `selection` is the range a check of a selection covers (step 10 sends only that text): an
   * edit that touches it while the check runs discards the result.
   */
  async check(options: { manual: boolean; selection?: Ranged }): Promise<CheckOutcome> {
    const { state } = this.deps;
    const { manual, selection } = options;
    if (state.pending !== null && !manual) return { kind: "busy" };

    let model: AnalysisModel | undefined;
    try {
      model = this.deps.getModel();
    } catch (err) {
      state.endCheck("failed");
      return this.failed(err, manual);
    }
    if (model === undefined) return { kind: "no-llm" };

    // A manual check replaces a running one: the older check ends as `stale` without touching
    // the state, because it is no longer the pending one.
    this.cancel();
    const text = this.deps.getText();
    const controller = new AbortController();
    this.controller = controller;
    const pending = state.beginCheck(manual);

    let result: CheckResult;
    try {
      result = await this.deps.runner.check(model, text, { signal: controller.signal });
    } catch (err) {
      if (state.pending?.id !== pending.id) return { kind: "stale" };
      if (controller.signal.aborted || isCancelled(err, controller.signal)) {
        state.endCheck("cancelled");
        return { kind: "cancelled" };
      }
      state.endCheck("failed");
      return this.failed(err, manual);
    }

    if (state.pending?.id !== pending.id) return { kind: "stale" };
    if (result.cancelled || controller.signal.aborted) {
      state.endCheck("cancelled");
      this.reportUsage(result.usage);
      return { kind: "cancelled" };
    }
    let edits: readonly Edit[] = [];
    if (state.revision !== pending.revision) {
      // The text changed while the check ran: rebase the result across the edits.
      const logged = state.editsDuringCheck;
      if (
        logged === undefined ||
        (selection !== undefined && rebaseRangeAcross(selection, logged) === null)
      ) {
        state.discardCheck();
        this.reportUsage(result.usage);
        return { kind: "stale" };
      }
      edits = logged;
    }
    state.finishCheck(result.placed, text, result.unplaced, edits);
    this.reportUsage(result.usage);
    return { kind: "finished", manual, text, result };
  }

  private failed(err: unknown, manual: boolean): CheckOutcome {
    const error = (err instanceof AppError ? err : AppError.wrap("LLMCallFailed", err)).via(
      "CheckController.check",
    );
    this.deps.log?.error("check failed", { err: error });
    return { kind: "failed", manual, error };
  }

  private reportUsage(usage: Usage): void {
    this.deps.onUsage?.(usage);
  }
}
