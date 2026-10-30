/**
 * Styles of the elements the content script adds to a web page. They are set one property at a
 * time through the CSS object model (`style.setProperty`), never with a style sheet or a `style`
 * attribute, because the page's Content Security Policy can forbid inline styles and the content
 * script must look the same everywhere.
 */
export type Css = Readonly<Record<string, string>>;

/** Sets each property with `!important`, so that nothing on the page can override it. */
export function applyCss(element: HTMLElement | SVGElement, css: Css): void {
  for (const [property, value] of Object.entries(css)) {
    element.style.setProperty(property, value, "important");
  }
}

/** The colours of the categories (SPEC section 4.3, light theme) and the badge's other states. */
export const COLORS = {
  grammar: "#d55e00",
  syntax: "#009e73",
  vocabulary: "#0072b2",
  ok: "#1b7a3d",
  warning: "#b3261e",
  ink: "#ffffff",
} as const;

/**
 * The colours of the underlines (SPEC section 4.3), for a light and a dark page: the page's own
 * background decides which, not the browser's theme (`isDarkBackdrop` in `underlines.ts`).
 */
export const UNDERLINE_COLORS = {
  light: { grammar: "#d55e00", vocabulary: "#0072b2", syntax: "#009e73" },
  dark: { grammar: "#ff8a4c", vocabulary: "#56b4e9", syntax: "#2fd3a2" },
} as const;

/** `#rrggbb` as `rgba(r, g, b, alpha)`: the selected issue's background is 20% of its colour. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)}, ${String(alpha)})`;
}

export const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG element with attributes, built with `createElementNS` (no HTML is ever parsed). */
export function svg(
  doc: Document,
  tag: string,
  attrs: Readonly<Record<string, string>> = {},
  children: readonly Element[] = [],
): SVGElement {
  const element = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}
