import type { Clock } from "../core/clock";
import type { PromptChoice, PromptServer } from "../core/page-mode/messages";
import { applyCss, type Css } from "./style";

/** Clicks in this many milliseconds after the card appears are ignored (SPEC section 4.11). */
export const CLICK_GUARD_MS = 500;

export const PROMPT_BUTTONS: readonly { choice: PromptChoice; label: string }[] = [
  { choice: "on", label: "Turn on" },
  { choice: "later", label: "Not now" },
  { choice: "off", label: "Never on this site" },
];

export const NO_LLM_NOTE = "No LLM is set up yet. You can add one in the options.";

/** The title of the card: the exact host the question is about. */
export function promptTitle(host: string): string {
  return `Check what you write on ${host} with English Tutor?`;
}

/** The note under the title: where what the user types goes (SPEC section 4.11). */
export function promptNote(llm: PromptServer | null): string {
  if (llm === null) return NO_LLM_NOTE;
  return llm.local
    ? `What you type here is checked by ${llm.server}, on this computer.`
    : `What you type here is sent to ${llm.server} to be checked.`;
}

const CARD_WIDTH = 330;
/** Space between the box and the card. */
const GAP = 6;
/** Space kept to the edge of the window. */
const EDGE = 8;

const CARD: Css = {
  all: "initial",
  display: "block",
  position: "absolute",
  width: `${String(CARD_WIDTH)}px`,
  "box-sizing": "border-box",
  padding: "12px 14px 12px",
  "border-radius": "8px",
  border: "1px solid #c9ced6",
  background: "#ffffff",
  color: "#1c1e21",
  font: "13px/1.4 system-ui, sans-serif",
  "box-shadow": "0 4px 16px rgba(0, 0, 0, 0.3)",
  "pointer-events": "auto",
};

const TITLE: Css = {
  all: "initial",
  display: "block",
  margin: "0 18px 4px 0",
  font: "600 13px/1.35 system-ui, sans-serif",
  color: "#1c1e21",
  "overflow-wrap": "anywhere",
};

const NOTE: Css = {
  all: "initial",
  display: "block",
  margin: "0 0 10px 0",
  font: "12px/1.4 system-ui, sans-serif",
  color: "#4a4f57",
  "overflow-wrap": "anywhere",
};

const ROW: Css = {
  all: "initial",
  display: "flex",
  "flex-wrap": "wrap",
  gap: "6px",
};

const BUTTON: Css = {
  all: "initial",
  display: "inline-block",
  padding: "5px 10px",
  "border-radius": "4px",
  font: "600 12px system-ui, sans-serif",
  cursor: "pointer",
  "box-sizing": "border-box",
};

/** One style per choice, so that the three buttons also differ in colour, not only in text. */
const BUTTON_STYLE: Readonly<Record<PromptChoice, Css>> = {
  on: { border: "1px solid #0b5cad", background: "#0b5cad", color: "#ffffff" },
  later: { border: "1px solid #b0bccb", background: "#d9e2ec", color: "#1c1e21" },
  off: { border: "1px solid #b3261e", background: "#ffffff", color: "#b3261e" },
};

const CLOSE: Css = {
  all: "initial",
  position: "absolute",
  top: "6px",
  right: "8px",
  width: "20px",
  height: "20px",
  "text-align": "center",
  font: "16px/20px system-ui, sans-serif",
  color: "#4a4f57",
  cursor: "pointer",
};

export interface PromptCardOptions {
  doc: Document;
  /** The layer of the closed shadow root the card goes into. */
  layer: HTMLElement;
  clock: Clock;
  /** The exact host name the question is about. */
  host: string;
  /** The server of the LLM in use for the note, or null when none is set up. */
  llm: PromptServer | null;
  /** The user's choice. Called at most once. */
  onChoose: (choice: PromptChoice) => void;
}

/**
 * The card that asks, on a site with no choice yet, whether page mode may check what the user
 * writes there (SPEC section 4.11): the host, where the text would go, and Turn on, Not now and
 * Never on this site, and a close button that counts as Not now. It sits in the content script's
 * closed shadow root, just below the focused text box (above it when there is no room). It never
 * takes the focus from the text box (the card's mouse presses are cancelled, so the box keeps its
 * focus and its caret), and typing in the box does not close it. Its buttons ignore events the
 * page dispatched itself (`isTrusted === false`) and clicks in the first 500 ms.
 */
export class PromptCard {
  private readonly options: PromptCardOptions;
  private readonly card: HTMLElement;
  private readonly openedAt: number;
  private chosen = false;

  constructor(options: PromptCardOptions) {
    this.options = options;
    const { doc, host, llm } = options;
    this.card = doc.createElement("div");
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-label", "English Tutor");
    applyCss(this.card, CARD);

    const title = doc.createElement("div");
    title.textContent = promptTitle(host);
    applyCss(title, TITLE);
    const note = doc.createElement("div");
    note.textContent = promptNote(llm);
    applyCss(note, NOTE);
    const row = doc.createElement("div");
    applyCss(row, ROW);
    for (const { choice, label } of PROMPT_BUTTONS) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("data-choice", choice);
      applyCss(button, { ...BUTTON, ...BUTTON_STYLE[choice] });
      this.bind(button, choice);
      row.append(button);
    }
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.setAttribute("data-choice", "close");
    applyCss(close, CLOSE);
    this.bind(close, "later");

    this.card.append(title, note, row, close);
    // A mouse press on the card must not move the focus out of the text box: the box keeps its
    // caret, and nothing closes before the click lands.
    this.card.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    options.layer.append(this.card);
    this.openedAt = options.clock.now();
  }

  /** Whether the card is on the page. */
  get isOpen(): boolean {
    return this.card.isConnected;
  }

  private bind(button: HTMLElement, choice: PromptChoice): void {
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      if (this.options.clock.now() - this.openedAt < CLICK_GUARD_MS) return;
      if (this.chosen) return;
      this.chosen = true;
      this.options.onChoose(choice);
    });
  }

  /** Puts the card just below the box, or above it when there is no room below. */
  place(box: Element): void {
    const view = this.options.doc.defaultView;
    const rect = box.getBoundingClientRect();
    const height = this.card.offsetHeight;
    const innerWidth = view?.innerWidth ?? 1000;
    const innerHeight = view?.innerHeight ?? 800;
    const left = Math.max(EDGE, Math.min(rect.left, innerWidth - CARD_WIDTH - EDGE));
    const below = rect.bottom + GAP;
    const above = rect.top - GAP - height;
    const top = below + height <= innerHeight - EDGE || above < EDGE ? below : above;
    const clamped = Math.max(EDGE, Math.min(top, innerHeight - height - EDGE));
    applyCss(this.card, {
      left: `${String(Math.round(left))}px`,
      top: `${String(Math.round(clamped))}px`,
    });
  }

  close(): void {
    this.card.remove();
  }
}
