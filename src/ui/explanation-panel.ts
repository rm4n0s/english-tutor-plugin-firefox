import type { Scheduler } from "../core/clock";
import type {
  ExplanationAction,
  ExplanationTarget,
  ExplanationView,
} from "../core/issues/explanation-controller";
import { parseLinkTarget, renderMarkdown } from "../core/markdown";
import { el, setHidden, setText } from "./dom";

/** The idle text of the panel (SPEC section 4.5). */
export const IDLE_HINT =
  "Select an error in the list or an underlined error in the text to learn more";

/** A streaming explanation is drawn again at most this often (SPEC section 4.5). */
export const RENDER_INTERVAL_MS = 100;

/** How far from the end of the text still counts as being at the end, in CSS pixels. */
const AT_END_TOLERANCE = 8;

export interface ExplanationPanelDeps {
  /** Opens the options page. A page-mode frame cannot use a plain link for that. */
  openOptions(): void;
  /**
   * The user clicked a link in the explanation: `url` is a normalised `http` or `https` address.
   * The page asks for confirmation and opens it in a new tab; the panel never navigates.
   */
  openLink(url: string): void;
  /** Spaces out the redraws of a streaming explanation. */
  scheduler: Scheduler;
}

export interface ExplanationPanelOptions {
  /**
   * `normal` fills the tutor page's side column. `compact` is for the page-mode popover (about
   * 360 px wide): smaller text and padding, and buttons that wrap (SPEC section 4.11).
   */
  layout?: "normal" | "compact";
}

type Mode = "idle" | "loading" | "ready" | "failed" | "cancelled";

/**
 * The explanation panel (SPEC section 4.5). It shows one of five states: idle (the hint, or the
 * hint about a missing LLM), loading (the faulty words, the category, a busy indicator, Cancel,
 * and the text as it streams in), ready (the rendered explanation and Regenerate), failed (the
 * message and Retry) and cancelled ("Explanation cancelled." and Regenerate).
 *
 * It only draws what an `ExplanationController` tells it (`ExplanationView`), and reports the
 * button presses back through the action handler. The tutor page, the page-mode popover and the
 * issues dialog share it. The header line shows the error type's label; `setHeaderLine` replaces
 * it with the longer text of step 9 ("... you have made this mistake 7 times ..."), and
 * `notErrorButton` is the hidden slot of that step's **Not an error**.
 */
export class ExplanationPanel implements ExplanationView {
  private readonly doc: Document;
  private readonly host: HTMLElement;
  private readonly deps: ExplanationPanelDeps;
  private readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly target: HTMLElement;
  private readonly snippet: HTMLElement;
  private readonly category: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly body: HTMLElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly regenerateButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly notError: HTMLButtonElement;
  private hasLLM = true;
  private mode: Mode = "idle";
  private label = "";
  private headerLine: string | undefined;
  private handler: ((action: ExplanationAction) => void) | undefined;

  // The streamed text, and what the body shows of it.
  private text = "";
  private rendered: string | undefined;
  private dirty = false;
  private closeWindow: (() => void) | undefined;
  private following = true;

  constructor(
    doc: Document,
    host: HTMLElement,
    deps: ExplanationPanelDeps,
    options: ExplanationPanelOptions = {},
  ) {
    this.doc = doc;
    this.host = host;
    this.deps = deps;

    this.header = el(doc, "p", { class: "explain-header", id: "explain-header" });
    this.snippet = el(doc, "code", { class: "explain-snippet", id: "explain-snippet" });
    this.category = el(doc, "span", { class: "explain-category", id: "explain-category" });
    this.target = el(doc, "p", { class: "explain-target", id: "explain-target" }, [
      this.snippet,
      this.category,
    ]);
    this.cancelButton = el(doc, "button", { type: "button", id: "explain-cancel" }, ["Cancel"]);
    this.progress = el(
      doc,
      "div",
      { class: "explain-progress", id: "explain-progress", role: "status" },
      [
        el(doc, "span", { class: "spinner spinner-small", "aria-hidden": "true" }),
        el(doc, "span", { class: "explain-progress-text" }, ["Explaining..."]),
        this.cancelButton,
      ],
    );
    this.body = el(doc, "div", {
      class: "explain-body",
      id: "explain-body",
      tabindex: "0",
      role: "region",
      "aria-label": "Explanation text",
    });
    this.notError = el(doc, "button", { type: "button", id: "explain-not-error", hidden: true }, [
      "Not an error",
    ]);
    this.regenerateButton = el(doc, "button", { type: "button", id: "explain-regenerate" }, [
      "Regenerate",
    ]);
    this.retryButton = el(doc, "button", { type: "button", id: "explain-retry" }, ["Retry"]);
    const actions = el(doc, "div", { class: "explain-actions", id: "explain-actions" }, [
      this.notError,
      this.regenerateButton,
      this.retryButton,
    ]);
    this.root = el(
      doc,
      "div",
      {
        class: options.layout === "compact" ? "explain-panel explain-compact" : "explain-panel",
        id: "explain-panel",
      },
      [this.header, this.target, this.progress, this.body, actions],
    );

    this.cancelButton.addEventListener("click", () => {
      this.handler?.("cancel");
    });
    this.regenerateButton.addEventListener("click", () => {
      this.handler?.("regenerate");
    });
    this.retryButton.addEventListener("click", () => {
      this.handler?.("retry");
    });
    this.body.addEventListener("scroll", () => {
      this.following = this.atEnd();
    });
    this.body.addEventListener("click", (event) => {
      this.onBodyClick(event);
    });
    // A middle click would open the link without the confirmation.
    this.body.addEventListener("auxclick", (event) => {
      if (this.anchorOf(event) !== undefined) event.preventDefault();
    });

    this.render();
  }

  // The action buttons.

  setActionHandler(handler: ((action: ExplanationAction) => void) | undefined): void {
    this.handler = handler;
  }

  /** The hidden button for step 9's **Not an error**, shown in every state but idle. */
  get notErrorButton(): HTMLButtonElement {
    return this.notError;
  }

  // The states.

  /** Whether an LLM is configured. Without one the idle panel asks the user to add one. */
  setHasLLM(hasLLM: boolean): void {
    if (this.hasLLM === hasLLM) return;
    this.hasLLM = hasLLM;
    if (this.mode === "idle") this.render();
  }

  /** The state now. */
  get state(): Mode {
    return this.mode;
  }

  /**
   * Replaces the header line (the error type's label) with `text`, or restores the label with
   * undefined. Step 9 puts the counts text here.
   */
  setHeaderLine(text: string | undefined): void {
    this.headerLine = text;
    this.updateHeader();
  }

  showIdle(): void {
    this.reset();
    this.mode = "idle";
    this.render();
  }

  showLoading(target: ExplanationTarget): void {
    this.reset();
    this.mode = "loading";
    this.label = target.label;
    setText(this.snippet, target.snippet);
    setText(this.category, target.categoryLabel);
    this.render();
  }

  appendText(chunk: string): void {
    if (this.mode !== "loading") return;
    this.text += chunk;
    if (this.closeWindow !== undefined) {
      this.dirty = true;
      return;
    }
    // The first chunk, and the first after a quiet time, is drawn at once.
    this.drawText();
    this.openWindow();
  }

  showReady(markdown: string): void {
    this.endWindow();
    this.mode = "ready";
    this.text = markdown;
    this.render();
    // Drawn again from the final text: the thinking filter can hide only a closing tag's text
    // once the whole reply is known (SPEC section 6.2).
    this.drawText();
  }

  showFailed(message: string): void {
    this.endWindow();
    this.mode = "failed";
    this.showMessage(message, "alert");
    this.render();
  }

  showCancelled(): void {
    this.endWindow();
    this.mode = "cancelled";
    this.showMessage("Explanation cancelled.", "status");
    this.render();
  }

  // Drawing.

  private reset(): void {
    this.endWindow();
    this.text = "";
    this.rendered = undefined;
    this.following = true;
    this.body.replaceChildren();
    this.body.scrollTop = 0;
  }

  private endWindow(): void {
    this.closeWindow?.();
    this.closeWindow = undefined;
    this.dirty = false;
  }

  /** At most one redraw per interval: chunks that arrive meanwhile are drawn when it ends. */
  private openWindow(): void {
    this.closeWindow = this.deps.scheduler.after(RENDER_INTERVAL_MS, () => {
      this.closeWindow = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      this.drawText();
      this.openWindow();
    });
  }

  private atEnd(): boolean {
    const { scrollTop, clientHeight, scrollHeight } = this.body;
    return scrollTop + clientHeight >= scrollHeight - AT_END_TOLERANCE;
  }

  /** Draws the text as markdown, and keeps the end in view unless the user scrolled up. */
  private drawText(): void {
    const follow = this.following && this.rendered !== undefined && this.rendered !== this.text;
    this.body.replaceChildren(renderMarkdown(this.doc, this.text));
    this.rendered = this.text;
    if (follow) this.body.scrollTop = this.body.scrollHeight;
  }

  private showMessage(message: string, role: "alert" | "status"): void {
    const p = el(
      this.doc,
      "p",
      { class: role === "alert" ? "explain-message explain-error" : "explain-message", role },
      [message],
    );
    this.body.replaceChildren(p);
    this.body.scrollTop = 0;
    this.rendered = undefined;
  }

  private updateHeader(): void {
    setText(this.header, this.headerLine ?? this.label);
  }

  private render(): void {
    const { mode } = this;
    if (mode === "idle") {
      this.host.replaceChildren(this.idleHint());
      return;
    }
    this.root.dataset.state = mode;
    this.updateHeader();
    setHidden(this.target, mode !== "loading");
    setHidden(this.progress, mode !== "loading");
    setHidden(this.regenerateButton, mode !== "ready" && mode !== "cancelled");
    setHidden(this.retryButton, mode !== "failed");
    this.body.setAttribute("aria-busy", String(mode === "loading"));
    if (this.root.parentElement !== this.host || this.host.childNodes.length !== 1) {
      this.host.replaceChildren(this.root);
    }
  }

  private idleHint(): HTMLElement {
    const doc = this.doc;
    if (this.hasLLM) return el(doc, "p", { class: "empty", id: "explanation-hint" }, [IDLE_HINT]);
    const link = el(doc, "a", { href: "#", class: "options-link", id: "options-link" }, [
      "Preferences",
    ]);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.deps.openOptions();
    });
    return el(doc, "p", { class: "empty", id: "explanation-hint" }, [
      "No LLM is configured. Add one in ",
      link,
      " to start checking.",
    ]);
  }

  // Links.

  private anchorOf(event: Event): HTMLAnchorElement | undefined {
    const { target } = event;
    if (!(target instanceof Element)) return undefined;
    const anchor = target.closest("a");
    return anchor instanceof HTMLAnchorElement && this.body.contains(anchor) ? anchor : undefined;
  }

  /** A click on a link never navigates: the page asks first, then opens a new tab. */
  private onBodyClick(event: Event): void {
    const anchor = this.anchorOf(event);
    if (anchor === undefined) return;
    event.preventDefault();
    const url = parseLinkTarget(anchor.getAttribute("href") ?? "");
    if (url !== undefined) this.deps.openLink(url);
  }
}
