import type { Category } from "../core/analysis/taxonomy";
import { CATEGORIES, categoryLabel } from "../core/analysis/taxonomy";
import type { BoxView } from "./box-state";

/** What the badge shows (SPEC section 4.11). */
export type BadgeView =
  | { kind: "icon"; label: string }
  | { kind: "dimmed"; label: string }
  | { kind: "spinner"; label: string }
  | { kind: "count"; label: string; count: number; category: Category }
  | { kind: "check"; label: string }
  | { kind: "warning"; label: string };

/** The dimmed badge of a site that is not on (SPEC section 4.11): its tooltip and accessible name. */
export function dimmedView(host: string): BadgeView {
  return { kind: "dimmed", label: `English Tutor is off on ${host}. Click to turn it on.` };
}

function issuesText(n: number): string {
  return `${String(n)} ${n === 1 ? "issue" : "issues"}`;
}

/** The category with the most issues; a tie goes to the first in legend order. */
export function dominantCategory(issues: readonly { category: Category }[]): Category | undefined {
  let best: Category | undefined;
  let bestCount = 0;
  for (const category of CATEGORIES) {
    const count = issues.filter((issue) => issue.category === category).length;
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The state of the badge of a text box: the extension icon before the first check, a spinner while
 * checking, the number of issues in the colour of the category with the most (the count is text,
 * so the colour is not the only signal), a check mark when there are none, and `!` after a failure
 * (or when there is no LLM, the text is too long, or the frame is blocked). `label` is its tooltip
 * and accessible name. `blocked` is the message of `PageFrameBlocked`.
 */
export function badgeViewOf(box: BoxView, blocked?: string): BadgeView {
  if (blocked !== undefined) return { kind: "warning", label: blocked };
  switch (box.status) {
    case "checking":
      return { kind: "spinner", label: "English Tutor is checking this text" };
    case "failed":
    case "no-llm":
    case "too-long":
      return { kind: "warning", label: box.message ?? "English Tutor could not check this text" };
    case "idle":
    case "checked":
      break;
  }
  const category = dominantCategory(box.issues);
  if (category !== undefined) {
    const parts = CATEGORIES.map((c) => ({
      c,
      n: box.issues.filter((issue) => issue.category === c).length,
    }))
      .filter(({ n }) => n > 0)
      .map(({ c, n }) => `${String(n)} ${categoryLabel(c).toLowerCase()}`);
    return {
      kind: "count",
      count: box.issues.length,
      category,
      label: `${issuesText(box.issues.length)} (${parts.join(", ")})`,
    };
  }
  if (box.status === "checked") return { kind: "check", label: "No errors found" };
  // With automatic checks off the frame says how to check (the tooltip of an unchecked box).
  return {
    kind: "icon",
    label: box.message ?? "English Tutor",
  };
}
