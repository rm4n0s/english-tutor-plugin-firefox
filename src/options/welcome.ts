import { el } from "../ui/dom";

export const WELCOME_INTRO =
  "English Tutor finds grammar, vocabulary and syntax errors in what you write, explains them, and counts your mistakes. It uses an LLM that you set up: a model on this computer or a server you choose.";
export const WELCOME_PAGE_MODE =
  "On websites, click the grey English Tutor icon in a text box to turn checking on for that site. English Tutor reads nothing on a site until you do. The General section below can hide the icon.";

export interface WelcomeDeps {
  /** Opens the Add form of the LLMs section. */
  addLLM: () => void;
}

/**
 * The Welcome block (SPEC sections 4.7 and 4.11): shown above the sections when the options page
 * is opened as `options.html#welcome`, which is what the first installation does. It says what
 * English Tutor does, offers Add an LLM, and explains how it works on websites. Firefox already
 * grants the access to websites at the installation, so there is nothing to allow.
 */
export class WelcomeBlock {
  readonly element: HTMLElement;

  constructor(doc: Document, deps: WelcomeDeps) {
    const addButton = el(doc, "button", { id: "welcome-add-llm", type: "button" }, ["Add an LLM"]);
    this.element = el(
      doc,
      "section",
      { id: "welcome", class: "card welcome", "aria-labelledby": "welcome-heading" },
      [
        el(doc, "h2", { id: "welcome-heading" }, ["Welcome to English Tutor"]),
        el(doc, "div", { class: "card-body" }, [
          el(doc, "p", { id: "welcome-intro" }, [WELCOME_INTRO]),
          el(doc, "div", { class: "actions" }, [addButton]),
          el(doc, "p", { id: "welcome-page-mode", class: "note" }, [WELCOME_PAGE_MODE]),
        ]),
      ],
    );
    addButton.addEventListener("click", () => {
      deps.addLLM();
    });
  }
}
