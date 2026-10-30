/**
 * Test pages for the content script's tests, written as HTML strings and parsed with a `Range`.
 * Only tests use this: no extension code parses HTML (CLAUDE.md, security rules).
 */
export function setBody(doc: Document, html: string): HTMLElement {
  const fragment = doc.createRange().createContextualFragment(html);
  doc.body.replaceChildren(fragment);
  const first = doc.body.firstElementChild;
  if (first === null) throw new TypeError("the test page has no element");
  return first as HTMLElement;
}

export function clearBody(doc: Document): void {
  doc.body.replaceChildren();
}
