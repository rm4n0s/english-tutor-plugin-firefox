export { AutoCheck, type AutoCheckDeps } from "./auto-check";
export {
  diffText,
  EDIT_LOG_LIMIT,
  EditLog,
  rebaseIssues,
  rebaseRange,
  rebaseRangeAcross,
  touches,
  type Edit,
  type Ranged,
} from "./edits";
export {
  CheckController,
  type CheckControllerDeps,
  type CheckOutcome,
  type CheckRunner,
} from "./check-controller";
export {
  ExplanationController,
  NO_LLM_EXPLANATION_MESSAGE,
  type ExplanationAction,
  type ExplanationControllerDeps,
  type ExplanationRunner,
  type ExplanationTarget,
  type ExplanationView,
} from "./explanation-controller";
export {
  IssueState,
  type CheckEnd,
  type IssueChange,
  type IssueListener,
  type PendingCheck,
  type TextIssue,
} from "./state";
export { checkStatusText, issuesEmptyText, issuesHeaderText, wordCountText } from "./status";
export { formatCount, formatTotals, TokenTally, tokenStatusText, type TokenTotals } from "./tally";
export { adjacentIssueId, issueAt, type Direction, type Navigable } from "./navigation";
export { TrackedText } from "./tracked-text";
export {
  headerLineText,
  IssueCounts,
  NOT_COUNTED_TEXT,
  SelectedIssueHeader,
  type CountSource,
  type HeaderLineView,
} from "./counts";
