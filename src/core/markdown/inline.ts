import { parseLinkTarget } from "./link";

/** Inline markers nest only this deep; deeper text is shown as it is. */
const MAX_INLINE_DEPTH = 12;

/** The characters a backslash escapes. */
const ESCAPABLE = "\\`*_{}[]()#+-.!<>|~";

/** A link written as `[text](target)` at the start of a string. `length` is what it spans. */
interface ParsedLink {
  text: string;
  target: string;
  length: number;
}

/**
 * Reads `[text](target)` at the start of `s`. Brackets in the text must balance; a title after the
 * address (`url "title"`) is not part of it.
 */
export function parseLink(s: string): ParsedLink | undefined {
  let depth = 0;
  let end = -1;
  for (let j = 0; j < s.length && end < 0; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) end = j;
    }
  }
  if (end < 0 || end + 1 >= s.length || s[end + 1] !== "(") return undefined;
  depth = 0;
  for (let j = end + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        let target = s.slice(end + 2, j).trim();
        const space = target.search(/[ \t]/);
        if (space >= 0) target = target.slice(0, space);
        return { text: s.slice(1, end), target, length: j + 1 };
      }
    }
  }
  return undefined;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The character (code point) that ends just before index `i`, or "". */
function previousChar(s: string, i: number): string {
  if (i <= 0) return "";
  const low = s.charCodeAt(i - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  return String.fromCodePoint(s.codePointAt(start) ?? 0);
}

/** The character (code point) that starts at index `i`, or "". */
function nextChar(s: string, i: number): string {
  const code = s.codePointAt(i);
  return code === undefined ? "" : String.fromCodePoint(code);
}

/**
 * Whether the `*` or `_` at `s[i]` can open emphasis: the next character is not a space and not
 * the same marker, and an underscore inside a word (snake_case) does not count.
 */
function emphasisOpens(s: string, i: number): boolean {
  const next = s[i + 1];
  if (next === undefined || next === " " || next === s[i]) return false;
  if (s[i] === "_" && i > 0 && WORD_CHAR.test(previousChar(s, i))) return false;
  return true;
}

/** The index of the marker that closes the emphasis opened at `s[start]`, or -1. */
function emphasisEnd(s: string, start: number): number {
  const marker = s[start];
  for (let j = start + 1; j < s.length; j++) {
    if (s[j] !== marker || s[j - 1] === " ") continue;
    if (marker === "_" && j + 1 < s.length && WORD_CHAR.test(nextChar(s, j + 1))) continue;
    return j;
  }
  return -1;
}

/**
 * Renders the inline markdown of `source` into nodes: code, bold, italic, links, escapes and hard
 * line breaks (a `\n` in `source`). Markers that find no partner stay in the text. Every character
 * that is not syntax becomes a text node, so nothing can turn into an element.
 */
export function renderInline(doc: Document, source: string, inLink = false, depth = 0): Node[] {
  if (depth > MAX_INLINE_DEPTH) return [doc.createTextNode(source)];
  const out: Node[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") out.push(doc.createTextNode(text));
    text = "";
  };
  const element = (tag: "strong" | "em" | "code" | "br", children: Node[] = []): HTMLElement => {
    flush();
    const created = doc.createElement(tag);
    created.append(...children);
    out.push(created);
    return created;
  };

  const s = source;
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === "\n") {
      element("br");
      i++;
    } else if (c === "\\" && i + 1 < s.length && ESCAPABLE.includes(s.charAt(i + 1))) {
      text += s.charAt(i + 1);
      i += 2;
    } else if (c === "`") {
      let n = 1;
      while (s.charAt(i + n) === "`") n++;
      const fence = "`".repeat(n);
      const end = s.indexOf(fence, i + n);
      const code =
        end >= 0
          ? s
              .slice(i + n, end)
              .replaceAll("\n", " ")
              .trim()
          : "";
      if (end >= 0 && code !== "") {
        element("code", [doc.createTextNode(code)]);
        i = end + n;
      } else {
        text += fence;
        i += n;
      }
    } else if (s.startsWith("**", i) || s.startsWith("__", i)) {
      const marker = s.slice(i, i + 2);
      let end = s.indexOf(marker, i + 2);
      // In a longer run of markers (`***`) the last two close the bold text.
      while (end >= 0 && s.charAt(end + 2) === marker.charAt(0)) end++;
      if (end > i + 2) {
        element("strong", renderInline(doc, s.slice(i + 2, end), inLink, depth + 1));
        i = end + 2;
      } else {
        text += marker;
        i += 2;
      }
    } else if ((c === "*" || c === "_") && emphasisOpens(s, i)) {
      const end = emphasisEnd(s, i);
      if (end > i) {
        element("em", renderInline(doc, s.slice(i + 1, end), inLink, depth + 1));
        i = end + 1;
      } else {
        text += c;
        i++;
      }
    } else if (c === "!" && s.charAt(i + 1) === "[") {
      const link = parseLink(s.slice(i + 1));
      if (link === undefined) {
        text += "!";
        i++;
      } else {
        // An image is never loaded: its alt text stays as plain text.
        text += link.text;
        i += 1 + link.length;
      }
    } else if (c === "[") {
      const link = parseLink(s.slice(i));
      if (link === undefined) {
        text += "[";
        i++;
        continue;
      }
      i += link.length;
      const href = inLink ? undefined : parseLinkTarget(link.target);
      if (href === undefined) {
        // Not a link: only its text is shown.
        for (const node of renderInline(doc, link.text, inLink, depth + 1)) {
          flush();
          out.push(node);
        }
        continue;
      }
      flush();
      const anchor = doc.createElement("a");
      anchor.setAttribute("href", href);
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer nofollow");
      if (link.text.trim() === "") anchor.append(doc.createTextNode(href));
      else anchor.append(...renderInline(doc, link.text, true, depth + 1));
      out.push(anchor);
    } else {
      text += c;
      i++;
    }
  }
  flush();
  return out;
}
