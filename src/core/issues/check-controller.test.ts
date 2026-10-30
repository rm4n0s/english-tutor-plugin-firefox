import { describe, expect, it } from "vitest";
import { Analyzer, type AnalysisModel, type CheckOptions, type CheckResult } from "../analysis";
import {
  CountingRandom,
  issuesJson,
  reply,
  setup,
  slowReply,
  until,
} from "../analysis/testing/helpers";
import { AppError } from "../errors";
import type { Usage } from "../llm";
import { CheckController, type CheckOutcome, type CheckRunner } from "./check-controller";
import { deferred, fiveIssues, FIVE_TEXT, newState, placed, resultOf } from "./testing/helpers";

const MODEL = { client: {}, name: "Local" } as unknown as AnalysisModel;

/** A runner whose checks end when the test says so. */
class ManualRunner implements CheckRunner {
  readonly calls: { text: string; signal: AbortSignal | undefined }[] = [];
  private readonly waiting: ReturnType<typeof deferred<CheckResult>>[] = [];

  check(_model: AnalysisModel, text: string, options: CheckOptions = {}): Promise<CheckResult> {
    const d = deferred<CheckResult>();
    this.calls.push({ text, signal: options.signal });
    this.waiting.push(d);
    // Like the analyzer, a cancel is a result and not an error.
    options.signal?.addEventListener("abort", () => {
      d.resolve(resultOf([], { cancelled: true }));
    });
    return d.promise;
  }

  finish(index: number, result: CheckResult): void {
    this.waiting[index]?.resolve(result);
  }

  fail(index: number, reason: unknown): void {
    this.waiting[index]?.reject(reason);
  }
}

function setupController(text = FIVE_TEXT, withModel = true) {
  const { state, clock } = newState();
  const runner = new ManualRunner();
  const usages: Usage[] = [];
  const box: { text: string; model: AnalysisModel | undefined } = {
    text,
    model: withModel ? MODEL : undefined,
  };
  const controller = new CheckController({
    state,
    runner,
    getModel: () => box.model,
    getText: () => box.text,
    onUsage: (u) => usages.push(u),
  });
  return { state, clock, runner, controller, usages, box };
}

describe("CheckController", () => {
  describe("a manual check", () => {
    it("takes the snapshot, shows the pending check, and puts the result in the state", async () => {
      const { state, runner, controller, usages } = setupController();
      const running = controller.check({ manual: true });
      expect(state.pending).toMatchObject({ manual: true, revision: 0 });
      expect(controller.running).toBe(true);
      expect(runner.calls.map((c) => c.text)).toEqual([FIVE_TEXT]);

      runner.finish(0, resultOf(fiveIssues(), { unplaced: 1 }));
      const outcome = await running;

      expect(outcome).toMatchObject({ kind: "finished", manual: true, text: FIVE_TEXT });
      expect(state.pending).toBeNull();
      expect(controller.running).toBe(false);
      expect(state.issues.map((i) => i.snippet)).toEqual(["aaaa", "bbbb", "cccc", "dddd", "eeee"]);
      expect(state.unplaced).toBe(1);
      expect(state.outcome).toBe("finished");
      expect(usages).toEqual([{ inputTokens: 100, outputTokens: 20, estimated: false }]);
    });

    it("checks the text as it was when the check started, even if the editor changes later", async () => {
      const { runner, controller, box, state } = setupController("one two");
      const running = controller.check({ manual: true });
      box.text = "something else entirely";
      runner.finish(0, resultOf([placed(0, 3)]));
      await running;
      expect(state.issues[0]?.snippet).toBe("one");
    });
  });

  describe("cancelling", () => {
    it("is not an error, leaves the old issues, and keeps what the check reported", async () => {
      const { state, runner, controller, usages } = setupController();
      const first = controller.check({ manual: true });
      runner.finish(0, resultOf(fiveIssues()));
      await first;

      const second = controller.check({ manual: true });
      controller.cancel();
      const outcome = await second;

      expect(outcome).toEqual({ kind: "cancelled" });
      expect(state.issues).toHaveLength(5);
      expect(state.outcome).toBe("cancelled");
      expect(state.pending).toBeNull();
      expect(usages).toHaveLength(2);
    });

    it("cancel with nothing running does nothing", () => {
      const { state, controller } = setupController();
      controller.cancel();
      expect(state.outcome).toBe("none");
    });

    it("a result that arrives after the cancel is not applied", async () => {
      const { state, runner, controller } = setupController();
      const running = controller.check({ manual: true });
      controller.cancel();
      runner.finish(0, resultOf(fiveIssues()));
      expect(await running).toEqual({ kind: "cancelled" });
      expect(state.issues).toEqual([]);
    });

    it("a request that rejects after the cancel is a cancel, not a failure", async () => {
      const { state, runner, controller } = setupController();
      const running = controller.check({ manual: true });
      controller.cancel();
      runner.fail(0, new DOMException("aborted", "AbortError"));
      expect(await running).toEqual({ kind: "cancelled" });
      expect(state.outcome).toBe("cancelled");
    });
  });

  describe("a failed check", () => {
    it("keeps the old issues, reports the error with its route, and sets the outcome", async () => {
      const { state, runner, controller } = setupController();
      const first = controller.check({ manual: true });
      runner.finish(0, resultOf(fiveIssues()));
      await first;

      const second = controller.check({ manual: true });
      runner.fail(1, new AppError("LLMCallFailed", "The server returned HTTP 500."));
      const outcome = await second;

      expect(outcome.kind).toBe("failed");
      const error = (outcome as Extract<CheckOutcome, { kind: "failed" }>).error;
      expect(error.hasRoute("CheckController.check->LLMCallFailed")).toBe(true);
      expect(error.message).toBe("The server returned HTTP 500.");
      expect(state.issues).toHaveLength(5);
      expect(state.outcome).toBe("failed");
      expect(state.pending).toBeNull();
    });

    it("wraps an error that is not an AppError, keeping the cause", async () => {
      const { runner, controller } = setupController();
      const running = controller.check({ manual: true });
      const cause = new TypeError("boom");
      runner.fail(0, cause);
      const outcome = await running;
      const error = (outcome as Extract<CheckOutcome, { kind: "failed" }>).error;
      expect(error.tag).toBe("LLMCallFailed");
      expect(error.cause).toBe(cause);
    });

    it("a model that cannot be made is a failed check, and nothing is pending", async () => {
      const { state, controller, runner } = setupController();
      const failing = new CheckController({
        state,
        runner,
        getModel: () => {
          throw new AppError("LLMConfigInvalid", "Base URL must be an address.");
        },
        getText: () => "x",
      });
      const outcome = await failing.check({ manual: true });
      expect(outcome.kind).toBe("failed");
      expect(state.outcome).toBe("failed");
      expect(state.pending).toBeNull();
      expect(controller.running).toBe(false);
    });
  });

  describe("no LLM", () => {
    it("does not start a check", async () => {
      const { state, controller, runner } = setupController(FIVE_TEXT, false);
      expect(await controller.check({ manual: true })).toEqual({ kind: "no-llm" });
      expect(state.pending).toBeNull();
      expect(runner.calls).toEqual([]);
    });
  });

  describe("one check at a time", () => {
    it("an auto-check does not interrupt a running check", async () => {
      const { state, runner, controller } = setupController();
      const running = controller.check({ manual: true });
      expect(await controller.check({ manual: false })).toEqual({ kind: "busy" });
      expect(runner.calls).toHaveLength(1);
      runner.finish(0, resultOf(fiveIssues()));
      expect((await running).kind).toBe("finished");
      expect(state.issues).toHaveLength(5);
    });

    it("a manual check replaces the running one, whose result is ignored", async () => {
      const { state, runner, controller } = setupController();
      const older = controller.check({ manual: false });
      const newer = controller.check({ manual: true });
      expect(runner.calls[0]?.signal?.aborted).toBe(true);
      expect(state.pending?.manual).toBe(true);

      runner.finish(0, resultOf([placed(0, 4)]));
      expect(await older).toEqual({ kind: "stale" });
      // The older check did not clear the pending flag of the newer one.
      expect(state.pending?.manual).toBe(true);
      expect(state.issues).toEqual([]);

      runner.finish(1, resultOf(fiveIssues()));
      expect((await newer).kind).toBe("finished");
      expect(state.issues).toHaveLength(5);
    });

    it("an older check that fails after it was replaced shows no error", async () => {
      const { runner, controller } = setupController();
      const older = controller.check({ manual: true });
      const newer = controller.check({ manual: true });
      runner.fail(0, new AppError("LLMCallFailed", "late"));
      expect(await older).toEqual({ kind: "stale" });
      runner.finish(1, resultOf([]));
      expect((await newer).kind).toBe("finished");
    });

    it("a check can start again after the last one ended", async () => {
      const { runner, controller } = setupController();
      const one = controller.check({ manual: false });
      runner.finish(0, resultOf([]));
      await one;
      const two = controller.check({ manual: false });
      runner.finish(1, resultOf([]));
      expect((await two).kind).toBe("finished");
    });
  });

  describe("a stale result", () => {
    it("is ignored when the text changed while checking, and the issues of the edit stay gone", async () => {
      const { state, runner, controller, usages } = setupController();
      const running = controller.check({ manual: true });
      state.reset(); // the text was edited or replaced
      runner.finish(0, resultOf(fiveIssues()));
      expect(await running).toEqual({ kind: "stale" });
      expect(state.issues).toEqual([]);
      expect(state.checked).toBe(false);
      expect(state.pending).toBeNull();
      expect(state.outcome).toBe("none");
      expect(usages).toHaveLength(1);
    });
  });
});

describe("CheckController over the analyzer", () => {
  const ONE = issuesJson("He go");

  function over(script: Parameters<typeof setup>[0], text = "He go home.") {
    const { state } = newState();
    const { model } = setup(script);
    const analyzer = new Analyzer({ random: new CountingRandom() });
    const controller = new CheckController({
      state,
      runner: analyzer,
      getModel: () => model,
      getText: () => text,
    });
    return { state, controller };
  }

  it("places the issues of a reply and keeps the fingerprints", async () => {
    const { state, controller } = over(reply(ONE, { usage: { input: 50, output: 10 } }));
    const outcome = await controller.check({ manual: true });
    expect(outcome.kind).toBe("finished");
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({ snippet: "He go", start: 0, end: 5 });
    expect(state.issues[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cancelling a request in flight resolves as cancelled, without an error", async () => {
    const { state, controller } = over(slowReply(ONE, 5_000));
    const running = controller.check({ manual: true });
    await until(() => state.pending !== null);
    controller.cancel();
    expect(await running).toEqual({ kind: "cancelled" });
    expect(state.outcome).toBe("cancelled");
  });

  it("a server error is a failed check with the analyzer's route", async () => {
    const { state, controller } = over({ kind: "json", status: 500, body: { error: "down" } });
    const outcome = await controller.check({ manual: true });
    expect(outcome.kind).toBe("failed");
    const error = (outcome as Extract<CheckOutcome, { kind: "failed" }>).error;
    expect(
      error.hasRoute("CheckController.check->Analyzer.check->OpenAIClient.generate->LLMCallFailed"),
    ).toBe(true);
    expect(state.outcome).toBe("failed");
  });
});
