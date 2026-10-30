import { countWords, isSpaceCode } from "./text";

/** The target maximum number of words per request (SPEC section 5.2). */
export const DEFAULT_CHUNK_WORDS = 2000;

/**
 * The smallest chunk made to spread a text over parallel requests: smaller pieces cost more in
 * repeated prompt than they save in waiting.
 */
export const MIN_PARALLEL_CHUNK_WORDS = 200;

/**
 * A piece of the text sent as one request. `text` is always `original.slice(start, start +
 * text.length)`; the chunks of a text are contiguous and together cover all of it.
 */
export interface Chunk {
  readonly text: string;
  /** UTF-16 offset in the original text. */
  readonly start: number;
}

interface Seg {
  start: number;
  end: number;
}

/**
 * Splits `text` into pieces of at most `maxWords` words (`maxWords <= 0` means the default). It
 * prefers to cut between paragraphs (blank lines); a paragraph that is too long is cut between
 * sentences, and a sentence that is too long between words. White space stays with the text before
 * it, so no chunk is only white space. A text with no words gives no chunks.
 */
export function splitChunks(text: string, maxWords: number = DEFAULT_CHUNK_WORDS): Chunk[] {
  const limit = maxWords > 0 ? Math.max(1, Math.floor(maxWords)) : DEFAULT_CHUNK_WORDS;
  if (countWords(text) === 0) return [];

  // Cut only at the start of an atom, where an atom is a whole paragraph if it fits, else a
  // sentence if it fits, else a run of words.
  const chunks: Chunk[] = [];
  let chunkStart = 0;
  let currentWords = 0;
  for (const atom of atoms(text, limit)) {
    const words = countWords(text.slice(atom.start, atom.end));
    if (words === 0) continue; // blank lines: they stay with the text before them
    if (currentWords > 0 && currentWords + words > limit) {
      chunks.push({ text: text.slice(chunkStart, atom.start), start: chunkStart });
      chunkStart = atom.start;
      currentWords = 0;
    }
    currentWords += words;
  }
  chunks.push({ text: text.slice(chunkStart), start: chunkStart });
  return chunks;
}

/**
 * The largest chunk, in words, for `text`. With one request at a time it is `chunkWords`. With
 * several, the text is spread over them (but never into pieces under 200 words), so a short essay
 * still uses the parallel requests.
 */
export function chunkSizeFor(
  text: string,
  parallel: number,
  chunkWords: number = DEFAULT_CHUNK_WORDS,
): number {
  if (parallel <= 1) return chunkWords;
  const perRequest = Math.ceil(countWords(text) / parallel);
  return Math.min(chunkWords, Math.max(perRequest, MIN_PARALLEL_CHUNK_WORDS));
}

/** Contiguous segments covering `text`, each of at most `maxWords` words (blank-only ones have none). */
function atoms(text: string, maxWords: number): Seg[] {
  const out: Seg[] = [];
  for (const paragraph of splitParagraphs(text)) {
    if (countWords(text.slice(paragraph.start, paragraph.end)) <= maxWords) {
      out.push(paragraph);
      continue;
    }
    for (const sentence of sentences(text, paragraph)) {
      if (countWords(text.slice(sentence.start, sentence.end)) <= maxWords) {
        out.push(sentence);
        continue;
      }
      out.push(...splitWords(text, sentence, maxWords));
    }
  }
  return out;
}

function isBlank(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (!isSpaceCode(text.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * Contiguous segments covering `text`. A paragraph starts at the first non-blank line after a
 * blank line; blank lines belong to the paragraph before them (or to the first one).
 */
export function splitParagraphs(text: string): Seg[] {
  const out: Seg[] = [];
  let start = 0;
  let pos = 0;
  let seenBlank = false;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline >= 0 ? newline : text.length;
    const next = newline >= 0 ? newline + 1 : text.length;
    if (isBlank(text, pos, lineEnd)) {
      seenBlank = true;
    } else if (seenBlank && pos > start) {
      out.push({ start, end: pos });
      start = pos;
      seenBlank = false;
    }
    pos = next;
  }
  out.push({ start, end: text.length });
  return out;
}

const CLOSERS = new Set(['"', "'", ")", "”", "’"]);

/** Splits a paragraph after sentence-ending punctuation that is followed by white space. */
function sentences(text: string, paragraph: Seg): Seg[] {
  const out: Seg[] = [];
  let start = paragraph.start;
  const end = paragraph.end;
  for (let i = paragraph.start; i < end;) {
    const c = text.charAt(i);
    i++;
    if (c !== "." && c !== "!" && c !== "?") continue;
    // Closing quotes and brackets belong to the sentence.
    let j = i;
    while (j < end && CLOSERS.has(text.charAt(j))) j++;
    if (j >= end) break;
    if (!isSpaceCode(text.charCodeAt(j))) continue;
    while (j < end && isSpaceCode(text.charCodeAt(j))) j++;
    if (j < end) {
      out.push({ start, end: j });
      start = j;
    }
    i = j;
  }
  out.push({ start, end });
  return out;
}

/**
 * Cuts a segment into pieces of exactly `maxWords` words (the last may have fewer). A piece ends
 * where the next word begins, so white space stays with the word before it.
 */
function splitWords(text: string, seg: Seg, maxWords: number): Seg[] {
  const out: Seg[] = [];
  let start = seg.start;
  let words = 0;
  let inWord = false;
  for (let i = seg.start; i < seg.end; i++) {
    if (isSpaceCode(text.charCodeAt(i))) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      if (words === maxWords) {
        out.push({ start, end: i });
        start = i;
        words = 0;
      }
      words++;
    }
  }
  out.push({ start, end: seg.end });
  return out;
}
