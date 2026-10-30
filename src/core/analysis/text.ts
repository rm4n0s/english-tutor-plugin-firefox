/**
 * Text helpers shared by the analysis code. Offsets are UTF-16 code units (SPEC section 5). The
 * reference implementation works in UTF-8 bytes; these helpers keep its rules (what is a space,
 * what is a word character, what lower-casing does) on JavaScript strings, and never cut a
 * surrogate pair.
 */

/** Go's `unicode.IsSpace`: the characters the reference treats as white space. */
export function isSpaceCode(code: number): boolean {
  if (code <= 0xff)
    return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0x85 || code === 0xa0;
  return (
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;

/** A letter or a decimal digit, as the reference's `isWordRune`. `cp` is a code point. */
export function isWordCodePoint(cp: number): boolean {
  return LETTER_OR_DIGIT.test(String.fromCodePoint(cp));
}

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * True when `index` lies between two characters, so a span may start or end there. False inside a
 * surrogate pair. `0` and `text.length` are always boundaries.
 */
export function isBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  return !(isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1)));
}

/** The code point that starts at `index`. A lone surrogate is its own code point. */
export function codePointAt(text: string, index: number): number {
  return text.codePointAt(index) ?? 0;
}

/** The code point that ends just before `index` (`index > 0`). */
export function codePointBefore(text: string, index: number): number {
  const low = text.charCodeAt(index - 1);
  if (isLowSurrogate(low) && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (isHighSurrogate(high)) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  }
  return low;
}

function widthOf(cp: number): number {
  return cp >= 0x10000 ? 2 : 1;
}

/** `s` without leading white space (Go's `TrimLeftFunc(s, unicode.IsSpace)`). */
export function trimStartSpace(s: string): string {
  let i = 0;
  while (i < s.length && isSpaceCode(s.charCodeAt(i))) i++;
  return s.slice(i);
}

/** `s` without trailing white space. */
export function trimEndSpace(s: string): string {
  let i = s.length;
  while (i > 0 && isSpaceCode(s.charCodeAt(i - 1))) i--;
  return s.slice(0, i);
}

/** `s` without white space at both ends (Go's `strings.TrimSpace`). */
export function trimSpace(s: string): string {
  return trimStartSpace(trimEndSpace(s));
}

/** The pieces of `s` between runs of white space (Go's `strings.Fields`). */
export function fields(s: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (isSpaceCode(s.charCodeAt(i))) {
      if (start >= 0) out.push(s.slice(start, i));
      start = -1;
    } else if (start < 0) {
      start = i;
    }
  }
  if (start >= 0) out.push(s.slice(start));
  return out;
}

/** The number of words: runs of characters that are not white space. */
export function countWords(s: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    if (isSpaceCode(s.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The number of code points ("characters" in the limits of SPEC section 5.2). */
export function countCodePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += widthOf(codePointAt(s, i))) n++;
  return n;
}

/** The first `n` code points of `s`. */
export function takeCodePoints(s: string, n: number): string {
  let i = 0;
  for (let taken = 0; taken < n && i < s.length; taken++) i += widthOf(codePointAt(s, i));
  return s.slice(0, i);
}

/** The last `n` code points of `s`. */
export function takeLastCodePoints(s: string, n: number): string {
  let i = s.length;
  for (let taken = 0; taken < n && i > 0; taken++) i -= widthOf(codePointBefore(s, i));
  return s.slice(i);
}

/** `s` with every lone surrogate replaced by U+FFFD, as UTF-8 decoding does in the reference. */
export function wellFormed(s: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (isHighSurrogate(code) && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) {
      i++;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      out += s.slice(from, i) + "�";
      from = i + 1;
    }
  }
  return from === 0 ? s : out + s.slice(from);
}

const ASCII = /^\p{ASCII}*$/u;

/**
 * Lower-case one code point at a time, like the reference's `strings.ToLower`. A whole-string
 * `toLowerCase` also looks at the neighbours (a final sigma), so the same snippet would not
 * lower-case the same in two places. U+0130 becomes a plain `i`, as in the reference.
 */
export function lowerCase(s: string): string {
  if (ASCII.test(s)) return s.toLowerCase();
  let out = "";
  for (let i = 0; i < s.length;) {
    const cp = codePointAt(s, i);
    i += widthOf(cp);
    out += lowerCodePoint(cp);
  }
  return out;
}

export function lowerCodePoint(cp: number): string {
  if (cp < 0x80) return String.fromCharCode(cp).toLowerCase();
  return cp === 0x130 ? "i" : String.fromCodePoint(cp).toLowerCase();
}
