import type { AnalysisModel } from "../core/analysis";
import type { Scheduler } from "../core/clock";
import { AppError } from "../core/errors";
import {
  ExplanationController,
  IssueCounts,
  SelectedIssueHeader,
  type CountSource,
  type ExplanationRunner,
} from "../core/issues";
import type { Logger } from "../core/log";
import type { FrameMessage } from "../core/page-mode/protocol";
import type { LinkOpener } from "../platform/links";
import { el, setText } from "../ui/dom";
import { ExplanationPanel } from "../ui/explanation-panel";
import { LinkConfirm } from "../ui/link-confirm";
import type { BoxSession } from "./box-session";

/** What the popover needs of the statistics: `Stats` fits. */
export interface PopoverStats extends CountSource {
  /** Not an error (SPEC section 5.7): deletes the issue's events and adds its pair to the ignore set. */
  notAnError(source: string, fingerprint: string): Promise<unknown>;
}

/** What the frame needs of the popover. */
export interface PopoverHost {
  /**
   * Shows the explanation of `issueId` of the box's session in a card, or switches the card to
   * it. `maxHeight` is the room the card has. `send` takes the messages for the content script.
   */
  open(
    session: BoxSession,
    issueId: number,
    maxHeight: number,
    send: (message: FrameMessage) => void,
  ): void;
  /** Closes the popover (for this box only, when given); the explanation request is cancelled. */
  close(box?: number): void;
}

export interface PopoverDeps {
  doc: Document;
  /** The element the card goes in (the frame's body). */
  root: HTMLElement;
  scheduler: Scheduler;
  stats: PopoverStats;
  /** One explainer per text box: its cache lives as long as the check result does. */
  newExplainer(): ExplanationRunner;
  /** The LLM to explain with, read at the start of each request; undefined when none is set up. */
  getModel(): AnalysisModel | undefined;
  links: LinkOpener;
  /** Announces `stats-changed` to the other pages after a Not an error. */
  statsChanged(): void;
  log: Logger;
}

/** The popover that is open: its session and the pieces that follow the session's issue state. */
interface Current {
  readonly session: BoxSession;
  readonly send: (message: FrameMessage) => void;
  issueId: number;
  readonly controller: ExplanationController;
  readonly counts: IssueCounts;
  readonly header: SelectedIssueHeader;
  readonly unsubscribe: () => void;
}

/**
 * The card of the explanation popover (SPEC section 4.11), drawn in the frame (`page-ui.html`)
 * because the explanation is the LLM's text, which only this extension page may hold. It shows
 * the shared explanation panel in its compact layout for the issue the content script asked
 * for, with **Not an error**, **Regenerate** / **Retry** and **All issues**. The content script
 * decides where the card is and how high its frame is; the card reports its height after every
 * change (`popover-size`).
 *
 * Selecting the issue in the session's `IssueState` starts the explanation (an
 * `ExplanationController` for the card's lifetime), so the rules of SPEC section 4.5 hold here too:
 * a request is cached per check result, an edit that removes the issue ends it, and a request that
 * is replaced or cancelled is ignored when it answers late. Closing the card cancels the request.
 * Links in the explanation ask for confirmation first and open in a new tab.
 *
 * It never takes the focus: a press on a button is not allowed to move it out of the text box.
 */
export class Popover implements PopoverHost {
  private readonly deps: PopoverDeps;
  private readonly card: HTMLElement;
  private readonly error: HTMLElement;
  private readonly body: HTMLElement;
  private readonly allIssues: HTMLButtonElement;
  private readonly linkConfirm: LinkConfirm;
  private readonly explainers = new WeakMap<
    BoxSession,
    { explainer: ExplanationRunner; checkId: number }
  >();
  private current: Current | undefined;
  private panel: ExplanationPanel | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private lastHeight: number | undefined;

  constructor(deps: PopoverDeps) {
    this.deps = deps;
    const { doc } = deps;
    this.error = el(doc, "p", { class: "popover-error", id: "popover-error", role: "alert" });
    this.error.hidden = true;
    this.body = el(doc, "div", { class: "explanation popover-body", id: "popover-body" });
    this.allIssues = el(doc, "button", { type: "button", id: "popover-all-issues" }, [
      "All issues",
    ]);
    this.card = el(doc, "div", { class: "popover", id: "popover", role: "dialog" }, [
      this.error,
      this.body,
    ]);
    this.card.setAttribute("aria-label", "Explanation");
    this.card.hidden = true;
    deps.root.append(this.card);
    this.linkConfirm = new LinkConfirm(doc, deps.root);

    // A press on a button must not take the focus from the text box (SPEC section 4.11): the
    // click still happens. A press in the explanation's text may focus it, as the user asked.
    this.card.addEventListener("mousedown", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("button") !== null) event.preventDefault();
    });
    doc.addEventListener("keydown", (event) => {
      if (event.isTrusted && event.key === "Escape" && this.current !== undefined) {
        event.preventDefault();
        this.closeByFrame();
      }
    });
    if (typeof deps.doc.defaultView?.ResizeObserver === "function") {
      this.resizeObserver = new deps.doc.defaultView.ResizeObserver(() => {
        this.report();
      });
      this.resizeObserver.observe(this.card);
    }
  }

  /** The id of the issue the card shows, or undefined when it is closed. */
  get issue(): number | undefined {
    return this.current?.issueId;
  }

  /** The box the card is open for, or undefined. */
  get box(): number | undefined {
    return this.current?.session.id;
  }

  open(
    session: BoxSession,
    issueId: number,
    maxHeight: number,
    send: (message: FrameMessage) => void,
  ): void {
    this.card.style.setProperty("max-height", `${String(maxHeight)}px`);
    const now = this.current;
    if (now?.session === session && now.issueId === issueId) {
      // The same card: only its room may have changed.
      this.report();
      return;
    }
    this.teardown();
    const { state } = session;
    if (!state.issues.some((issue) => issue.id === issueId)) {
      // The issue is gone already (an edit, a new result): there is nothing to show.
      send({ type: "popover-closed", box: session.id });
      return;
    }
    setText(this.error, "");
    this.error.hidden = true;

    const panel = new ExplanationPanel(
      this.deps.doc,
      this.body,
      {
        // The panel's idle hint is never shown here: the card exists only for a selected issue.
        openOptions: () => undefined,
        openLink: (url) => {
          this.openLink(url);
        },
        scheduler: this.deps.scheduler,
      },
      { layout: "compact" },
    );
    panel.actionRow.append(this.allIssues);
    this.panel = panel;
    const counts = new IssueCounts(state, this.deps.stats, (err) => {
      this.deps.log.error("the popover could not read the mistake counts", { err });
    });
    const header = new SelectedIssueHeader(state, counts, panel);
    let record = this.explainers.get(session);
    if (record === undefined) {
      record = { explainer: this.deps.newExplainer(), checkId: state.checkId };
      this.explainers.set(session, record);
    } else if (record.checkId !== state.checkId) {
      // A new check result: the cached explanations are for issues that are gone.
      record.explainer.reset();
      record.checkId = state.checkId;
    }
    const controller = new ExplanationController({
      state,
      explainer: record.explainer,
      view: panel,
      getModel: () => this.deps.getModel(),
      getText: () => session.text,
      log: this.deps.log,
    });
    // The card goes with its issue: a new check result, an edit or Not an error deselects it.
    const unsubscribe = state.subscribe((change) => {
      if (change === "selection" && state.selectedId === null) this.closeByFrame();
    });
    this.current = { session, send, issueId, controller, counts, header, unsubscribe };
    panel.notErrorButton.addEventListener("click", () => {
      this.notAnError();
    });
    this.allIssues.onclick = () => {
      send({ type: "all-issues", box: session.id });
    };
    this.card.hidden = false;
    state.select(issueId);
    if (state.selectedId !== issueId) {
      this.closeByFrame();
      return;
    }
    this.report();
  }

  close(box?: number): void {
    if (this.current === undefined) return;
    if (box !== undefined && this.current.session.id !== box) return;
    this.teardown();
  }

  /** Closes the card and tells the content script (Escape in the card, an issue that is gone). */
  private closeByFrame(): void {
    const now = this.current;
    if (now === undefined) return;
    this.teardown();
    now.send({ type: "popover-closed", box: now.session.id });
  }

  private teardown(): void {
    const now = this.current;
    if (now === undefined) return;
    this.current = undefined;
    now.unsubscribe();
    now.controller.destroy();
    now.header.destroy();
    now.counts.destroy();
    this.linkConfirm.dismiss();
    this.card.classList.remove("popover-confirming");
    now.session.state.select(null);
    this.panel = undefined;
    this.body.replaceChildren();
    this.allIssues.onclick = null;
    this.card.hidden = true;
    this.lastHeight = undefined;
  }

  // Not an error (SPEC section 5.7): the issue's events are deleted and its pair goes into the
  // ignore set under the box's source, then its underline goes at once. A failure keeps the issue.
  private notAnError(): void {
    const now = this.current;
    const issue = now?.session.state.selected;
    if (now === undefined || issue === undefined) return;
    this.deps.stats.notAnError(now.session.source, issue.fingerprint).then(
      () => {
        now.session.state.removeIssue(issue.id);
        this.deps.statsChanged();
        // `removeIssue` deselects, which closes the card; this covers a card that moved on.
        if (this.current === now) this.closeByFrame();
      },
      (err: unknown) => {
        // `Stats` reports an `AppError` (`StatsResetFailed`). Anything else is shown without its
        // own text, which could hold something the user wrote.
        const error = err instanceof AppError ? err : AppError.wrap("StatsResetFailed", err);
        this.deps.log.error("Not an error failed", { err: error.via("Popover.notAnError") });
        if (this.current !== now) return;
        setText(
          this.error,
          err instanceof AppError ? err.message : "The change could not be saved.",
        );
        this.error.hidden = false;
        this.report();
      },
    );
  }

  private openLink(url: string): void {
    // The confirmation needs room: the card grows while it is open.
    this.card.classList.add("popover-confirming");
    this.linkConfirm
      .ask(url)
      .then((confirmed) => {
        this.card.classList.remove("popover-confirming");
        return confirmed ? this.deps.links.open(url) : undefined;
      })
      .catch((err: unknown) => {
        this.card.classList.remove("popover-confirming");
        this.deps.log.error("the link could not be opened", { err });
      });
  }

  /** Tells the content script how high the card is, when that changed. */
  private report(): void {
    const now = this.current;
    if (now === undefined) return;
    const height = Math.ceil(this.card.getBoundingClientRect().height);
    if (height === 0 || height === this.lastHeight) return;
    this.lastHeight = height;
    now.send({ type: "popover-size", box: now.session.id, issue: now.issueId, height });
  }

  /** The state of the explanation panel in the card (for tests). */
  get panelState(): string | undefined {
    return this.panel?.state;
  }
}
