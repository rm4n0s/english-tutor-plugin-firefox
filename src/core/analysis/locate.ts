import type { Issue } from "./parse";
import {
  codePointAt,
  codePointBefore,
  isBoundary,
  isSpaceCode,
  isWordCodePoint,
  lowerCodePoint,
  trimSpace,
} from "./text";

/** An issue found in the text. `start` and `end` are UTF-16 offsets, `end` exclusive. */
export interface Placed {
  readonly issue: Issue;
  readonly start: number;
  readonly end: number;
}

export interface LocateResult {
  /** Sorted by `start` and never overlapping. */
  readonly placed: readonly Placed[];
  /** Issues whose snippet is not in the text at all. The UI shows this count. */
  readonly unplaced: number;
  /** Issues dropped because they overlap an earlier one (or report the same span twice). */
  readonly overlapping: number;
}

export const EMPTY_LOCATE_RESULT: LocateResult = { placed: [], unplaced: 0, overlapping: 0 };

/**
 * Appends the placed issues of `next`, with their offsets moved by `offset` (the start of the
 * chunk `next` was located in), and adds up the counters. Chunks are disjoint, so the result
 * stays sorted and free of overlaps when `next`'s chunk comes after the chunks already merged.
 */
export function appendLocated(all: LocateResult, next: LocateResult, offset: number): LocateResult {
  return {
    placed: [
      ...all.placed,
      ...next.placed.map((p) => ({ issue: p.issue, start: p.start + offset, end: p.end + offset })),
    ],
    unplaced: all.unplaced + next.unplaced,
    overlapping: all.overlapping + next.overlapping,
  };
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function spanKey(span: Span): string {
  return `${String(span.start)}:${String(span.end)}`;
}

/**
 * Finds each issue's snippet in `text` (SPEC section 5.3):
 *
 * 1. A snippet that occurs once is used.
 * 2. If it occurs several times, the occurrence on word boundaries whose neighbouring text best
 *    matches the issue's context wins; remaining ties go to the first occurrence not already
 *    taken by an earlier issue.
 * 3. If it does not occur, a case-insensitive match that ignores differences in white space and
 *    typographic quotes and dashes is tried, and mapped back to offsets in `text`.
 * 4. Issues that cannot be found are counted in `unplaced`; issues that overlap an earlier one in
 *    the text are dropped and counted in `overlapping`.
 *
 * Offsets never fall inside a surrogate pair. Never throws.
 */
export function locate(text: string, issues: readonly Issue[]): LocateResult {
  const claimed = new Set<string>();
  const found: Placed[] = [];
  let unplaced = 0;
  let folded: FoldedText | undefined;
  const foldedText = () => (folded ??= foldText(text));

  for (const issue of issues) {
    const span = findIssue(text, issue, claimed, foldedText);
    if (span === undefined) {
      unplaced++;
      continue;
    }
    claimed.add(spanKey(span));
    found.push({ issue, start: span.start, end: span.end });
  }

  // Stable, so two issues starting at the same place keep the model's order.
  found.sort((a, b) => a.start - b.start);
  const placed: Placed[] = [];
  let overlapping = 0;
  let lastEnd = 0;
  for (const p of found) {
    if (p.start < lastEnd) {
      overlapping++;
      continue;
    }
    placed.push(p);
    lastEnd = p.end;
  }
  return { placed, unplaced, overlapping };
}

function findIssue(
  text: string,
  issue: Issue,
  claimed: ReadonlySet<string>,
  folded: () => FoldedText,
): Span | undefined {
  const snippet = trimSpace(issue.text);
  if (snippet === "") return undefined;
  let candidates = occurrences(text, snippet);
  if (candidates.length === 0) candidates = folded().occurrences(snippet);
  const first = candidates[0];
  if (first === undefined) return undefined;
  if (candidates.length === 1) return first;
  return bestCandidate(text, candidates, issue, claimed);
}

/**
 * Every place `snippet` occurs in `text`, overlapping ones included ("aa" occurs twice in "aaa").
 * A match that starts or ends inside a surrogate pair is not an occurrence.
 */
export function occurrences(text: string, snippet: string): Span[] {
  const out: Span[] = [];
  if (snippet === "") return out;
  for (let from = 0; from <= text.length - snippet.length;) {
    const start = text.indexOf(snippet, from);
    if (start < 0) break;
    from = start + 1;
    const end = start + snippet.length;
    if (isBoundary(text, start) && isBoundary(text, end)) out.push({ start, end });
  }
  return out;
}

interface Scored {
  span: Span;
  boundary: boolean;
  context: number;
}

/**
 * Picks among several occurrences: word-boundary matches first, then the best context match, then
 * the first one not claimed by an earlier issue.
 */
function bestCandidate(
  text: string,
  candidates: readonly Span[],
  issue: Issue,
  claimed: ReadonlySet<string>,
): Span {
  const list: Scored[] = candidates.map((span) => ({
    span,
    boundary: onWordBoundaries(text, span),
    context: contextScore(text, span, issue),
  }));
  list.sort((a, b) => (a.boundary !== b.boundary ? (a.boundary ? -1 : 1) : b.context - a.context));
  // Only the best-scoring group competes on "first unclaimed"; if all of it is claimed, fall back
  // to the next group, then to the best one (which the overlap rule will drop).
  for (let start = 0; start < list.length;) {
    const head = list[start];
    if (head === undefined) break;
    let end = start + 1;
    while (end < list.length) {
      const next = list[end];
      if (next?.boundary !== head.boundary || next.context !== head.context) break;
      end++;
    }
    const group = list.slice(start, end).sort((a, b) => a.span.start - b.span.start);
    list.splice(start, group.length, ...group);
    for (const candidate of group) {
      if (!claimed.has(spanKey(candidate.span))) return candidate.span;
    }
    start = end;
  }
  return list[0]?.span ?? candidates[0] ?? { start: 0, end: 0 };
}

/**
 * True when the span does not start or end inside a word: a letter or digit at the edge of the
 * span must not be joined to a letter or digit outside it.
 */
function onWordBoundaries(text: string, span: Span): boolean {
  const first = codePointAt(text, span.start);
  const last = codePointBefore(text, span.end);
  if (
    isWordCodePoint(first) &&
    span.start > 0 &&
    isWordCodePoint(codePointBefore(text, span.start))
  ) {
    return false;
  }
  if (
    isWordCodePoint(last) &&
    span.end < text.length &&
    isWordCodePoint(codePointAt(text, span.end))
  ) {
    return false;
  }
  return true;
}

/**
 * The number of characters of `contextBefore` that match the text just before the span (counted
 * backwards), plus the number of characters of `contextAfter` that match the text just after it.
 * White space at the edge of the contexts is ignored because models often trim it.
 */
function contextScore(text: string, span: Span, issue: Issue): number {
  let beforeEnd = span.start;
  while (beforeEnd > 0 && isSpaceCode(text.charCodeAt(beforeEnd - 1))) beforeEnd--;
  let afterStart = span.end;
  while (afterStart < text.length && isSpaceCode(text.charCodeAt(afterStart))) afterStart++;
  let contextEnd = issue.contextBefore.length;
  while (contextEnd > 0 && isSpaceCode(issue.contextBefore.charCodeAt(contextEnd - 1)))
    contextEnd--;
  let contextStart = 0;
  while (
    contextStart < issue.contextAfter.length &&
    isSpaceCode(issue.contextAfter.charCodeAt(contextStart))
  ) {
    contextStart++;
  }
  return (
    commonSuffix(text, beforeEnd, issue.contextBefore, contextEnd) +
    commonPrefix(text, afterStart, issue.contextAfter, contextStart)
  );
}

/** How many code points of `a[..aEnd]` and `b[..bEnd]` are equal, counted backwards. */
function commonSuffix(a: string, aEnd: number, b: string, bEnd: number): number {
  let n = 0;
  while (aEnd > 0 && bEnd > 0) {
    const ca = codePointBefore(a, aEnd);
    if (ca !== codePointBefore(b, bEnd)) break;
    const width = ca >= 0x10000 ? 2 : 1;
    aEnd -= width;
    bEnd -= width;
    n++;
  }
  return n;
}

/** How many code points of `a[aStart..]` and `b[bStart..]` are equal. */
function commonPrefix(a: string, aStart: number, b: string, bStart: number): number {
  let n = 0;
  while (aStart < a.length && bStart < b.length) {
    const ca = codePointAt(a, aStart);
    if (ca !== codePointAt(b, bStart)) break;
    const width = ca >= 0x10000 ? 2 : 1;
    aStart += width;
    bStart += width;
    n++;
  }
  return n;
}

/**
 * A lower-cased copy of a text in which every run of white space is one space and typographic
 * quotes and dashes are plain, with, for each UTF-16 unit of the copy, the span of the original
 * text it came from.
 */
class FoldedText {
  readonly s: string;
  private readonly starts: readonly number[];
  private readonly ends: readonly number[];

  constructor(s: string, starts: readonly number[], ends: readonly number[]) {
    this.s = s;
    this.starts = starts;
    this.ends = ends;
  }

  /** Finds `snippet` (folded the same way) and maps the matches back to spans of the original text. */
  occurrences(snippet: string): Span[] {
    const needle = trimSpace(foldText(snippet).s);
    if (needle === "") return [];
    const out: Span[] = [];
    for (const match of occurrences(this.s, needle)) {
      const start = this.starts[match.start];
      const end = this.ends[match.end - 1];
      if (start !== undefined && end !== undefined) out.push({ start, end });
    }
    return out;
  }
}

function foldCodePoint(cp: number): string {
  switch (cp) {
    case 0x2018: // ‘
    case 0x2019: // ’
    case 0x201b: // ‛
    case 0x02bc: // ʼ
      return "'";
    case 0x201c: // “
    case 0x201d: // ”
    case 0x201f: // ‟
      return '"';
    case 0x2010: // ‐
    case 0x2011: // ‑
    case 0x2012: // ‒
    case 0x2013: // –
    case 0x2014: // —
    case 0x2212: // −
      return "-";
    default:
      return lowerCodePoint(cp);
  }
}

function foldText(text: string): FoldedText {
  let s = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let lastSpace = true; // drops leading white space
  for (let i = 0; i < text.length;) {
    const cp = codePointAt(text, i);
    const start = i;
    i += cp >= 0x10000 ? 2 : 1;
    if (cp <= 0xffff && isSpaceCode(cp)) {
      if (lastSpace) {
        // The run of spaces extends the previous space.
        if (ends.length > 0) ends[ends.length - 1] = i;
        continue;
      }
      lastSpace = true;
      s += " ";
      starts.push(start);
      ends.push(i);
      continue;
    }
    lastSpace = false;
    const folded = foldCodePoint(cp);
    s += folded;
    // One entry per UTF-16 unit of the folded character.
    for (let units = folded.length; units > 0; units--) {
      starts.push(start);
      ends.push(i);
    }
  }
  return new FoldedText(s, starts, ends);
}
