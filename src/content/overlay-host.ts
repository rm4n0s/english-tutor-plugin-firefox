import { applyCss } from "./style";

/**
 * The one element everything page mode adds to a web page lives in (SPEC section 4.11): a host
 * with a closed shadow root, `all: initial` so that the page's styles cannot change it, and a
 * full-window layer that does not catch the pointer. The badge, the underlines and the frames are
 * children of the layer. The page cannot reach into a closed root, and the host adds nothing to
 * the page's own layout (it is fixed and has no size).
 */
export class OverlayHost {
  /** The element in the page. */
  readonly element: HTMLElement;
  /** Where the badge, the overlays and the frames go, inside the closed shadow root. */
  readonly layer: HTMLElement;

  /** `mode` is `closed` in the extension; a test opens it to look inside. */
  constructor(doc: Document, mode: "closed" | "open" = "closed") {
    this.element = doc.createElement("div");
    applyCss(this.element, {
      all: "initial",
      display: "block",
      position: "fixed",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      "z-index": "2147483647",
      "pointer-events": "none",
    });
    const root = this.element.attachShadow({ mode });
    this.layer = doc.createElement("div");
    applyCss(this.layer, {
      all: "initial",
      display: "block",
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      overflow: "hidden",
      "pointer-events": "none",
    });
    root.append(this.layer);
    // The root element of the document, not the body: the body's own styles and scripts are the
    // page's business.
    doc.documentElement.append(this.element);
  }

  /** Whether an event target is this host (an event from inside the closed root looks like it). */
  owns(target: EventTarget | null): boolean {
    return target === this.element;
  }

  remove(): void {
    this.element.remove();
  }
}
