import type { AppError } from "../core/errors";
import { el, setHidden, setText } from "../ui/dom";
import type { PageModeSection } from "./page-mode-section";

export const WELCOME_INTRO =
  "English Tutor finds grammar, vocabulary and syntax errors in what you write, explains them, and counts your mistakes. It uses an LLM that you set up: a model on this computer or a server you choose.";
export const WELCOME_OFFER =
  "Offer to check what you write on websites. English Tutor asks on each site first, and reads nothing on a site until you say yes.";
export const WELCOME_ALLOWED =
  "Allowed. On a site you have not turned on, a small icon appears on a text box you click into, and English Tutor asks before it reads anything.";

export interface WelcomeDeps {
  /** The page-mode section whose permission request Allow makes (the same code as its box). */
  pageMode: PageModeSection;
  /** Opens the Add form of the LLMs section. */
  addLLM: () => void;
}

/**
 * The Welcome block (SPEC sections 4.7 and 4.11): shown above the sections when the options page
 * is opened as `options.html#welcome`, which is what the first installation does. It says what
 * English Tutor does, offers Add an LLM, and asks once for access to all websites, with Allow and
 * Not now. Not now closes the block.
 */
export class WelcomeBlock {
  readonly element: HTMLElement;
  private readonly allowButton: HTMLButtonElement;
  private readonly offer: HTMLElement;
  private readonly offerActions: HTMLElement;
  private readonly errorLine: HTMLElement;
  private readonly allowed: HTMLElement;

  constructor(doc: Document, deps: WelcomeDeps) {
    const addButton = el(doc, "button", { id: "welcome-add-llm", type: "button" }, ["Add an LLM"]);
    this.allowButton = el(doc, "button", { id: "welcome-allow", type: "button" }, ["Allow"]);
    const laterButton = el(doc, "button", { id: "welcome-later", type: "button" }, ["Not now"]);
    this.offer = el(doc, "p", { id: "welcome-offer", class: "note" }, [WELCOME_OFFER]);
    this.offerActions = el(doc, "div", { class: "actions" }, [this.allowButton, laterButton]);
    this.errorLine = el(doc, "p", {
      id: "welcome-error",
      class: "message error",
      role: "alert",
      hidden: true,
    });
    this.allowed = el(doc, "p", {
      id: "welcome-allowed",
      class: "message ok",
      role: "status",
      hidden: true,
    });
    this.element = el(
      doc,
      "section",
      { id: "welcome", class: "card welcome", "aria-labelledby": "welcome-heading" },
      [
        el(doc, "h2", { id: "welcome-heading" }, ["Welcome to English Tutor"]),
        el(doc, "div", { class: "card-body" }, [
          el(doc, "p", { id: "welcome-intro" }, [WELCOME_INTRO]),
          el(doc, "div", { class: "actions" }, [addButton]),
          this.offer,
          this.offerActions,
          this.errorLine,
          this.allowed,
        ]),
      ],
    );

    addButton.addEventListener("click", () => {
      deps.addLLM();
    });
    // Allow calls the permission request in this very click handler (before any `await`).
    this.allowButton.addEventListener("click", () => {
      deps.pageMode.allow();
    });
    laterButton.addEventListener("click", () => {
      this.close();
    });
    deps.pageMode.onDenied = (err: AppError | undefined) => {
      if (err === undefined) setHidden(this.errorLine, true);
      else {
        setText(this.errorLine, err.message);
        setHidden(this.errorLine, false);
      }
    };
    deps.pageMode.onAllowed = () => {
      setHidden(this.offer, true);
      setHidden(this.offerActions, true);
      setHidden(this.errorLine, true);
      setText(this.allowed, WELCOME_ALLOWED);
      setHidden(this.allowed, false);
    };
  }

  /** Closes the block (Not now). */
  close(): void {
    this.element.remove();
  }
}
