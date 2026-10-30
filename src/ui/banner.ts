import { el, setHidden, setText } from "./dom";

export interface BannerAction {
  label: string;
  /** Runs in the click handler, so it may call `permissions.request`, which needs a user gesture. */
  onClick: () => void;
}

/**
 * The dismissible banner above the editor (SPEC section 4.9). It shows a failure that has no panel
 * of its own, and an optional action button such as *Grant access*.
 */
export class Banner {
  readonly element: HTMLElement;
  private readonly text: HTMLElement;
  private readonly action: HTMLButtonElement;
  private onAction: (() => void) | undefined;

  constructor(doc: Document, host: HTMLElement) {
    this.text = el(doc, "span", { class: "banner-text" });
    this.action = el(doc, "button", { class: "banner-action", type: "button", hidden: true });
    const dismiss = el(
      doc,
      "button",
      { class: "banner-dismiss", type: "button", "aria-label": "Dismiss" },
      ["×"],
    );
    this.element = el(doc, "div", { id: "banner", class: "banner", role: "alert", hidden: true }, [
      this.text,
      this.action,
      dismiss,
    ]);
    this.action.addEventListener("click", () => {
      this.onAction?.();
    });
    dismiss.addEventListener("click", () => {
      this.hide();
    });
    host.append(this.element);
  }

  show(message: string, action?: BannerAction): void {
    setText(this.text, message);
    this.onAction = action?.onClick;
    setText(this.action, action?.label ?? "");
    setHidden(this.action, action === undefined);
    setHidden(this.element, false);
  }

  hide(): void {
    this.onAction = undefined;
    setHidden(this.element, true);
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  get message(): string {
    return this.text.textContent;
  }
}
