import type { UsageRecord, UsageRecorder } from "../analysis/usage";
import type { Store } from "./store";

/**
 * The `UsageRecorder` of the analysis code over the store (SPEC section 5.8): every request's
 * tokens go to `llm_usage`. A failure is `UsageSaveFailed`; the analysis code logs it and the
 * request's result is still shown.
 */
export class StoreUsageRecorder implements UsageRecorder {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  record(record: UsageRecord): Promise<void> {
    return this.store.recordUsage({
      llm_name: record.llm,
      kind: record.kind,
      input_tokens: record.usage.inputTokens,
      output_tokens: record.usage.outputTokens,
      estimated: record.usage.estimated,
    });
  }
}
