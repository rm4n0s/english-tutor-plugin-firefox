import type { Ranged } from "./edits";

/** An issue has an id and a range; the list the functions get is in text order. */
export interface Navigable extends Ranged {
  readonly id: number;
}

/**
 * The issue under the caret: the one whose range holds the offset, where the end is exclusive, so
 * a caret right after a word is outside it and a caret at the start of an issue is inside
 * (SPEC section 4.3). `issues` are the shown ones; a hidden category never matches.
 */
export function issueAt<T extends Navigable>(issues: readonly T[], offset: number): T | undefined {
  return issues.find((issue) => issue.start <= offset && offset < issue.end);
}

export type Direction = "next" | "previous";

/**
 * The id of the issue `F7` (next) or `Shift+F7` (previous) goes to (SPEC section 4.3), among the
 * shown `issues` in text order, or undefined when there are none. From the selected issue it goes
 * to its neighbour; with none selected, from the caret: next is the first issue that starts after
 * the caret, previous the last one that starts before it. Both wrap around at the ends.
 */
export function adjacentIssueId(
  issues: readonly Navigable[],
  selectedId: number | null,
  caret: number,
  direction: Direction,
): number | undefined {
  const count = issues.length;
  if (count === 0) return undefined;
  const at = selectedId === null ? -1 : issues.findIndex((issue) => issue.id === selectedId);
  if (at >= 0) {
    return issues[(at + (direction === "next" ? 1 : count - 1)) % count]?.id;
  }
  if (direction === "next") {
    return (issues.find((issue) => issue.start > caret) ?? issues[0])?.id;
  }
  const before = issues.filter((issue) => issue.start < caret);
  return (before[before.length - 1] ?? issues[count - 1])?.id;
}
