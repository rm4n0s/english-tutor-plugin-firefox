import type { BadgeView } from "./badge-view";
import { applyCss, COLORS, svg } from "./style";

/** The badge's diameter in CSS pixels. */
export const BADGE_SIZE = 22;

const BASE: Readonly<Record<string, string>> = {
  all: "initial",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  position: "absolute",
  width: `${String(BADGE_SIZE)}px`,
  height: `${String(BADGE_SIZE)}px`,
  "box-sizing": "border-box",
  padding: "0",
  margin: "0",
  "border-radius": "50%",
  border: "2px solid #ffffff",
  "box-shadow": "0 0 0 1px rgba(0, 0, 0, 0.4), 0 1px 4px rgba(0, 0, 0, 0.35)",
  color: COLORS.ink,
  font: "700 11px/1 system-ui, sans-serif",
  "text-shadow": "0 0 2px rgba(0, 0, 0, 0.5)",
  cursor: "pointer",
  "pointer-events": "auto",
  "user-select": "none",
  background: "#0072b2",
};

function background(view: BadgeView): string {
  switch (view.kind) {
    case "count":
      return COLORS[view.category];
    case "check":
      return COLORS.ok;
    case "warning":
      return COLORS.warning;
    case "spinner":
      return "#ffffff";
    case "icon":
      return "#0072b2";
  }
}

/** The shape of the extension's icon (scripts/make-icons.mjs) as an inline SVG. */
function iconSvg(doc: Document): SVGElement {
  const points: string[] = [];
  for (let x = 20; x <= 80; x += 2)
    points.push(`${String(x)},${(82 + 3.5 * Math.sin((x - 20) / 5.5)).toFixed(1)}`);
  return svg(doc, "svg", { viewBox: "0 0 100 100", width: "14", height: "14" }, [
    svg(doc, "rect", { x: "28", y: "20", width: "12", height: "50", fill: "#ffffff" }),
    svg(doc, "rect", { x: "28", y: "20", width: "44", height: "10", fill: "#ffffff" }),
    svg(doc, "rect", { x: "28", y: "40", width: "44", height: "10", fill: "#ffffff" }),
    svg(doc, "rect", { x: "28", y: "60", width: "44", height: "10", fill: "#ffffff" }),
    svg(doc, "polyline", {
      points: points.join(" "),
      fill: "none",
      stroke: "#ff8a4c",
      "stroke-width": "7",
      "stroke-linecap": "round",
    }),
  ]);
}

function checkSvg(doc: Document): SVGElement {
  return svg(doc, "svg", { viewBox: "0 0 24 24", width: "13", height: "13" }, [
    svg(doc, "path", {
      d: "M5 12.5l4.5 4.5L19 7.5",
      fill: "none",
      stroke: "#ffffff",
      "stroke-width": "3.4",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  ]);
}

function spinnerSvg(doc: Document): SVGElement {
  return svg(doc, "svg", { viewBox: "0 0 24 24", width: "15", height: "15" }, [
    svg(doc, "circle", {
      cx: "12",
      cy: "12",
      r: "8.5",
      fill: "none",
      stroke: "#0072b2",
      "stroke-width": "3.5",
      "stroke-dasharray": "34 20",
      "stroke-linecap": "round",
    }),
  ]);
}

/**
 * The badge of a text box (SPEC section 4.11): a small round button that shows the extension icon,
 * a spinner, the number of issues in the colour of their category, a check mark, or `!`. It lives
 * in the overlay's layer, positioned in window coordinates by the caller, and is built with
 * `createElement` and `createElementNS` only. The mouse press does not take the focus from the
 * text box. Only trusted clicks count.
 */
export class Badge {
  readonly element: HTMLButtonElement;
  private readonly doc: Document;
  private spin: Animation | undefined;
  private currentView: BadgeView | undefined;

  constructor(doc: Document, layer: HTMLElement, onClick: () => void) {
    this.doc = doc;
    this.element = doc.createElement("button");
    this.element.type = "button";
    this.element.setAttribute("tabindex", "-1");
    this.element.setAttribute("data-english-tutor-badge", "");
    applyCss(this.element, BASE);
    this.element.addEventListener("mousedown", (event) => {
      // Keep the focus (and the caret) in the text box.
      event.preventDefault();
    });
    this.element.addEventListener("click", (event) => {
      if (event.isTrusted) onClick();
    });
    layer.append(this.element);
  }

  get view(): BadgeView | undefined {
    return this.currentView;
  }

  show(view: BadgeView): void {
    const spinning = this.currentView?.kind === "spinner" && view.kind === "spinner";
    this.currentView = view;
    // A spinner that goes on spinning is left as it is, so that the turn does not start over each
    // time the frame says it is still checking.
    if (spinning) {
      this.element.setAttribute("title", view.label);
      this.element.setAttribute("aria-label", view.label);
      return;
    }
    this.spin?.cancel();
    this.spin = undefined;
    this.element.setAttribute("title", view.label);
    this.element.setAttribute("aria-label", view.label);
    this.element.setAttribute("data-kind", view.kind);
    applyCss(this.element, { background: background(view) });
    switch (view.kind) {
      case "icon":
        this.element.replaceChildren(iconSvg(this.doc));
        break;
      case "check":
        this.element.replaceChildren(checkSvg(this.doc));
        break;
      case "warning":
        this.element.replaceChildren(this.doc.createTextNode("!"));
        applyCss(this.element, { "font-size": "14px" });
        break;
      case "count":
        this.element.replaceChildren(
          this.doc.createTextNode(view.count > 99 ? "99+" : String(view.count)),
        );
        applyCss(this.element, { "font-size": view.count > 99 ? "9px" : "11px" });
        break;
      case "spinner": {
        const spinner = spinnerSvg(this.doc);
        this.element.replaceChildren(spinner);
        // The Web Animations API: no style sheet is needed, so a strict policy cannot stop it. A
        // user who asks for reduced motion gets a ring that stands still.
        if (typeof spinner.animate === "function" && !this.reducedMotion()) {
          const spin = spinner.animate(
            [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
            { duration: 900, iterations: Infinity },
          );
          // Cancelling an animation rejects its `finished` promise; nobody waits for it.
          spin.finished.catch(() => undefined);
          this.spin = spin;
        }
        break;
      }
    }
    if (view.kind !== "warning" && view.kind !== "count")
      applyCss(this.element, { "font-size": "11px" });
  }

  private reducedMotion(): boolean {
    const view = this.doc.defaultView;
    return (
      typeof view?.matchMedia === "function" &&
      view.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /** Puts the badge's top left corner at the window coordinates. */
  place(left: number, top: number): void {
    applyCss(this.element, {
      left: `${String(Math.round(left))}px`,
      top: `${String(Math.round(top))}px`,
    });
  }

  setVisible(visible: boolean): void {
    applyCss(this.element, { display: visible ? "flex" : "none" });
  }

  get visible(): boolean {
    return this.element.style.getPropertyValue("display") !== "none";
  }

  remove(): void {
    this.spin?.cancel();
    this.element.remove();
  }
}
