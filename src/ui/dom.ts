/**
 * Small helpers to build DOM with `createElement` and `textContent`. Nothing here parses HTML
 * (CLAUDE.md, security rules).
 */

/** Attributes of a new element: `true` sets a boolean attribute, `false` and undefined skip it. */
export type Attrs = Readonly<Record<string, string | boolean | undefined>>;

export type Child = Node | string;

/** A new element with attributes and children (strings become text nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === true) element.setAttribute(name, "");
    else if (typeof value === "string") element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

/** Replaces the text of an element. */
export function setText(element: Element, text: string): void {
  element.textContent = text;
}

/** Shows or hides an element with the `hidden` attribute. */
export function setHidden(element: HTMLElement, hidden: boolean): void {
  element.hidden = hidden;
}
