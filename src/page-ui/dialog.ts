import type { AnalysisModel } from "../core/analysis";
import type { Scheduler } from "../core/clock";
import { AppError } from "../core/errors";
import {
  checkStatusText,
  ExplanationController,
  IssueCounts,
  SelectedIssueHeader,
  type CountSource,
} from "../core/issues";
import type { Logger } from "../core/log";
import type { FrameMessage } from "../core/page-mode/protocol";
import type { LinkOpener } from "../platform/links";
import type { FrameActions } from "../platform/page-mode";
import { el, setText } from "../ui/dom";
import { ExplanationPanel } from "../ui/explanation-panel";
import { IssuesList } from "../ui/issues-list";
import { LinkConfirm } from "../ui/link-confirm";
import type { BoxSession } from "./box-session";
import type { BoxExplainers } from "./explainers";

/** What the dialog needs of the statistics: `Stats` fits. */
export interface DialogStats extends CountSource {
  /** Not an error (SPEC section 5.7): deletes the issue's events and adds its pair to the ignore set. */
  notAnError(source: string, fingerprint: string): Promise<unknown>;
}

/** What the frame needs of the dialog. */
export interface DialogHost {
  /**
   * Shows the issues dialog for the box's session, or replaces the one that is open, with
   * `issueId` selected in its list (null: none). `send` takes the messages for the content script.
   */
  open(session: BoxSession, issueId: number | null, send: (message: FrameMessage) => void): void;
  /** Closes the dialog (for this box only, when given); nothing is sent to the content script. */
  close(box?: number): void;
}

export interface DialogDeps {
  doc: Document;
  /** The element the dialog goes in (the frame's body). */
  root: HTMLElement;
  scheduler: Scheduler;
  stats: DialogStats;
  /** One explainer per text box, shared with the popover. */
  explainers: Pick<BoxExplainers, "of">;
  settings: {
    /** The LLM to check and explain with; undefined when none is set up. */
    getModel(): AnalysisModel | undefined;
    /** Called after each read of the settings. Returns the remover. */
    subscribe(listener: () => void): () => void;
  };
  links: LinkOpener;
  /** The confirmation before a link opens; the popover and the dialog share one. */
  linkConfirm?: LinkConfirm;
  /** Open in English Tutor and the options link: both go through the background script. */
  actions: FrameActions;
  /** Announces `stats-changed` to the other pages after a Not an error. */
  statsChanged(): void;
  /** Another page announced `stats-changed`. Returns the remover. */
  onStatsChanged(listener: () => void): () => void;
  log: Logger;
}

/** The dialog that is open: its session and the pieces that follow the session's issue state. */
interface Current {
  readonly session: BoxSession;
  readonly send: (message: FrameMessage) => void;
  readonly list: IssuesList;
  readonly panel: ExplanationPanel;
  readonly controller: ExplanationController;
  readonly counts: IssueCounts;
  readonly header: SelectedIssueHeader;
  readonly stops: (() => void)[];
}

/**
 * The issues dialog of page mode (SPEC section 4.11), drawn in the frame (`page-ui.html`) because
 * it holds the LLM's text. The content script decides where its `<iframe>` is and how big (about
 * 440 by 520 CSS pixels); the dialog fills it.
 *
 * It has the shared issues list (SPEC section 4.4) on top and the shared explanation panel (SPEC
 * section 4.5, compact layout) below it for the selected issue, and the buttons **Check** (a
 * recorded manual check, which becomes **Cancel** while it runs), **Not an error** (in the
 * panel), **Open in English Tutor** and **Close**. The legend toggles of SPEC section 4.3 are not
 * part of page mode. Selecting a row selects the issue in the box's `IssueState`, which starts its
 * explanation, and is reported to the content script (`dialog-select`) to be highlighted and
 * scrolled to in the box. With no LLM the panel shows its no-LLM hint, whose link opens the
 * options page through the background script, and Check is disabled.
 *
 * Like the popover it never takes the focus by itself, and a press on one of its buttons does not
 * take the focus from the text box.
 */
export class Dialog implements DialogHost {
  private readonly deps: DialogDeps;
  private readonly card: HTMLElement;
  private readonly issuesHost: HTMLElement;
  private readonly explanationHost: HTMLElement;
  private readonly error: HTMLElement;
  private readonly status: HTMLElement;
  private readonly checkButton: HTMLButtonElement;
  private readonly openTutorButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly linkConfirm: LinkConfirm;
  private current: Current | undefined;
  /** A failure of an action (recording, Not an error, Open in English Tutor), shown until the next one. */
  private notice: string | undefined;

  constructor(deps: DialogDeps) {
    this.deps = deps;
    const { doc } = deps;
    this.issuesHost = el(doc, "div", { class: "dialog-issues", id: "dialog-issues" });
    this.explanationHost = el(doc, "div", {
      class: "explanation dialog-explanation",
      id: "dialog-explanation",
    });
    this.error = el(doc, "p", { class: "dialog-error", id: "dialog-error", role: "alert" });
    this.error.hidden = true;
    this.status = el(doc, "span", { class: "dialog-status", id: "dialog-status", role: "status" });
    this.checkButton = el(doc, "button", { type: "button", class: "primary", id: "dialog-check" }, [
      "Check",
    ]);
    this.openTutorButton = el(doc, "button", { type: "button", id: "dialog-open-tutor" }, [
      "Open in English Tutor",
    ]);
    this.closeButton = el(doc, "button", { type: "button", id: "dialog-close" }, ["Close"]);
    const footer = el(doc, "div", { class: "dialog-footer" }, [
      this.status,
      el(doc, "div", { class: "dialog-buttons" }, [
        this.checkButton,
        this.openTutorButton,
        this.closeButton,
      ]),
    ]);
    this.card = el(doc, "div", { class: "dialog", id: "dialog", role: "dialog" }, [
      this.issuesHost,
      this.explanationHost,
      this.error,
      footer,
    ]);
    this.card.setAttribute("aria-label", "Issues");
    this.card.hidden = true;
    deps.root.append(this.card);
    this.linkConfirm = deps.linkConfirm ?? new LinkConfirm(doc, deps.root);

    // A press on a button must not take the focus from the text box (SPEC section 4.11): the
    // click still happens. A press on a row of the list or on the explanation's text may focus it.
    this.card.addEventListener("mousedown", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("button") !== null) event.preventDefault();
    });
    this.checkButton.addEventListener("click", () => {
      this.toggleCheck();
    });
    this.openTutorButton.addEventListener("click", () => {
      this.openInTutor();
    });
    this.closeButton.addEventListener("click", () => {
      this.closeByFrame();
    });
    doc.addEventListener("keydown", (event) => {
      if (event.isTrusted && event.key === "Escape" && this.current !== undefined) {
        event.preventDefault();
        this.closeByFrame();
      }
    });
  }

  /** The box the dialog is open for, or undefined. */
  get box(): number | undefined {
    return this.current?.session.id;
  }

  /** The state of the explanation panel in the dialog (for tests). */
  get panelState(): string | undefined {
    return this.current?.panel.state;
  }

  open(session: BoxSession, issueId: number | null, send: (message: FrameMessage) => void): void {
    this.teardown();
    const { deps } = this;
    const { state } = session;
    this.notice = undefined;

    const counts = new IssueCounts(state, deps.stats, (err) => {
      deps.log.error("the dialog could not read the mistake counts", { err });
    });
    const list = new IssuesList(deps.doc, this.issuesHost, state, { counts });
    const panel = new ExplanationPanel(
      deps.doc,
      this.explanationHost,
      {
        // The no-LLM hint's link: the frame has no `runtime.openOptionsPage`.
        openOptions: () => {
          this.openOptions();
        },
        openLink: (url) => {
          this.openLink(url);
        },
        scheduler: deps.scheduler,
      },
      { layout: "compact" },
    );
    const header = new SelectedIssueHeader(state, counts, panel);
    const controller = new ExplanationController({
      state,
      explainer: deps.explainers.of(session),
      view: panel,
      getModel: () => deps.settings.getModel(),
      getText: () => session.text,
      log: deps.log,
    });
    panel.notErrorButton.addEventListener("click", () => {
      this.notAnError();
    });
    const now: Current = { session, send, list, panel, controller, counts, header, stops: [] };
    this.current = now;
    now.stops.push(
      state.subscribe((change) => {
        // The content script highlights the selected issue in the box and scrolls to it.
        if (change === "selection")
          send({ type: "dialog-select", box: session.id, issue: state.selectedId });
        this.update();
      }),
      deps.settings.subscribe(() => {
        this.update();
      }),
      deps.onStatsChanged(() => {
        this.refreshCounts();
      }),
    );
    this.card.hidden = false;
    this.update();
    if (issueId !== null && state.issues.some((issue) => issue.id === issueId)) {
      state.select(issueId);
    }
    this.refreshCounts();
    send({ type: "dialog-ready", box: session.id });
  }

  close(box?: number): void {
    if (this.current === undefined) return;
    if (box !== undefined && this.current.session.id !== box) return;
    this.teardown();
  }

  /** Closes the dialog and tells the content script (Close, Escape in the dialog). */
  private closeByFrame(): void {
    const now = this.current;
    if (now === undefined) return;
    this.teardown();
    now.send({ type: "dialog-closed", box: now.session.id });
  }

  private teardown(): void {
    const now = this.current;
    if (now === undefined) return;
    this.current = undefined;
    for (const stop of now.stops) stop();
    now.controller.destroy();
    now.header.destroy();
    now.list.destroy();
    now.counts.destroy();
    this.linkConfirm.dismiss();
    now.session.state.select(null);
    this.issuesHost.replaceChildren();
    this.explanationHost.replaceChildren();
    this.card.hidden = true;
    this.notice = undefined;
  }

  // The footer: Check / Cancel, the status line and the error line.

  private hasLLM(): boolean {
    try {
      return this.deps.settings.getModel() !== undefined;
    } catch {
      // A model that cannot be made is reported by the check itself.
      return true;
    }
  }

  /** Brings the buttons, the status line and the error line in step with the session. */
  private update(): void {
    const now = this.current;
    if (now === undefined) return;
    const { session } = now;
    const { state } = session;
    const checking = state.pending?.manual === true;
    const hasLLM = this.hasLLM();
    now.panel.setHasLLM(hasLLM);
    setText(this.checkButton, checking ? "Cancel" : "Check");
    this.checkButton.disabled = !checking && (!hasLLM || session.text.trim() === "");
    this.openTutorButton.disabled = session.text.trim() === "";
    setText(this.status, checkStatusText(state));
    const problem = session.statusNow();
    const message =
      this.notice ??
      (problem.status === "failed" || problem.status === "too-long" ? problem.message : undefined);
    setText(this.error, message ?? "");
    this.error.hidden = message === undefined;
  }

  private refreshCounts(): void {
    this.current?.counts.refresh().catch((err: unknown) => {
      this.deps.log.error("the dialog could not read the mistake counts", { err });
    });
  }

  /** Check, or Cancel while the dialog's own check runs. */
  private toggleCheck(): void {
    const now = this.current;
    if (now === undefined) return;
    if (now.session.state.pending?.manual === true) {
      now.session.cancelCheck();
      return;
    }
    this.notice = undefined;
    now.session.checkManually().then(
      (end) => {
        if (this.current !== now) return;
        if (end.recordError !== undefined) this.notice = end.recordError.message;
        this.update();
        this.refreshCounts();
      },
      (err: unknown) => {
        this.deps.log.error("the check failed", { err });
      },
    );
    this.update();
  }

  // Not an error (SPEC section 5.7): the issue's events are deleted and its pair goes into the
  // ignore set under the box's source, then its underline and its row go at once. A failure keeps
  // the issue and shows its message.
  private notAnError(): void {
    const now = this.current;
    const issue = now?.session.state.selected;
    if (now === undefined || issue === undefined) return;
    this.notice = undefined;
    this.deps.stats.notAnError(now.session.source, issue.fingerprint).then(
      () => {
        now.session.state.removeIssue(issue.id);
        this.deps.statsChanged();
        if (this.current === now) this.refreshCounts();
      },
      (err: unknown) => {
        // `Stats` reports an `AppError` (`StatsResetFailed`). Anything else is shown without its
        // own text, which could hold something the user wrote.
        const error = err instanceof AppError ? err : AppError.wrap("StatsResetFailed", err);
        this.deps.log.error("Not an error failed", { err: error.via("Dialog.notAnError") });
        if (this.current !== now) return;
        this.notice = err instanceof AppError ? err.message : "The change could not be saved.";
        this.update();
      },
    );
  }

  // Open in English Tutor (SPEC section 4.1): the box's text goes to a new tutor tab. Nothing is
  // written back into the box.
  private openInTutor(): void {
    const now = this.current;
    if (now === undefined) return;
    this.notice = undefined;
    this.deps.actions.openInTutor(now.session.text).then(
      () => undefined,
      (err: unknown) => {
        this.failed(now, err, "Dialog.openInTutor");
      },
    );
  }

  private openOptions(): void {
    const now = this.current;
    this.deps.actions.openOptions().then(
      () => undefined,
      (err: unknown) => {
        if (now !== undefined) this.failed(now, err, "Dialog.openOptions");
      },
    );
  }

  private failed(now: Current, err: unknown, where: string): void {
    const error = AppError.wrap("PageDialogActionFailed", err).via(where);
    this.deps.log.error("the dialog could not reach the background script", { err: error });
    if (this.current !== now) return;
    this.notice = error.message;
    this.update();
  }

  private openLink(url: string): void {
    this.linkConfirm
      .ask(url)
      .then((confirmed) => (confirmed ? this.deps.links.open(url) : undefined))
      .catch((err: unknown) => {
        this.deps.log.error("the link could not be opened", { err });
      });
  }
}
