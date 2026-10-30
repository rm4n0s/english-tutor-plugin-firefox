import { applyCss } from "./style";

export const OPEN_IN_TUTOR_LABEL = "Open in English Tutor";

const CARD: Readonly<Record<string, string>> = {
  all: "initial",
  display: "block",
  position: "absolute",
  width: "240px",
  "box-sizing": "border-box",
  padding: "10px 12px",
  "border-radius": "6px",
  border: "1px solid #c9ced6",
  background: "#ffffff",
  color: "#1c1e21",
  font: "13px/1.4 system-ui, sans-serif",
  "box-shadow": "0 4px 16px rgba(0, 0, 0, 0.3)",
  "pointer-events": "auto",
};

const BUTTON: Readonly<Record<string, string>> = {
  all: "initial",
  display: "block",
  "margin-top": "8px",
  padding: "5px 10px",
  "border-radius": "4px",
  border: "1px solid #0b5cad",
  background: "#0b5cad",
  color: "#ffffff",
  font: "600 13px system-ui, sans-serif",
  cursor: "pointer",
};

/**
 * What the badge offers when the page's Content Security Policy kept the frame from loading
 * (`PageFrameBlocked`, SPEC section 4.11): the reason, and one button, Open in English Tutor,
 * which sends the text of the box to a new tutor tab. It sits above the badge and closes on
 * `Escape` or a click anywhere else.
 */
export class BlockedCard {
  private readonly doc: Document;
  private readonly layer: HTMLElement;
  private card: HTMLElement | undefined;
  private removeListeners: (() => void) | undefined;

  constructor(doc: Document, layer: HTMLElement) {
    this.doc = doc;
    this.layer = layer;
  }

  get isOpen(): boolean {
    return this.card !== undefined;
  }

  /** Shows the card above-left of the badge at `anchor` (window coordinates). */
  open(message: string, anchor: { left: number; top: number }, onOpenInTutor: () => void): void {
    this.close();
    const card = this.doc.createElement("div");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "English Tutor");
    applyCss(card, CARD);
    const text = this.doc.createElement("div");
    text.textContent = message;
    const button = this.doc.createElement("button");
    button.type = "button";
    button.textContent = OPEN_IN_TUTOR_LABEL;
    applyCss(button, BUTTON);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      this.close();
      onOpenInTutor();
    });
    card.append(text, button);
    this.layer.append(card);
    this.card = card;
    // Above the badge when there is room, else below; kept inside the window.
    const view = this.doc.defaultView;
    const width = 240;
    const left = Math.max(
      8,
      Math.min(anchor.left + 22 - width, (view?.innerWidth ?? 1000) - width - 8),
    );
    const above = anchor.top - card.offsetHeight - 8;
    applyCss(card, {
      left: `${String(Math.round(left))}px`,
      top: `${String(Math.round(above >= 8 ? above : anchor.top + 30))}px`,
    });
    const onKey = (event: KeyboardEvent): void => {
      if (event.isTrusted && event.key === "Escape") this.close();
    };
    // The card is in a closed shadow root, so the page's listeners see only its host: a press on
    // the card stops here, and a press anywhere else reaches the document and closes it.
    card.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    const onPointer = (event: MouseEvent): void => {
      if (event.isTrusted) this.close();
    };
    this.doc.addEventListener("keydown", onKey, true);
    this.doc.addEventListener("mousedown", onPointer);
    this.removeListeners = () => {
      this.doc.removeEventListener("keydown", onKey, true);
      this.doc.removeEventListener("mousedown", onPointer);
    };
  }

  close(): void {
    this.removeListeners?.();
    this.removeListeners = undefined;
    this.card?.remove();
    this.card = undefined;
  }
}
