import type { IssueState } from "../core/issues";
import { el } from "./dom";

/** The idle text of the panel (SPEC section 4.5). */
export const IDLE_HINT =
  "Select an error in the list or an underlined error in the text to learn more";

export interface ExplanationPanelDeps {
  /** Opens the options page. A page-mode frame cannot use a plain link for that. */
  openOptions(): void;
}

/**
 * The explanation panel (SPEC section 4.5). This is its shell: it shows the idle hint, or, when no
 * LLM is configured, the hint with a link to the options page. Step 8 adds the states of a
 * selected issue (loading, ready, failed, cancelled) to it; it takes the `IssueState` for that.
 * The tutor page and the page-mode frame both use it.
 */
export class ExplanationPanel {
  private readonly doc: Document;
  private readonly host: HTMLElement;
  private readonly state: IssueState;
  private readonly deps: ExplanationPanelDeps;
  private hasLLM = true;

  constructor(doc: Document, host: HTMLElement, state: IssueState, deps: ExplanationPanelDeps) {
    this.doc = doc;
    this.host = host;
    this.state = state;
    this.deps = deps;
    this.render();
  }

  /** Whether an LLM is configured. Without one the panel asks the user to add one. */
  setHasLLM(hasLLM: boolean): void {
    if (this.hasLLM === hasLLM) return;
    this.hasLLM = hasLLM;
    this.render();
  }

  render(): void {
    const doc = this.doc;
    if (this.hasLLM) {
      this.host.replaceChildren(
        el(doc, "p", { class: "empty", id: "explanation-hint" }, [IDLE_HINT]),
      );
      return;
    }
    const link = el(doc, "a", { href: "#", class: "options-link", id: "options-link" }, [
      "Preferences",
    ]);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.deps.openOptions();
    });
    this.host.replaceChildren(
      el(doc, "p", { class: "empty", id: "explanation-hint" }, [
        "No LLM is configured. Add one in ",
        link,
        " to start checking.",
      ]),
    );
  }
}
