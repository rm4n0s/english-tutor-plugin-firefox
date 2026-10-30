import type { ExplanationRunner } from "../core/issues";
import type { BoxSession } from "./box-session";

/**
 * One explainer per text box (SPEC section 4.11), shared by the popover and the issues dialog, so
 * that an explanation asked for in one is cached for the other. The cache lives as long as the
 * check result does (SPEC section 4.5): a new result (a new `IssueState.checkId`) resets it.
 */
export class BoxExplainers {
  private readonly make: () => ExplanationRunner;
  private readonly records = new WeakMap<
    BoxSession,
    { explainer: ExplanationRunner; checkId: number }
  >();

  constructor(make: () => ExplanationRunner) {
    this.make = make;
  }

  /** The box's explainer, made on first use, its cache emptied when the check result changed. */
  of(session: BoxSession): ExplanationRunner {
    const checkId = session.state.checkId;
    let record = this.records.get(session);
    if (record === undefined) {
      record = { explainer: this.make(), checkId };
      this.records.set(session, record);
    } else if (record.checkId !== checkId) {
      // A new check result: the cached explanations are for issues that are gone.
      record.explainer.reset();
      record.checkId = checkId;
    }
    return record.explainer;
  }
}
