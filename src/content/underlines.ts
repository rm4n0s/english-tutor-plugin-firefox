import type { Category } from "../core/analysis";
import type { WireIssue } from "../core/page-mode/protocol";
import { issueBoxes, mirrorNodes, type Box } from "../ui/mirror";
import type { BoxState } from "./box-state";
import { applyCss, svg, UNDERLINE_COLORS, withAlpha } from "./style";

/** The line style of a category (SPEC section 4.3). */
const LINE_STYLE: Readonly<Record<Category, "wavy" | "dashed" | "dotted">> = {
  grammar: "wavy",
  vocabulary: "dashed",
  syntax: "dotted",
};

/** The text properties of the box that decide where its lines break and where its words are. */
const TEXT_PROPERTIES = [
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-variant",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-indent",
  "text-transform",
  "text-align",
  "text-rendering",
  "tab-size",
  "direction",
  "unicode-bidi",
  "writing-mode",
  "white-space",
  "overflow-wrap",
  "word-break",
  "hyphens",
] as const;

const PADDING_PROPERTIES = ["padding-top", "padding-right", "padding-bottom", "padding-left"];

/** The issues of one box, each with the rectangles of its lines in window coordinates. */
export interface IssueRects {
  readonly id: number;
  readonly rects: readonly Box[];
}

/** The parts of a colour a luminance needs; undefined for a value that is not `rgb()` or `rgba()`. */
function parseColor(value: string): { r: number; g: number; b: number; a: number } | undefined {
  const match = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
    value.trim(),
  );
  if (match === null) return undefined;
  const alpha = match[4] ?? "1";
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: alpha.endsWith("%") ? Number.parseFloat(alpha) / 100 : Number(alpha),
  };
}

/**
 * Whether the page behind the text is dark: the first background colour that is mostly opaque,
 * from the box up to the root. A page with none is light (the canvas colour). The underlines use
 * their dark palette on a dark page, whatever the browser's own theme is.
 */
export function isDarkBackdrop(win: Window, element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const color = parseColor(win.getComputedStyle(node).backgroundColor);
    if (color !== undefined && color.a >= 0.5) {
      return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255 < 0.45;
    }
  }
  return false;
}

/** Whether the rectangle has an area. */
function hasArea(rect: Box): boolean {
  return rect.right > rect.left && rect.bottom > rect.top;
}

/** The part of `rect` inside `clip`, or undefined when there is none. */
function clipTo(rect: Box, clip: Box): Box | undefined {
  const clipped = {
    left: Math.max(rect.left, clip.left),
    top: Math.max(rect.top, clip.top),
    right: Math.min(rect.right, clip.right),
    bottom: Math.min(rect.bottom, clip.bottom),
  };
  return hasArea(clipped) ? clipped : undefined;
}

/** The path of a wavy line `width` long, centred on `y`: a smooth wave of 3 px half periods. */
export function wavePath(width: number, y: number): string {
  const half = 3;
  const amp = 1.6;
  let path = `M0 ${String(y)} Q${String(half / 2)} ${String(y - amp * 2)} ${String(half)} ${String(y)}`;
  for (let x = 2 * half; x < width + half; x += half) path += ` T${String(x)} ${String(y)}`;
  return path;
}

/**
 * The underlines of one text box (SPEC section 4.11), drawn in the content script's closed shadow
 * root, never in the page's own DOM and never changing the box's text. All its elements ignore
 * the pointer, so typing, clicking and selecting work as if it were not there.
 *
 * - A `<textarea>` or `<input>` gets a mirror: an element with the box's size, borders, padding,
 *   text styles and scroll position, holding the text in transparent colour with each issue in a
 *   `<span>`, so only the spans' underlines show. The mirror wraps where the box wraps, because
 *   it has the same width for its text (the room of a scroll bar taken off).
 * - Editable content gets one underline per rectangle of a `Range` over each issue, found
 *   through the text model that maps positions to text nodes.
 *
 * `draw` is cheap when nothing changed: the mirror's content is made again only when the text, the
 * issues, the selected issue or the palette changed; its position and scroll are set every time.
 */
export class BoxUnderlines {
  private readonly doc: Document;
  private readonly layer: HTMLElement;
  private readonly box: BoxState;
  private readonly win: Window;
  private clip: HTMLElement | undefined;
  private inner: HTMLElement | undefined;
  private rects: readonly IssueRects[] = [];
  private drawn:
    | { text: string; issues: readonly WireIssue[]; selected: number | null; dark: boolean }
    | undefined;

  constructor(doc: Document, layer: HTMLElement, box: BoxState, win: Window) {
    this.doc = doc;
    this.layer = layer;
    this.box = box;
    this.win = win;
  }

  /** The rectangles of the issues as last drawn, for hit tests and for placing the popover. */
  get issueRects(): readonly IssueRects[] {
    return this.rects;
  }

  /** The rectangles of one issue's lines (empty when it is not drawn, or is scrolled out of sight). */
  rectsOf(id: number): readonly Box[] {
    return this.rects.find((entry) => entry.id === id)?.rects ?? [];
  }

  /** The issue whose underline holds the window point (SPEC section 4.11), or undefined. */
  issueAt(x: number, y: number): number | undefined {
    return this.rects.find(({ rects }) =>
      rects.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom),
    )?.id;
  }

  /** Draws the box's issues now, or nothing when it has none or is not `visible`. */
  draw(selectedId: number | null, visible = true): void {
    const element = this.box.element;
    const issues = this.box.issues;
    if (!visible || issues.length === 0 || !element.isConnected) {
      this.clear();
      return;
    }
    if (this.box.kind === "editable") this.drawEditable(selectedId);
    else this.drawMirror(selectedId);
  }

  /** Takes the underlines away (the issues are gone, or the box is out of sight). */
  clear(): void {
    this.rects = [];
    this.drawn = undefined;
    this.inner = undefined;
    this.clip?.remove();
    this.clip = undefined;
  }

  remove(): void {
    this.clear();
  }

  // The mirror, for a textarea and an input.

  private makeClip(): HTMLElement {
    if (this.clip !== undefined) return this.clip;
    const clip = this.doc.createElement("div");
    applyCss(clip, {
      all: "initial",
      display: "block",
      position: "fixed",
      overflow: "hidden",
      "pointer-events": "none",
      "user-select": "none",
      "box-sizing": "border-box",
      "border-style": "solid",
      "border-color": "transparent",
    });
    this.layer.prepend(clip);
    this.clip = clip;
    return clip;
  }

  private drawMirror(selectedId: number | null): void {
    const element = this.box.element as HTMLInputElement | HTMLTextAreaElement;
    const style = this.win.getComputedStyle(element);
    const px = (value: string): number => Number.parseFloat(value) || 0;
    const rect = element.getBoundingClientRect();
    const borderLeft = px(style.borderLeftWidth);
    const borderTop = px(style.borderTopWidth);
    const borderRight = px(style.borderRightWidth);
    const borderBottom = px(style.borderBottomWidth);
    // The text area of the box without the room of its scroll bars: the mirror wraps at the same
    // width. A scroll bar on the left (right-to-left text) moves the start of the text.
    const bar = Math.max(0, element.offsetWidth - element.clientWidth - borderLeft - borderRight);
    const rtl = style.direction === "rtl";
    const clip = this.makeClip();
    const isInput = this.box.kind === "input";

    const geometry: Record<string, string> = {
      left: `${String(rect.left + (rtl ? bar : 0))}px`,
      top: `${String(rect.top)}px`,
      width: `${String(element.clientWidth + borderLeft + borderRight)}px`,
      height: `${String(element.clientHeight + borderTop + borderBottom)}px`,
      "border-width": `${String(borderTop)}px ${String(borderRight)}px ${String(borderBottom)}px ${String(borderLeft)}px`,
      display: isInput ? "flex" : "block",
      "align-items": "center",
      color: "transparent",
    };
    for (const name of [...TEXT_PROPERTIES, ...PADDING_PROPERTIES]) {
      const value = style.getPropertyValue(name);
      if (value !== "") geometry[name] = value;
    }
    // A text box that does not wrap (an input, or `wrap="off"`) has a line as wide as its text.
    const wraps = !(isInput || /^(pre|nowrap)$/.test(style.whiteSpace));
    if (isInput && !/^(pre|nowrap)$/.test(style.whiteSpace)) geometry["white-space"] = "pre";
    applyCss(clip, geometry);

    const dark = isDarkBackdrop(this.win, element);
    const inner = this.ensureInner(clip, selectedId, dark, isInput, wraps);
    // The scroll position of the box, after the content has its size.
    clip.scrollTop = element.scrollTop;
    clip.scrollLeft = element.scrollLeft;
    const clipBox: Box = {
      left: rect.left + borderLeft + (rtl ? bar : 0),
      top: rect.top + borderTop,
      right: rect.left + borderLeft + (rtl ? bar : 0) + element.clientWidth,
      bottom: rect.top + borderTop + element.clientHeight,
    };
    this.rects = issueBoxes(inner).flatMap(({ id, boxes }) => {
      const kept = boxes.flatMap((box) => clipTo(box, clipBox) ?? []);
      return kept.length === 0 ? [] : [{ id, rects: kept }];
    });
  }

  /** The element that holds the mirrored text; its content is made again when something it shows changed. */
  private ensureInner(
    clip: HTMLElement,
    selectedId: number | null,
    dark: boolean,
    isInput: boolean,
    wraps: boolean,
  ): HTMLElement {
    const issues = this.box.issues;
    const text = this.box.text;
    let inner = this.inner;
    let fresh = false;
    if (!inner?.isConnected) {
      inner = this.doc.createElement("div");
      this.inner = inner;
      clip.replaceChildren(inner);
      fresh = true;
    }
    // Text styles are inherited from the clip element. A line that does not wrap is as wide as its
    // text and never narrower than the box (so that `text-align` still works).
    applyCss(inner, {
      all: "initial",
      display: "block",
      "box-sizing": "border-box",
      "pointer-events": "none",
      "user-select": "none",
      color: "transparent",
      ...(isInput
        ? { flex: "none", width: "max-content", "min-width": "100%" }
        : wraps
          ? { width: "100%" }
          : { width: "max-content", "min-width": "100%" }),
      // `all: initial` reset the inherited text styles: take them from the clip again.
      font: "inherit",
      "white-space": "inherit",
      "overflow-wrap": "inherit",
      "word-break": "inherit",
      "text-align": "inherit",
      "tab-size": "inherit",
      "line-height": "inherit",
      "letter-spacing": "inherit",
      "word-spacing": "inherit",
      "text-indent": "inherit",
      "text-transform": "inherit",
      direction: "inherit",
      hyphens: "inherit",
    });
    const last = this.drawn;
    const unchanged =
      last?.text === text &&
      last.issues === issues &&
      last.selected === selectedId &&
      last.dark === dark;
    if (!fresh && unchanged) return inner;
    inner.replaceChildren(...mirrorNodes(this.doc, text, issues, selectedId));
    const palette = UNDERLINE_COLORS[dark ? "dark" : "light"];
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    for (const span of inner.querySelectorAll<HTMLElement>("span.issue")) {
      const issue = byId.get(Number(span.dataset.issueId));
      if (issue === undefined) continue;
      const color = palette[issue.category];
      applyCss(span, {
        color: "transparent",
        "text-decoration-line": "underline",
        "text-decoration-style": LINE_STYLE[issue.category],
        "text-decoration-color": color,
        "text-decoration-thickness": "2px",
        "text-underline-offset": "3px",
        "text-decoration-skip-ink": "none",
        ...(issue.id === selectedId ? { "background-color": withAlpha(color, 0.2) } : {}),
      });
    }
    this.drawn = { text, issues, selected: selectedId, dark };
    return inner;
  }

  // Editable content, from the rectangles of a Range over each issue.

  private drawEditable(selectedId: number | null): void {
    const element = this.box.element;
    const model = this.box.model;
    if (model === undefined) {
      this.clear();
      return;
    }
    const rect = element.getBoundingClientRect();
    const style = this.win.getComputedStyle(element);
    const px = (value: string): number => Number.parseFloat(value) || 0;
    // Underlines show inside the padding box: a box that scrolls its content hides what is outside.
    const left = rect.left + px(style.borderLeftWidth);
    const top = rect.top + px(style.borderTopWidth);
    const width = element.clientWidth || rect.width;
    const height = element.clientHeight || rect.height;
    const clip = this.makeClip();
    applyCss(clip, {
      left: `${String(left)}px`,
      top: `${String(top)}px`,
      width: `${String(width)}px`,
      height: `${String(height)}px`,
      "border-width": "0",
      display: "block",
    });
    const clipBox: Box = { left, top, right: left + width, bottom: top + height };
    const dark = isDarkBackdrop(this.win, element);
    const palette = UNDERLINE_COLORS[dark ? "dark" : "light"];

    const parts: Element[] = [];
    const found: IssueRects[] = [];
    for (const issue of this.box.issues) {
      const range = model.rangeFor(this.doc, issue.start, issue.end);
      if (range === undefined) continue;
      const kept = [...range.getClientRects()].flatMap((r) => (hasArea(r) ? [r] : []));
      const visible = kept.flatMap((r) => clipTo(r, clipBox) ?? []);
      if (visible.length === 0) continue;
      found.push({ id: issue.id, rects: visible });
      const color = palette[issue.category];
      for (const r of kept) {
        const x = r.left - left;
        const y = r.top - top;
        if (issue.id === selectedId) {
          const background = this.doc.createElement("div");
          applyCss(background, {
            all: "initial",
            display: "block",
            position: "absolute",
            left: `${String(x)}px`,
            top: `${String(y)}px`,
            width: `${String(r.width)}px`,
            height: `${String(r.height)}px`,
            "background-color": withAlpha(color, 0.2),
            "pointer-events": "none",
          });
          parts.push(background);
        }
        parts.push(this.line(issue.category, color, x, y + r.height, r.width));
      }
    }
    clip.replaceChildren(...parts);
    this.rects = found;
    this.drawn = undefined;
    this.inner = undefined;
  }

  /** One underline of `width` ending at `bottom`, drawn as an SVG path (no text to decorate). */
  private line(
    category: Category,
    color: string,
    x: number,
    bottom: number,
    width: number,
  ): SVGElement {
    const mid = 3;
    const style = LINE_STYLE[category];
    const path = svg(this.doc, "path", {
      d: style === "wavy" ? wavePath(width, mid) : `M0 ${String(mid)} H${String(width)}`,
      fill: "none",
      stroke: color,
      "stroke-width": "2",
      ...(style === "dashed" ? { "stroke-dasharray": "5 3" } : {}),
      ...(style === "dotted" ? { "stroke-dasharray": "2 2" } : {}),
    });
    const element = svg(
      this.doc,
      "svg",
      { width: String(width), height: "6", "aria-hidden": "true" },
      [path],
    );
    applyCss(element, {
      all: "initial",
      display: "block",
      position: "absolute",
      left: `${String(x)}px`,
      top: `${String(Math.round(bottom) - 4)}px`,
      width: `${String(width)}px`,
      height: "6px",
      overflow: "hidden",
      "pointer-events": "none",
    });
    return element;
  }
}
