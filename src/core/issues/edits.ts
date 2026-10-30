/**
 * Edits of a text and what they do to the issues (SPEC section 5.5). No DOM: the tutor page uses
 * it for its textarea, and page mode (steps 13 to 15) for each web text box. Positions are UTF-16
 * offsets, like everywhere else.
 */

/** One edit: `removed` units at `start` of the old text were replaced by `added` new units. */
export interface Edit {
  readonly start: number;
  readonly removed: number;
  readonly added: number;
}

/** Something with a range in the text. */
export interface Ranged {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The edit that turns `oldText` into `newText`: the part between their common prefix and common
 * suffix. Returns undefined when the texts are equal. The edit never starts or ends inside a
 * surrogate pair, so that replacing one emoji by another is one whole edit.
 */
export function diffText(oldText: string, newText: string): Edit | undefined {
  if (oldText === newText) return undefined;
  const shortest = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < shortest && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  // Do not stop between the two halves of a pair.
  if (
    prefix > 0 &&
    isHighSurrogate(oldText.charCodeAt(prefix - 1)) &&
    (isLowSurrogate(oldText.charCodeAt(prefix)) || isLowSurrogate(newText.charCodeAt(prefix)))
  ) {
    prefix--;
  }
  let suffix = 0;
  const room = shortest - prefix;
  while (
    suffix < room &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (
    suffix > 0 &&
    isLowSurrogate(oldText.charCodeAt(oldText.length - suffix)) &&
    (isHighSurrogate(oldText.charCodeAt(oldText.length - suffix - 1)) ||
      isHighSurrogate(newText.charCodeAt(newText.length - suffix - 1)))
  ) {
    suffix--;
  }
  return {
    start: prefix,
    removed: oldText.length - prefix - suffix,
    added: newText.length - prefix - suffix,
  };
}

/** Where `edit` ends in the old text. */
function editEnd(edit: Edit): number {
  return edit.start + edit.removed;
}

/**
 * Whether an edit touches a range: it ends at or after the range's start and starts at or before
 * its end, so typing right before or right after a word counts (SPEC section 5.5).
 */
export function touches(range: Ranged, edit: Edit): boolean {
  return editEnd(edit) >= range.start && edit.start <= range.end;
}

/**
 * The range as it is after the edit, or null when the edit touched it (it is gone). An edit that
 * ends strictly before the range shifts it by the net length change; one that starts strictly
 * after the range's end leaves it alone.
 */
export function rebaseRange(range: Ranged, edit: Edit): Ranged | null {
  if (touches(range, edit)) return null;
  if (editEnd(edit) < range.start) {
    const delta = edit.added - edit.removed;
    return { start: range.start + delta, end: range.end + delta };
  }
  return range;
}

/**
 * The issues after the edit, in the same order: the ones the edit touched are dropped, the ones
 * after it move. Issues that stay and do not move are returned as they are (the same objects).
 */
export function rebaseIssues<T extends Ranged>(issues: readonly T[], edit: Edit): T[] {
  const delta = edit.added - edit.removed;
  const result: T[] = [];
  for (const issue of issues) {
    const moved = rebaseRange(issue, edit);
    if (moved === null) continue;
    result.push(moved === issue || delta === 0 ? issue : { ...issue, ...moved });
  }
  return result;
}

/** The range after all `edits`, applied in order, or null when one of them touched it. */
export function rebaseRangeAcross(range: Ranged, edits: readonly Edit[]): Ranged | null {
  let current: Ranged | null = range;
  for (const edit of edits) {
    if (current === null) return null;
    current = rebaseRange(current, edit);
  }
  return current;
}

/** The most edits kept while a check runs (SPEC section 5.5). */
export const EDIT_LOG_LIMIT = 100_000;

/**
 * The edits made while a check runs, in order. When more arrive than the limit, or something
 * happens that is not an edit (a text was loaded), the log can no longer rebase a result and
 * `edits` is undefined: the result is discarded.
 */
export class EditLog {
  private readonly limit: number;
  private entries: Edit[] = [];
  private broken = false;

  constructor(limit = EDIT_LOG_LIMIT) {
    this.limit = limit;
  }

  /** Starts a new log: a check begins. */
  clear(): void {
    this.entries = [];
    this.broken = false;
  }

  push(edit: Edit): void {
    if (this.broken) return;
    if (this.entries.length >= this.limit) {
      this.broken = true;
      this.entries = [];
      return;
    }
    this.entries.push(edit);
  }

  /** The text changed in a way the log cannot describe. */
  invalidate(): void {
    this.broken = true;
    this.entries = [];
  }

  /** True when the log overflowed or was invalidated. */
  get overflowed(): boolean {
    return this.broken;
  }

  get size(): number {
    return this.entries.length;
  }

  /** The edits in order, or undefined when the log overflowed or was invalidated. */
  get edits(): readonly Edit[] | undefined {
    return this.broken ? undefined : this.entries;
  }
}
