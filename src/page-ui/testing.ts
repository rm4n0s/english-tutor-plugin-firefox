import type { AnalysisModel, CheckOptions, CheckResult } from "../core/analysis";
import { AppError } from "../core/errors";
import type { CheckRunner } from "../core/issues";
import { deferred } from "../core/issues/testing/helpers";
import type { FrameMessage } from "../core/page-mode/protocol";
import { FakeClock, FakeScheduler } from "../core/testing/fake-clock";
import { Logger } from "../core/log";
import type { BoxSessionDeps } from "./box-session";

/** A model the fake runner never looks at. */
export const MODEL = { name: "Fake LLM" } as unknown as AnalysisModel;

/** A check runner that answers from a queue of replies, and records what it was asked. */
export class FakeRunner implements CheckRunner {
  readonly asked: { text: string; options: CheckOptions | undefined }[] = [];
  private readonly replies: (() => Promise<CheckResult>)[] = [];

  /** The next check resolves with `result`. */
  answer(result: CheckResult): this {
    this.replies.push(() => Promise.resolve(result));
    return this;
  }

  /** The next check fails with `error`. */
  fail(error: unknown): this {
    this.replies.push(() =>
      Promise.reject(error instanceof Error ? error : new Error(String(error))),
    );
    return this;
  }

  /** The next check waits until the returned function is called with its result. */
  hold(): (result: CheckResult) => void {
    const held = deferred<CheckResult>();
    this.replies.push(() => held.promise);
    return (result) => {
      held.resolve(result);
    };
  }

  check(_model: AnalysisModel, text: string, options?: CheckOptions): Promise<CheckResult> {
    this.asked.push({ text, options });
    const next = this.replies.shift();
    if (next === undefined) return Promise.reject(new AppError("LLMCallFailed", "no reply queued"));
    return next();
  }
}

/** Everything a `BoxSession` needs, with the messages it sends collected. */
export function sessionDeps(overrides: Partial<BoxSessionDeps> = {}) {
  const sent: FrameMessage[] = [];
  const clock = new FakeClock(1_000);
  const scheduler = new FakeScheduler();
  const runner = new FakeRunner();
  const settings = {
    delaySeconds: 3,
    model: MODEL as AnalysisModel | undefined,
    getModel() {
      return this.model;
    },
  };
  const logged: string[] = [];
  const record = (message: string) => {
    logged.push(message);
  };
  const deps: BoxSessionDeps = {
    clock,
    scheduler,
    runner,
    settings,
    log: new Logger({ debug: record, info: record, warn: record, error: record }),
    send: (message) => {
      sent.push(message);
    },
    ...overrides,
  };
  return { deps, sent, clock, scheduler, runner, settings, logged };
}

/** Lets the promises of a check settle. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The states a session sent for a box, in order. */
export function states(sent: readonly FrameMessage[]) {
  return sent.flatMap((m) => (m.type === "state" ? [m] : []));
}
