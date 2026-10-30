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

/** The value of an attribute on the element or its nearest ancestor that has it, in lower case. */
function inheritedAttribute(element: Element, name: string): string | null {
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    const value = attribute(current, name);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The containers of the code editors and terminals page mode knows (SPEC section 4.11): CodeMirror
 * 5 and 6, Monaco, Ace, xterm.js, Jupyter's code cells, and `<pre>` and `<code>`. A field that is,
 * or is inside, one of them is never read: this includes the hidden `<textarea>` these editors
 * keep to receive the keys.
 */
const CODE_EDITOR_SELECTORS = [
  ".CodeMirror",
  ".cm-editor",
  ".monaco-editor",
  ".ace_editor",
  ".xterm",
  ".jp-CodeCell",
  "pre",
  "code",
] as const;

/** The first known code editor or terminal the element is in or is, as its selector. */
function codeEditorSelector(element: Element): string | undefined {
  return CODE_EDITOR_SELECTORS.find((selector) => element.closest(selector) !== null);
}

/** Whether `autocorrect` or `autocapitalize` is off on the element or an ancestor. */
function correctionsOff(element: Element): boolean {
  const autocorrect = inheritedAttribute(element, "autocorrect");
  const autocapitalize = inheritedAttribute(element, "autocapitalize");
  return autocorrect === "off" || autocapitalize === "off" || autocapitalize === "none";
}

/**
 * Why the attribute rules say a field must never be read, checked or touched, or undefined when
 * they do not (SPEC section 4.11). The reasons are short fixed phrases for the debug log: they
 * name a rule, never the text.
 *
 * `spellcheck="false"` alone does not exclude an editing host: rich-text editors set it on prose
 * boxes. A native `<textarea>` or `<input>` with it is still skipped, as is an editing host that
 * also turns its corrections off (the marks of CodeMirror 6, Ace and Monaco), and every known code
 * editor by its container.
 */
export function exclusionReason(element: Element, kind: TextBoxKind): string | undefined {
  if (kind !== "editable") {
    if (isDisabled(element)) return "disabled";
    if (isReadOnly(element)) return "read-only";
  }
  if (isPrivateAutocomplete(attribute(element, "autocomplete"))) return "private autocomplete";
  const editor = codeEditorSelector(element);
  if (editor !== undefined) return `code editor (${editor})`;
  const spellcheck = inheritedAttribute(element, "spellcheck");
  if (spellcheck === "false") {
    if (kind !== "editable") return "spellcheck is off on a native text box";
    if (correctionsOff(element))
      return "spellcheck, autocorrect or autocapitalize are off on an editor";
  }
  if (element.closest('[data-english-tutor="off"]') !== null) {
    return "opted out by data-english-tutor";
  }
  return undefined;
}

/** The attribute rules: true when the field must never be read, checked or touched. */
export function isExcluded(element: Element, kind: TextBoxKind): boolean {
  return exclusionReason(element, kind) !== undefined;
}

/** Why the element is not shown or is under 40x16 CSS pixels, or undefined when it is. */
export function visibilityReason(element: Element, view: Window): string | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width < MIN_BOX_WIDTH || rect.height < MIN_BOX_HEIGHT) {
    return `smaller than ${String(MIN_BOX_WIDTH)}x${String(MIN_BOX_HEIGHT)}`;
  }
  const style = view.getComputedStyle(element);
  if (style.display === "none") return "not visible";
  if (style.visibility === "hidden" || style.visibility === "collapse") return "not visible";
  return Number.parseFloat(style.opacity === "" ? "1" : style.opacity) > 0
    ? undefined
    : "not visible";
}

/** Whether the element is shown and at least 40x16 CSS pixels. */
export function isVisibleAndBigEnough(element: Element, view: Window): boolean {
  return visibilityReason(element, view) === undefined;
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

/** What page mode makes of a focused element that looks like a text box. */
export type Inspection =
  | { found: FoundTextBox }
  | {
      /** A short fixed reason, for the debug log: never the user's text. */
      skip: string;
      /** The element may become usable soon (a modal that is still fading in): look again. */
      transient: boolean;
    };

/** The element an event target is, or the element that holds it. */
function elementOf(target: EventTarget | null): Element | null {
  if (target === null || !("nodeType" in target)) return null;
  const node = target as Node;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** The candidate: a `<textarea>` or `<input>`, the editing host around the element, or a `designMode` body. */
function candidateOf(element: Element): Element | undefined {
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || tag === "input") return element;
  const host = editingHost(element);
  if (host !== undefined) return host;
  // An iframe editor in `designMode` (old TinyMCE and CKEditor setups): the body is the box.
  const doc = element.ownerDocument;
  const body = doc.body as HTMLElement | null;
  return doc.designMode === "on" && body !== null ? body : undefined;
}

/**
 * What page mode makes of the element an event target is in or is. `undefined` means it is not
 * anything like a text box (a button, a link, a paragraph): nothing to say. Otherwise either the
 * text box, or why it is left alone (SPEC section 4.11: the debug log).
 */
export function inspectTextBox(target: EventTarget | null, view: Window): Inspection | undefined {
  const element = elementOf(target);
  if (element === null) return undefined;
  const candidate = candidateOf(element);
  if (candidate === undefined) {
    return element.getAttribute("role")?.trim().toLowerCase() === "textbox"
      ? { skip: "role=textbox but not an editable element", transient: false }
      : undefined;
  }
  const kind =
    textBoxKind(candidate) ?? (candidate.tagName.toLowerCase() === "body" ? "editable" : undefined);
  if (kind === undefined) {
    return candidate.tagName.toLowerCase() === "input"
      ? { skip: "input type is not text", transient: false }
      : undefined;
  }
  const excluded = exclusionReason(candidate, kind);
  if (excluded !== undefined) return { skip: excluded, transient: false };
  const hidden = visibilityReason(candidate, view);
  if (hidden !== undefined) return { skip: hidden, transient: true };
  return { found: { element: candidate as HTMLElement, kind } };
}

/**
 * The text box an event target is in or is, if page mode may use it. For editable content this is
 * the editing host, wherever in it the target is.
 */
export function findTextBox(target: EventTarget | null, view: Window): FoundTextBox | undefined {
  const inspection = inspectTextBox(target, view);
  return inspection !== undefined && "found" in inspection ? inspection.found : undefined;
}
