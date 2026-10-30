import { countWords, type AnalysisModel } from "../core/analysis";
import type { Clock, Scheduler } from "../core/clock";
import { AppError } from "../core/errors";
import type { Logger } from "../core/log";
import {
  AutoCheck,
  CheckController,
  IssueState,
  TrackedText,
  type CheckOutcome,
  type CheckRunner,
} from "../core/issues";
import type { MistakeInput } from "../core/store";
import {
  applyEditMessage,
  MAX_WORDS,
  MIN_WORDS,
  type BoxStatus,
  type FrameMessage,
} from "../core/page-mode/protocol";

/** What a manual check records (SPEC section 5.7): `Stats` and the channel fit. */
export interface MistakeRecorder {
  /** Records the mistakes of a manual check under `source`; resolves with how many were new. */
  record(source: string, llmName: string, mistakes: MistakeInput[]): Promise<{ inserted: number }>;
  /** Announces `stats-changed` to the other pages. */
  changed(): void;
}

/** How a manual check ended, for the dialog: only what the box's own status does not say. */
export interface ManualEnd {
  /** The mistakes could not be recorded (`ErrorEventSaveFailed`); the issues are shown anyway. */
  recordError?: AppError;
  /** The text is over the limit: nothing was sent. */
  tooLong?: boolean;
}

export const NO_LLM_MESSAGE = "No LLM is configured. Add one in Preferences to start checking.";
export const TOO_LONG_MESSAGE = "This text has more than 10,000 words, so it is not checked.";

export interface BoxSessionDeps {
  clock: Clock;
  scheduler: Scheduler;
  runner: CheckRunner;
  /** The pause of the automatic check and the LLM, read each time they are needed. */
  settings: { readonly delaySeconds: number; getModel(): AnalysisModel | undefined };
  log: Logger;
  /** Sends a message to the content script. */
  send(message: FrameMessage): void;
  /** Records the mistakes of the dialog's manual checks. Automatic checks are never recorded. */
  recorder: MistakeRecorder;
}

/** What the frame holds for one text box of the page (SPEC section 4.11). */
export class BoxSession {
  /** The box's issues, selection and pending check (the same object the tutor page uses). */
  readonly state: IssueState;
  readonly id: number;
  /** The `session:<uuid>` source the content script made; the dialog's checks record under it. */
  readonly source: string;
  private readonly deps: BoxSessionDeps;
  private readonly tracked: TrackedText;
  private readonly controller: CheckController;
  private readonly autoCheck: AutoCheck;
  private revision: number;
  private focused = false;
  private problem: { status: BoxStatus; message: string } | undefined;
  private resyncing = false;
  private disposed = false;
  private sendQueued = false;
  private readonly unsubscribe: () => void;

  constructor(deps: BoxSessionDeps, id: number, source: string, text: string, revision: number) {
    this.deps = deps;
    this.id = id;
    this.source = source;
    this.revision = revision;
    this.state = new IssueState(deps.clock);
    this.tracked = new TrackedText(this.state, text);
    this.controller = new CheckController({
      state: this.state,
      runner: deps.runner,
      getModel: () => deps.settings.getModel(),
      getText: () => this.tracked.text,
      log: deps.log,
    });
    this.autoCheck = new AutoCheck({
      scheduler: deps.scheduler,
      // Only the focused text box is checked, and always (the editor's Auto-check box is for the tutor page).
      enabled: () => this.focused,
      delaySeconds: () => deps.settings.delaySeconds,
      busy: () => this.state.pending !== null,
      canCheck: () => countWords(this.tracked.text) >= MIN_WORDS,
      start: () => {
        void this.run(false);
      },
    });
    // Whatever changes the state, the content script hears about it once per turn.
    this.unsubscribe = this.state.subscribe(() => {
      this.queueState();
    });
  }

  get text(): string {
    return this.tracked.text;
  }

  get wireRevision(): number {
    return this.revision;
  }

  /** The state of the box as the content script needs it. */
  statusNow(): { status: BoxStatus; message?: string } {
    if (this.state.pending !== null) return { status: "checking" };
    if (this.problem !== undefined) return this.problem;
    return { status: this.state.checked ? "checked" : "idle" };
  }

  /**
   * The box got the focus. If the text is not what the frame has, the content script's edit
   * messages are missing, so the frame asks for the whole text. A text with enough words that has
   * no result yet is checked at once (not recorded).
   */
  focus(revision: number, text: string): void {
    this.focused = true;
    if (revision !== this.revision || text !== this.tracked.text) {
      // The content script's numbering and text win: what the frame had cannot be rebased.
      this.setText(revision, text);
    }
    if (this.state.checked || this.state.pending !== null) {
      this.sendState();
      return;
    }
    if (countWords(this.tracked.text) >= MIN_WORDS) void this.run(false);
    else this.sendState();
  }

  blur(): void {
    this.focused = false;
    this.autoCheck.stop();
  }

  /**
   * An edit from the content script (SPEC section 5.5). The revision must be the next one; a gap
   * means a message was lost, and the frame asks for the whole text.
   */
  edit(message: { revision: number; start: number; removed: number; inserted: string }): void {
    if (message.revision <= this.revision) return;
    if (message.revision !== this.revision + 1 || this.resyncing) {
      this.requestText();
      return;
    }
    const text = applyEditMessage(this.tracked.text, message);
    if (text === undefined) {
      this.requestText();
      return;
    }
    this.revision = message.revision;
    this.tracked.changed(text);
    this.autoCheck.edited();
    // Even if no issue moved, the content script must hear that the frame has this revision.
    this.sendState();
  }

  /** The whole text, after a request for it. */
  setText(revision: number, text: string): void {
    this.resyncing = false;
    this.revision = revision;
    this.problem = undefined;
    this.tracked.load(text);
    this.sendState();
  }

  dispose(): void {
    this.disposed = true;
    this.autoCheck.stop();
    this.controller.cancel();
    this.unsubscribe();
  }

  private requestText(): void {
    this.resyncing = true;
    this.deps.send({ type: "resync", box: this.id });
  }

  /**
   * The dialog's Check (SPEC section 4.11): a manual check of the whole text. It replaces a check
   * that runs (an automatic one), and records the placed issues of its result under the box's
   * source (SPEC section 5.7). Resolves when the check and its recording are over.
   */
  async checkManually(): Promise<ManualEnd> {
    return this.run(true);
  }

  /** Cancels the running check, whichever kind (the dialog's Cancel). */
  cancelCheck(): void {
    this.controller.cancel();
  }

  /** The state a check that ended with `outcome` leaves the badge in. */
  private settle(outcome: CheckOutcome): void {
    switch (outcome.kind) {
      case "failed":
        this.problem = { status: "failed", message: outcome.error.message };
        break;
      case "no-llm":
        this.problem = { status: "no-llm", message: NO_LLM_MESSAGE };
        break;
      case "finished":
      case "cancelled":
      case "stale":
      case "busy":
        break;
    }
  }

  /** A check of the text now. An automatic one is never recorded (SPEC section 4.11). */
  private async run(manual: boolean): Promise<ManualEnd> {
    const words = countWords(this.tracked.text);
    if (words > MAX_WORDS) {
      this.problem = { status: "too-long", message: TOO_LONG_MESSAGE };
      this.sendState();
      return { tooLong: true };
    }
    if (words < MIN_WORDS && !manual) return {};
    this.problem = undefined;
    // The LLM's name as it is when the check starts, as the tutor page does.
    let llmName = "";
    try {
      llmName = this.deps.settings.getModel()?.name ?? "";
    } catch {
      // The check reports a model that cannot be made.
    }
    const outcome = await this.controller.check({ manual });
    if (this.disposed) return {};
    this.settle(outcome);
    let end: ManualEnd = {};
    if (manual && outcome.kind === "finished") {
      end = await this.record(outcome, llmName);
      if (this.isGone()) return end;
    }
    this.sendState();
    return end;
  }

  private async record(
    outcome: Extract<CheckOutcome, { kind: "finished" }>,
    llmName: string,
  ): Promise<ManualEnd> {
    const mistakes = outcome.result.placed.map<MistakeInput>((p) => ({
      error_type: p.issue.type.id,
      category: p.issue.type.category,
      snippet: outcome.text.slice(p.start, p.end),
      fingerprint: p.fingerprint,
    }));
    try {
      const recorded = await this.deps.recorder.record(this.source, llmName, mistakes);
      if (recorded.inserted > 0) this.deps.recorder.changed();
      return {};
    } catch (err) {
      const recordError = AppError.wrap("ErrorEventSaveFailed", err).via("BoxSession.record");
      this.deps.log.error("the mistakes could not be recorded", { err: recordError });
      return { recordError };
    }
  }

  /** Whether the session was disposed (read again after an `await`, which narrowing does not follow). */
  private isGone(): boolean {
    return this.disposed;
  }

  private queueState(): void {
    if (this.sendQueued || this.disposed) return;
    this.sendQueued = true;
    queueMicrotask(() => {
      this.sendQueued = false;
      this.sendState();
    });
  }

  sendState(): void {
    if (this.disposed) return;
    const status = this.statusNow();
    this.deps.send({
      type: "state",
      box: this.id,
      revision: this.revision,
      status: status.status,
      ...(status.message === undefined ? {} : { message: status.message }),
      issues: this.state.issues.map((issue) => ({
        id: issue.id,
        start: issue.start,
        end: issue.end,
        category: issue.category,
      })),
    });
  }
}
