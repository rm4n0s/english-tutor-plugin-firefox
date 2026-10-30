export {
  Suggester,
  buildAlternativesPrompt,
  parseAlternatives,
  MAX_ALTERNATIVES,
  MAX_ALTERNATIVES_WORDS,
  MAX_ALTERNATIVE_CHARS,
  type AlternativesOptions,
  type AlternativesRequest,
  type AlternativesResult,
  type SuggesterDeps,
} from "./alternatives";
export {
  Analyzer,
  type AnalyzerDeps,
  type CheckedIssue,
  type CheckOptions,
  type CheckResult,
  type SelectionBase,
} from "./analyzer";
export { checkText, describeInvalid, isOutputLimit, CUT_OFF_MESSAGE } from "./check";
export {
  chunkSizeFor,
  splitChunks,
  DEFAULT_CHUNK_WORDS,
  MIN_PARALLEL_CHUNK_WORDS,
  type Chunk,
} from "./chunk";
export {
  buildExplainPrompt,
  explanationContext,
  Explainer,
  CONTEXT_WORDS,
  type ExplainerDeps,
  type ExplainOptions,
  type ExplainRequest,
  type ExplainResult,
} from "./explain";
export { fingerprint, normaliseSnippet } from "./fingerprint";
export {
  appendLocated,
  locate,
  EMPTY_LOCATE_RESULT,
  type LocateResult,
  type Placed,
} from "./locate";
export { modelFromConfig, type AnalysisModel, type ModelConfig } from "./model";
export {
  parseResponse,
  INVALID_REPLY_MESSAGE,
  MAX_CONTEXT_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_SNIPPET_CHARS,
  type Issue,
  type Parsed,
} from "./parse";
export { buildCheckPrompt, withRetryReminder, RETRY_REMINDER, type Prompt } from "./prompt";
export {
  categoryLabel,
  errorTypes,
  lookupErrorType,
  otherId,
  resolveErrorType,
  CATEGORIES,
  type Category,
  type ErrorType,
} from "./taxonomy";
export { recordUsage, type UsageKind, type UsageRecord, type UsageRecorder } from "./usage";
export { countWords } from "./text";
