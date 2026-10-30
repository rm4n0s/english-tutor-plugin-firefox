/**
 * The text of a text box as a string, and the way back from a position in the string to the
 * page's own nodes (SPEC section 4.11). For a `<textarea>` or `<input>` the text is its value and
 * the positions are the same numbers. For editable content the text is read from the text nodes:
 * block elements and `<br>` become `\n`, and every text node remembers where its characters are,
 * so that an issue can be turned into a DOM `Range` (the underlines of step 14) and a caret into
 * an offset. Offsets are UTF-16 units, as everywhere.
 */

/** A text node and where its characters are in the text. */
export interface TextSegment {
  readonly node: Text;
  /** Offset in the text of the node's first character. */
  readonly start: number;
  /** Exclusive: `start` plus the node's length. */
  readonly end: number;
}

/** A position inside a text node. */
export interface DomPosition {
  readonly node: Text;
  readonly offset: number;
}

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "TR",
  "UL",
]);

/** Elements whose content is not text the user wrote. */
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);

/** Beyond this many nodes the text is not read (a document, not a text box). */
const MAX_NODES = 100_000;

function isBlank(text: string): boolean {
  return /^[ \t\n\r\f]*$/.test(text);
}

function isBlock(node: Node | null): boolean {
  return node !== null && node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName);
}

/** Whether the `<br>` only holds the end of a line open: the last thing in its block, after text. */
function isPlaceholderBreak(br: Node): boolean {
  let next = br.nextSibling;
  while (next !== null && next.nodeType === 3 && isBlank((next as Text).data))
    next = next.nextSibling;
  if (next !== null) return false;
  const previous = br.previousSibling;
  if (previous === null) return false;
  if (previous.nodeType === 1 && (previous as Element).tagName === "BR") return false;
  return isBlock(br.parentNode);
}

/** The text of editable content with its mapping back to the text nodes. */
export class EditableText {
  readonly text: string;
  readonly segments: readonly TextSegment[];
  private readonly bySegment: ReadonlyMap<Node, TextSegment>;

  constructor(text: string, segments: readonly TextSegment[]) {
    this.text = text;
    this.segments = segments;
    this.bySegment = new Map(segments.map((segment) => [segment.node, segment]));
  }

  /**
   * The position in a text node of `offset`. `side` says which node wins at the boundary of two:
   * a range starts in the node whose text continues after the offset (`start`) and ends in the
   * node whose text came before it (`end`). An offset on a line break that no node holds, or past
   * the end, lands at the nearest node's edge. Undefined only when there are no text nodes.
   */
  positionAt(offset: number, side: "start" | "end"): DomPosition | undefined {
    const segments = this.segments;
    if (segments.length === 0) return undefined;
    if (side === "start") {
      // The first segment that ends after the offset.
      const index = this.firstIndex((segment) => segment.end > offset);
      const segment = segments[index];
      if (segment === undefined) {
        const last = segments[segments.length - 1];
        return last === undefined ? undefined : { node: last.node, offset: last.end - last.start };
      }
      return { node: segment.node, offset: Math.max(0, offset - segment.start) };
    }
    // The last segment that starts before the offset.
    const index = this.firstIndex((segment) => segment.start >= offset) - 1;
    const segment = segments[index];
    if (segment === undefined) {
      const first = segments[0];
      return first === undefined ? undefined : { node: first.node, offset: 0 };
    }
    return { node: segment.node, offset: Math.min(segment.end, offset) - segment.start };
  }

  /** A `Range` over `[start, end)` of the text, or undefined when there are no text nodes. */
  rangeFor(doc: Document, start: number, end: number): Range | undefined {
    const from = this.positionAt(start, "start");
    const to = this.positionAt(end, "end");
    if (from === undefined || to === undefined) return undefined;
    const range = doc.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  }

  /**
   * The text offset of a DOM position (a caret or a selection end): a text node and an offset in
   * it, or an element and a child index. Undefined when the position is not in this text.
   */
  offsetOf(node: Node, offset: number): number | undefined {
    const own = this.bySegment.get(node);
    if (own !== undefined) return own.start + Math.min(offset, own.end - own.start);
    if (node.nodeType === 3) return undefined;
    const child = node.childNodes[offset];
    if (child !== undefined) {
      // The first text at or after the child.
      for (const segment of this.segments) {
        if (child === segment.node || child.contains(segment.node)) return segment.start;
        if (child.compareDocumentPosition(segment.node) & 4 /* FOLLOWING */) return segment.start;
      }
      return this.text.length;
    }
    // After the last child: the end of the last text inside the element.
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const segment = this.segments[i];
      if (segment !== undefined && node.contains(segment.node)) return segment.end;
    }
    return undefined;
  }

  private firstIndex(predicate: (segment: TextSegment) => boolean): number {
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const segment = this.segments[middle];
      if (segment !== undefined && predicate(segment)) high = middle;
      else low = middle + 1;
    }
    return low;
  }
}

/**
 * Reads the text of an editing host: its text nodes in order, a `\n` for each `<br>` (except one
 * that only ends a line) and between blocks. White space that only formats the markup between
 * blocks is left out unless the host keeps white space (`white-space: pre...`). Text nodes keep
 * their characters as they are, so that every character of the text is a character of a node.
 */
export function readEditableText(host: Element, view: Window): EditableText {
  const preserve = view.getComputedStyle(host).whiteSpace.startsWith("pre");
  let text = "";
  const segments: TextSegment[] = [];
  let needBreak = false;
  let nodes = 0;

  const separate = (): void => {
    if (needBreak && text !== "" && !text.endsWith("\n")) text += "\n";
    needBreak = false;
  };

  const walk = (node: Node): void => {
    if (++nodes > MAX_NODES) return;
    if (node.nodeType === 3) {
      const data = (node as Text).data;
      if (data === "") return;
      if (!preserve && isBlank(data) && (node.parentNode === host || isBlock(node.parentNode))) {
        // Formatting between blocks, or at the edges of one, is not text.
        const before = node.previousSibling;
        const after = node.nextSibling;
        if (before === null || after === null || isBlock(before) || isBlock(after)) return;
      }
      separate();
      segments.push({ node: node as Text, start: text.length, end: text.length + data.length });
      text += data;
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (SKIPPED_TAGS.has(element.tagName)) return;
    if (element.tagName === "BR") {
      if (isPlaceholderBreak(element)) return;
      separate();
      text += "\n";
      return;
    }
    const block = BLOCK_TAGS.has(element.tagName);
    if (block) needBreak = true;
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block) needBreak = true;
  };

  for (const child of Array.from(host.childNodes)) walk(child);
  return new EditableText(text, segments);
}
