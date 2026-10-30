/**
 * Which elements of a web page are text boxes page mode may read (SPEC section 4.11). The rules
 * are exact and conservative: anything that is not clearly a plain text box for prose is left
 * alone, and nothing is read before the user focuses the box.
 */

export type TextBoxKind = "textarea" | "input" | "editable";

/** A text box is not checked when it is smaller than this (CSS pixels). */
export const MIN_BOX_WIDTH = 40;
export const MIN_BOX_HEIGHT = 16;

/** `autocomplete` tokens that mark a field as private: credentials and one-time codes. */
const PRIVATE_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "username",
]);

/** The value of a boolean-ish attribute in lower case, or null when the attribute is missing. */
function attribute(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  return value === null ? null : value.trim().toLowerCase();
}

/** Whether the `autocomplete` attribute names a credential, a one-time code or a payment field. */
export function isPrivateAutocomplete(value: string | null): boolean {
  if (value === null) return false;
  return value
    .split(/\s+/)
    .some((token) => PRIVATE_AUTOCOMPLETE.has(token) || token.startsWith("cc-"));
}

/** `contenteditable` of an element: true for `true`, the empty string and `plaintext-only`. */
function contentEditableState(element: Element): "true" | "false" | "inherit" {
  const value = attribute(element, "contenteditable");
  if (value === null) return "inherit";
  if (value === "true" || value === "" || value === "plaintext-only") return "true";
  if (value === "false") return "false";
  return "inherit";
}

/**
 * What kind of text box the element is by its tag and attributes alone: a `<textarea>`, an
 * `<input>` whose type is `text` or missing, or an editing host. Undefined for anything else.
 */
export function textBoxKind(element: Element): TextBoxKind | undefined {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea") return "textarea";
  if (tag === "input") {
    const type = attribute(element, "type");
    return type === null || type === "" || type === "text" ? "input" : undefined;
  }
  return contentEditableState(element) === "true" ? "editable" : undefined;
}

/** The editing host that holds `node`, or undefined when it is not inside editable content. */
export function editingHost(node: Node | null | undefined): Element | undefined {
  let host: Element | undefined;
  let current: Node | null | undefined = node;
  while (current !== null && current !== undefined) {
    if (current.nodeType === 1) {
      const state = contentEditableState(current as Element);
      if (state === "true") host = current as Element;
      else if (state === "false") break;
    }
    current = current.parentNode;
  }
  return host;
}

function isDisabled(element: Element): boolean {
  if ((element as HTMLInputElement).disabled || element.hasAttribute("disabled")) {
    return true;
  }
  // A field inside `<fieldset disabled>` is disabled too.
  return element.closest("fieldset[disabled]") !== null;
}

function isReadOnly(element: Element): boolean {
  return (element as HTMLInputElement).readOnly || element.hasAttribute("readonly");
}

/** The value of `spellcheck` an element has, its own or its nearest ancestor's. */
function spellcheckOff(element: Element): boolean {
  const owner = element.closest("[spellcheck]");
  return owner !== null && attribute(owner, "spellcheck") === "false";
}

/** The attribute rules: true when the field must never be read, checked or touched. */
export function isExcluded(element: Element, kind: TextBoxKind): boolean {
  if (kind !== "editable" && (isDisabled(element) || isReadOnly(element))) return true;
  if (isPrivateAutocomplete(attribute(element, "autocomplete"))) return true;
  if (spellcheckOff(element)) return true;
  return element.closest('[data-english-tutor="off"]') !== null;
}

/** Whether the element is shown and at least 40x16 CSS pixels. */
export function isVisibleAndBigEnough(element: Element, view: Window): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < MIN_BOX_WIDTH || rect.height < MIN_BOX_HEIGHT) return false;
  const style = view.getComputedStyle(element);
  if (style.display === "none") return false;
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  return Number.parseFloat(style.opacity === "" ? "1" : style.opacity) > 0;
}

/**
 * The kind of the text box the element is, or undefined when page mode must leave it alone: it
 * is not a text box, an attribute rule excludes it, or it is hidden or too small.
 */
export function checkableTextBox(element: Element, view: Window): TextBoxKind | undefined {
  const kind = textBoxKind(element);
  if (kind === undefined) return undefined;
  if (isExcluded(element, kind)) return undefined;
  return isVisibleAndBigEnough(element, view) ? kind : undefined;
}

export interface FoundTextBox {
  element: HTMLElement;
  kind: TextBoxKind;
}

/**
 * The text box an event target is in or is, if page mode may use it. For editable content this is
 * the editing host, wherever in it the target is.
 */
export function findTextBox(target: EventTarget | null, view: Window): FoundTextBox | undefined {
  if (target === null || !("nodeType" in target)) return undefined;
  const node = target as Node;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (element === null) return undefined;
  const candidate =
    element.tagName.toLowerCase() === "textarea" || element.tagName.toLowerCase() === "input"
      ? element
      : editingHost(element);
  if (candidate === undefined) return undefined;
  const kind = checkableTextBox(candidate, view);
  return kind === undefined ? undefined : { element: candidate as HTMLElement, kind };
}
