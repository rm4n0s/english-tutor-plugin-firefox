import type { IssueState } from "./state";

function issues(n: number): string {
  return `${String(n)} ${n === 1 ? "issue" : "issues"}`;
}

/**
 * The check state of the status bar (SPEC sections 4.2 and 5.1): `Ready`, `Checking...`,
 * `Check cancelled`, `Check failed`, `N issues` / `No errors found`, plus
 * ` · N issues could not be placed`.
 */
export function checkStatusText(state: IssueState): string {
  if (state.pending !== null) return "Checking...";
  switch (state.outcome) {
    case "cancelled":
      return "Check cancelled";
    case "failed":
      return "Check failed";
    case "none":
      return "Ready";
    case "finished": {
      const found = state.issues.length === 0 ? "No errors found" : issues(state.issues.length);
      return state.unplaced > 0
        ? `${found} · ${issues(state.unplaced)} could not be placed`
        : found;
    }
  }
}

/** `0 words`, `1 word`, `142 words`. */
export function wordCountText(words: number): string {
  return `${String(words)} ${words === 1 ? "word" : "words"}`;
}

/** The header of the issues list: `Issues (5)`, or `Issues (3 of 5 shown)` with hidden categories. */
export function issuesHeaderText(state: IssueState): string {
  const total = state.issues.length;
  const shown = state.visibleIssues.length;
  return shown === total
    ? `Issues (${String(total)})`
    : `Issues (${String(shown)} of ${String(total)} shown)`;
}

/** The empty line of the list, or undefined when there are rows (SPEC section 4.4). */
export function issuesEmptyText(state: IssueState): string | undefined {
  if (state.visibleIssues.length > 0) return undefined;
  if (state.pending !== null) return "Checking...";
  if (!state.checked) return "Press Check to find errors";
  return state.issues.length === 0 ? "No errors found" : "All categories are hidden";
}
