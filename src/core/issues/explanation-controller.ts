import { categoryLabel, type AnalysisModel, type ExplainRequest } from "../analysis";
import type { ExplainOptions, ExplainResult } from "../analysis";
import { AppError } from "../errors";
import { isCancelled } from "../llm";
import type { Logger } from "../log";
import type { IssueState, TextIssue } from "./state";

/** The message of the failed state when an issue is selected and no LLM is configured (SPEC 4.5). */
export const NO_LLM_EXPLANATION_MESSAGE =
  "No LLM is configured. Add one in Preferences to get explanations.";

/** What the panel shows about the issue while it loads: the faulty words and the type. */
export interface ExplanationTarget {
  /** The error type's label, for the header line ("Subject-verb agreement"). */
  readonly label: string;
  /** The category's label ("Grammar"). */
  readonly categoryLabel: string;
  /** The faulty words as they were checked. */
  readonly snippet: string;
}

/** What the buttons of the panel ask for. */
export type ExplanationAction = "cancel" | "regenerate" | "retry";

/**
 * What the controller needs from the explanation panel (`src/ui/ExplanationPanel` implements it),
 * so that the controller has no DOM and the tutor page, the page-mode popover and the dialog can
 * share it.
 */
export interface ExplanationView {
  showIdle(): void;
  /** A request starts for this issue; any earlier text goes. */
  showLoading(target: ExplanationTarget): void;
  /** A piece of the streamed text (one call with the whole text for a cached explanation). */
  appendText(chunk: string): void;
  /** The request ended with this final text (thinking removed), to render again. */
  showReady(markdown: string): void;
  showFailed(message: string): void;
  showCancelled(): void;
  /** The panel calls this when the user presses Cancel, Regenerate or Retry. */
  setActionHandler(handler: ((action: ExplanationAction) => void) | undefined): void;
}

/** What the controller needs from the explainer. `Explainer` fits. */
export interface ExplanationRunner {
  explain(
    model: AnalysisModel,
    request: ExplainRequest,
    options?: ExplainOptions,
  ): Promise<ExplainResult>;
  cancel(): void;
  reset(): void;
}

export interface ExplanationControllerDeps {
  state: IssueState;
  explainer: ExplanationRunner;
  view: ExplanationView;
  /** The LLM to explain with, read at the start of each request; undefined when none is configured. */
  getModel(): AnalysisModel | undefined;
  /** The text of the editor or text box now. */
  getText(): string;
  log?: Logger;
}

/**
 * Connects the issue selection to the explanation panel (SPEC sections 4.5 and 5.4): selecting an
 * issue starts its explanation (or shows the cached one), and selecting nothing, removing the
 * selected issue by an edit, or a new check result cancels the running request and returns the
 * panel to idle. A new check result also empties the explainer's cache. A result that arrives
 * after its request was cancelled or replaced is ignored. Usage is recorded by the explainer.
 *
 * It knows nothing about the DOM or the page, so page mode uses one per text box.
 */
export class ExplanationController {
  private readonly deps: ExplanationControllerDeps;
  private readonly unsubscribe: () => void;
  /** Counts requests; a result belongs to the latest one only if it still has the same number. */
  private run = 0;
  private abort: AbortController | undefined;
  private running = false;
  /** Whether the panel shows its idle hint (it starts so), to tell it only once. */
  private idle = true;
  private current: TextIssue | undefined;
  private checkId: number;

  constructor(deps: ExplanationControllerDeps) {
    this.deps = deps;
    this.checkId = deps.state.checkId;
    deps.view.setActionHandler((action) => {
      this.act(action);
    });
    this.unsubscribe = deps.state.subscribe((change) => {
      if (change === "issues") this.onIssues();
      else if (change === "selection") this.onSelection();
    });
  }

  destroy(): void {
    this.unsubscribe();
    this.deps.view.setActionHandler(undefined);
    this.stop();
  }

  /** True while a request runs. */
  get busy(): boolean {
    return this.running;
  }

  /** The user pressed Cancel: the request is cancelled and the panel says so. */
  cancel(): void {
    if (!this.running) return;
    this.stop();
    this.deps.view.showCancelled();
  }

  /** Asks again, skipping the cache (Regenerate, from the ready and cancelled states). */
  regenerate(): void {
    if (this.current !== undefined) this.start(this.current, true);
  }

  /** Asks again after a failure. */
  retry(): void {
    if (this.current !== undefined) this.start(this.current, false);
  }

  private act(action: ExplanationAction): void {
    if (action === "cancel") this.cancel();
    else if (action === "regenerate") this.regenerate();
    else this.retry();
  }

  /** Cancels the running request, if any, and makes its result late. */
  private stop(): void {
    this.run++;
    this.running = false;
    this.abort?.abort();
    this.abort = undefined;
    this.deps.explainer.cancel();
  }

  private goIdle(): void {
    this.stop();
    this.current = undefined;
    if (this.idle) return;
    this.idle = true;
    this.deps.view.showIdle();
  }

  private onIssues(): void {
    const { state, explainer } = this.deps;
    if (state.checkId === this.checkId) return;
    // A new check result (or a loaded text): the issue ids no longer mean what the keys say.
    this.checkId = state.checkId;
    explainer.reset();
    this.goIdle();
  }

  private onSelection(): void {
    const issue = this.deps.state.selected;
    if (issue === undefined) this.goIdle();
    else this.start(issue, false);
  }

  private start(issue: TextIssue, regenerate: boolean): void {
    const { state, explainer, view } = this.deps;
    this.stop();
    const run = this.run;
    this.current = issue;
    this.idle = false;
    view.showLoading({
      label: issue.type.label,
      categoryLabel: categoryLabel(issue.category),
      snippet: issue.snippet,
    });

    let model: AnalysisModel | undefined;
    try {
      model = this.deps.getModel();
    } catch (err) {
      this.fail(err);
      return;
    }
    if (model === undefined) {
      view.showFailed(NO_LLM_EXPLANATION_MESSAGE);
      return;
    }

    const controller = new AbortController();
    this.abort = controller;
    this.running = true;
    const request: ExplainRequest = {
      key: `${String(state.checkId)}:${String(issue.id)}`,
      regenerate,
      text: this.deps.getText(),
      start: issue.start,
      end: issue.end,
      issue: issue.issue,
    };
    explainer
      .explain(model, request, {
        signal: controller.signal,
        onText: (chunk) => {
          if (run === this.run) view.appendText(chunk);
        },
      })
      .then(
        (result) => {
          if (run !== this.run) return;
          this.running = false;
          if (result.cancelled) view.showCancelled();
          else view.showReady(result.markdown);
        },
        (err: unknown) => {
          if (run !== this.run) return;
          this.running = false;
          if (isCancelled(err, controller.signal)) view.showCancelled();
          else this.fail(err);
        },
      );
  }

  private fail(err: unknown): void {
    const error = (err instanceof AppError ? err : AppError.wrap("LLMCallFailed", err)).via(
      "ExplanationController.start",
    );
    this.deps.log?.error("explanation failed", { err: error });
    this.deps.view.showFailed(error.message);
  }
}
