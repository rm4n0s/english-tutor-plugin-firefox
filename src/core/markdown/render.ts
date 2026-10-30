import { renderInline } from "./inline";

/** Block quotes nest only this deep; deeper `>` markers are shown as text. */
const MAX_QUOTE_DEPTH = 6;

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
const ORDERED_ITEM = /^ {0,3}\d{1,9}[.)]\s/;
const INDENTED_CODE = /^(?: {4}|\t)/;

function trimEnd(line: string): string {
  return line.replace(/[ \t]+$/, "");
}

/** One line of a paragraph, and whether it ends with a hard line break (two spaces). */
interface ParagraphLine {
  text: string;
  hardBreak: boolean;
}

/** The text of a paragraph. A hard line break (two spaces or a backslash) becomes `\n`. */
function paragraphText(lines: readonly ParagraphLine[]): string {
  let out = "";
  lines.forEach((line, index) => {
    const last = index === lines.length - 1;
    let text = line.text;
    let separator = " ";
    if (!last && line.hardBreak) separator = "\n";
    else if (!last && /(?<!\\)(?:\\\\)*\\$/.test(text)) {
      text = text.slice(0, -1);
      separator = "\n";
    }
    out += text + (last ? "" : separator);
  });
  return out;
}

/** Whether the lines from `i` on (after blank lines) continue the list with another item. */
function listContinues(lines: readonly string[], i: number, ordered: boolean): boolean {
  let j = i;
  while (j < lines.length && trimEnd(lines[j] ?? "") === "") j++;
  const line = trimEnd(lines[j] ?? "");
  return LIST_ITEM.test(line) && ORDERED_ITEM.test(line) === ordered;
}

function blocks(doc: Document, lines: readonly string[], quoteDepth: number): Node[] {
  const out: Node[] = [];
  let paragraph: ParagraphLine[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    const p = doc.createElement("p");
    p.append(...renderInline(doc, paragraphText(paragraph)));
    out.push(p);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = trimEnd(raw);
    const trimmed = line.trim();

    if (trimmed === "") {
      flush();
    } else if (trimmed.startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith("```"); i++) {
        code.push(lines[i] ?? "");
      }
      out.push(codeBlock(doc, code.join("\n")));
    } else if (paragraph.length === 0 && INDENTED_CODE.test(raw)) {
      const code: string[] = [];
      for (; i < lines.length; i++) {
        const next = lines[i] ?? "";
        if (INDENTED_CODE.test(next)) code.push(next.replace(INDENTED_CODE, ""));
        else if (trimEnd(next) === "") code.push("");
        else break;
      }
      i--;
      while (code.length > 0 && code[code.length - 1] === "") code.pop();
      out.push(codeBlock(doc, code.join("\n")));
    } else if (HEADING.test(trimmed)) {
      flush();
      const match = HEADING.exec(trimmed);
      const level = Math.min((match?.[1]?.length ?? 1) + 2, 6); // the panel's own title is above
      const heading = doc.createElement(`h${String(level)}`);
      const content = (match?.[2] ?? "").replace(/(^|\s+)#+\s*$/, "").trim();
      heading.append(...renderInline(doc, content));
      out.push(heading);
    } else if (trimmed.startsWith(">") && quoteDepth < MAX_QUOTE_DEPTH) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && (lines[i] ?? "").trim().startsWith(">"); i++) {
        quote.push((lines[i] ?? "").trim().replace(/^> ?/, ""));
      }
      i--;
      const blockquote = doc.createElement("blockquote");
      blockquote.append(...blocks(doc, quote, quoteDepth + 1));
      out.push(blockquote);
    } else if (LIST_ITEM.test(line)) {
      flush();
      const ordered = ORDERED_ITEM.test(line);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const current = trimEnd(lines[i] ?? "");
        const match = LIST_ITEM.exec(current);
        if (match !== null && ORDERED_ITEM.test(current) === ordered) {
          items.push(match[2] ?? "");
        } else if (current === "" && items.length > 0 && listContinues(lines, i, ordered)) {
          // A blank line between items of the same list does not end it.
        } else if (
          current !== "" &&
          items.length > 0 &&
          current.startsWith("  ") &&
          match === null
        ) {
          // A more indented line continues the item above it.
          items[items.length - 1] = `${items[items.length - 1] ?? ""} ${current.trim()}`;
        } else break;
      }
      i--;
      const list = doc.createElement(ordered ? "ol" : "ul");
      for (const item of items) {
        const li = doc.createElement("li");
        li.append(...renderInline(doc, item));
        list.append(li);
      }
      out.push(list);
    } else {
      paragraph.push({ text: trimmed, hardBreak: / {2,}$/.test(raw) });
    }
  }
  flush();
  return out;
}

function codeBlock(doc: Document, text: string): HTMLElement {
  const pre = doc.createElement("pre");
  const code = doc.createElement("code");
  code.textContent = text;
  pre.append(code);
  return pre;
}

/**
 * Turns a markdown explanation from an LLM into DOM nodes (SPEC section 5.9). The text is
 * untrusted, so this builds nodes with `createElement` and text nodes and never parses HTML:
 * raw HTML is shown as text, an image as its alt text, and a link only for `http` / `https`
 * addresses with a host. The only elements it creates are `p h1-h6 strong em code pre ul ol li
 * blockquote a br`, and the only attributes are `href`, `target` and `rel` on `a`.
 *
 * It follows the desktop app's `internal/web/markdown.go`: paragraphs, headings (`#` is an `h3`,
 * capped at `h6`), bold, italic, inline code, fenced and indented code blocks, ordered and
 * unordered lists, block quotes and links. The document is passed in so that the renderer works in
 * a page frame and in tests.
 */
export function renderMarkdown(doc: Document, markdown: string): DocumentFragment {
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const fragment = doc.createDocumentFragment();
  fragment.append(...blocks(doc, lines, 0));
  return fragment;
}
