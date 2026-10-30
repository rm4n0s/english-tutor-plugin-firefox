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
import { IssueState } from "./state";
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

  describe("a result after the text changed", () => {
    it("is ignored when a text was loaded meanwhile", async () => {
      const { state, runner, controller, usages } = setupController();
      const running = controller.check({ manual: true });
      state.reset(); // a text was loaded: not an edit
      runner.finish(0, resultOf(fiveIssues()));
      expect(await running).toEqual({ kind: "stale" });
      expect(state.issues).toEqual([]);
      expect(state.checked).toBe(false);
      expect(state.pending).toBeNull();
      expect(state.outcome).toBe("none");
      expect(usages).toHaveLength(1);
    });

    it.each([
      {
        name: "an edit before every issue shifts them all",
        edits: [
          { start: 0, removed: 0, added: 0 },
          { start: 0, removed: 0, added: 3 },
        ],
        // The first (empty) edit is a no-op in the log; "aaaa" is touched by the insertion at 0.
        expected: ["bbbb", "cccc", "dddd", "eeee"],
        starts: [8, 13, 18, 23],
      },
      {
        name: "an edit inside one issue drops it and moves the later ones",
        edits: [{ start: 11, removed: 1, added: 4 }],
        expected: ["aaaa", "bbbb", "dddd", "eeee"],
        starts: [0, 5, 18, 23],
      },
      {
        name: "an edit after every issue changes nothing",
        edits: [{ start: 40, removed: 0, added: 4 }],
        expected: ["aaaa", "bbbb", "cccc", "dddd", "eeee"],
        starts: [0, 5, 10, 15, 20],
      },
      {
        name: "several edits are applied in order",
        edits: [
          { start: 6, removed: 1, added: 2 }, // inside "bbbb"; "cccc" is now at 11..15
          { start: 12, removed: 0, added: 1 }, // inside "cccc"
        ],
        expected: ["aaaa", "dddd", "eeee"],
        starts: [0, 17, 22],
      },
    ])("is rebased across the edits: $name", async ({ edits, expected, starts }) => {
      const { state, runner, controller } = setupController();
      const running = controller.check({ manual: true });
      for (const edit of edits) state.applyEdit(edit);
      runner.finish(0, resultOf(fiveIssues(), { unplaced: 2 }));
      const outcome = await running;
      expect(outcome.kind).toBe("finished");
      expect(state.issues.map((i) => i.snippet)).toEqual(expected);
      expect(state.issues.map((i) => i.start)).toEqual(starts);
      expect(state.unplaced).toBe(2);
      expect(state.outcome).toBe("finished");
      expect(state.pending).toBeNull();
    });

    it("is discarded when the edit log overflowed, and the old issues stay", async () => {
      const { clock } = newState();
      const state = new IssueState(clock, { editLogLimit: 2 });
      const runner = new ManualRunner();
      const controller = new CheckController({
        state,
        runner,
        getModel: () => MODEL,
        getText: () => FIVE_TEXT,
      });
      state.beginCheck(true);
      state.finishCheck([placed(0, 4)], FIVE_TEXT, 0);
      const running = controller.check({ manual: true });
      for (let i = 0; i < 3; i++) state.applyEdit({ start: 40, removed: 0, added: 1 });
      runner.finish(0, resultOf(fiveIssues()));
      expect(await running).toEqual({ kind: "stale" });
      expect(state.issues.map((i) => i.snippet)).toEqual(["aaaa"]);
      expect(state.pending).toBeNull();
      expect(state.outcome).toBe("finished");
    });

    it("applies the result when the log holds exactly the limit", async () => {
      const { clock } = newState();
      const state = new IssueState(clock, { editLogLimit: 2 });
      const runner = new ManualRunner();
      const controller = new CheckController({
        state,
        runner,
        getModel: () => MODEL,
        getText: () => FIVE_TEXT,
      });
      const running = controller.check({ manual: true });
      for (let i = 0; i < 2; i++) state.applyEdit({ start: 40, removed: 0, added: 1 });
      runner.finish(0, resultOf(fiveIssues()));
      expect((await running).kind).toBe("finished");
      expect(state.issues).toHaveLength(5);
    });

    it.each([
      {
        name: "an edit inside the selection",
        edits: [{ start: 12, removed: 0, added: 1 }],
        stale: true,
      },
      {
        name: "an edit adjacent to the selection",
        edits: [{ start: 15, removed: 0, added: 1 }],
        stale: true,
      },
      {
        name: "an edit before the selection",
        edits: [{ start: 0, removed: 1, added: 3 }],
        stale: false,
      },
      {
        name: "an edit after the selection",
        edits: [{ start: 30, removed: 0, added: 3 }],
        stale: false,
      },
      {
        name: "an edit that touches the selection after an earlier one moved it",
        edits: [
          { start: 0, removed: 0, added: 5 }, // the selection is now at 15..20
          { start: 20, removed: 0, added: 1 },
        ],
        stale: true,
      },
    ])("a selection check is discarded only for $name: $stale", async ({ edits, stale }) => {
      const { state, runner, controller } = setupController();
      const running = controller.check({ manual: true, selection: { start: 10, end: 15 } });
      for (const edit of edits) state.applyEdit(edit);
      runner.finish(0, resultOf([placed(10, 14)]));
      expect((await running).kind).toBe(stale ? "stale" : "finished");
      expect(state.pending).toBeNull();
      expect(state.issues.length).toBe(stale ? 0 : 1);
    });

    it("tells a selection check that an edit touched the range from other stale results", async () => {
      const { state, runner, controller } = setupController();
      const touched = controller.check({ manual: true, selection: { start: 10, end: 15 } });
      state.applyEdit({ start: 12, removed: 0, added: 1 });
      runner.finish(0, resultOf([placed(10, 14)]));
      expect(await touched).toEqual({ kind: "stale", reason: "selection-edited" });

      // Too many edits to rebase across: stale, but not because of the selection.
      const { clock } = newState();
      const small = new IssueState(clock, { editLogLimit: 1 });
      const other = new ManualRunner();
      const c2 = new CheckController({
        state: small,
        runner: other,
        getModel: () => MODEL,
        getText: () => FIVE_TEXT,
      });
      const overflowed = c2.check({ manual: true, selection: { start: 10, end: 15 } });
      small.applyEdit({ start: 40, removed: 0, added: 1 });
      small.applyEdit({ start: 40, removed: 0, added: 1 });
      other.finish(0, resultOf([placed(10, 14)]));
      expect(await overflowed).toEqual({ kind: "stale" });
    });

    it("an auto-check result carries the flag on its issues", async () => {
      const { state, runner, controller } = setupController();
      const running = controller.check({ manual: false });
      runner.finish(0, resultOf(fiveIssues()));
      await running;
      expect(state.issues.every((i) => !i.manual)).toBe(true);
    });
  });
});

describe("CheckController: checking a selection", () => {
  it("sends only the selection and gives the runner its place in the whole text", async () => {
    const calls: { text: string; options: CheckOptions | undefined }[] = [];
    const { state } = newState();
    const controller = new CheckController({
      state,
      runner: {
        check: (_model, text, options) => {
          calls.push({ text, options });
          return Promise.resolve(resultOf([placed(10, 14)]));
        },
      },
      getModel: () => MODEL,
      getText: () => FIVE_TEXT,
    });
    const outcome = await controller.check({ manual: true, selection: { start: 10, end: 19 } });
    expect(calls.map((c) => c.text)).toEqual(["cccc dddd"]);
    expect(calls[0]?.options?.selection).toEqual({ offset: 10, fullText: FIVE_TEXT });
    expect(outcome.kind).toBe("finished");
  });

  it.each([
    { name: "only white space", text: "ab \n\t cd", start: 2, end: 6 },
    { name: "an empty range", text: "abcd", start: 2, end: 2 },
    { name: "a range past the end", text: "abcd", start: 2, end: 9 },
    { name: "a negative start", text: "abcd", start: -1, end: 2 },
  ])("fails with SelectionEmpty for $name, and sends nothing", async ({ text, start, end }) => {
    const { state } = newState();
    let calls = 0;
    const controller = new CheckController({
      state,
      runner: {
        check: () => {
          calls++;
          return Promise.resolve(resultOf([]));
        },
      },
      getModel: () => MODEL,
      getText: () => text,
    });
    const outcome = await controller.check({ manual: true, selection: { start, end } });
    expect(outcome.kind).toBe("failed");
    const error = (outcome as Extract<CheckOutcome, { kind: "failed" }>).error;
    expect(error.hasRoute("CheckController.check->SelectionEmpty")).toBe(true);
    expect(calls).toBe(0);
    expect(state.pending).toBeNull();
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

describe("a selection check over the analyzer", () => {
  const TEXT = "He go home. She dont know. We was late.";

  function twoChecks(selectionReply: string) {
    const { state } = newState();
    const full = setup(reply(issuesJson("He go", "She dont", "We was")));
    const analyzer = new Analyzer({ random: new CountingRandom() });
    let model = full.model;
    const controller = new CheckController({
      state,
      runner: analyzer,
      getModel: () => model,
      getText: () => TEXT,
    });
    const part = setup(reply(selectionReply));
    return {
      state,
      controller,
      useSelectionModel: () => {
        model = part.model;
      },
      part,
    };
  }

  it("merges: the issue inside is replaced, the others stay, and fingerprints equal a full check's", async () => {
    const t = twoChecks(
      JSON.stringify({ issues: [{ text: "dont know", error_type: "verb_form", message: "n" }] }),
    );
    await t.controller.check({ manual: true });
    const full = [...t.state.issues];
    expect(full.map((i) => i.snippet)).toEqual(["He go", "She dont", "We was"]);

    t.useSelectionModel();
    const start = TEXT.indexOf("She dont");
    const outcome = await t.controller.check({
      manual: true,
      selection: { start, end: start + "She dont know.".length },
    });
    expect(outcome.kind).toBe("finished");
    expect(t.state.issues.map((i) => i.snippet)).toEqual(["He go", "dont know", "We was"]);
    // Outside the selection: the same issues, ids included.
    expect(t.state.issues[0]).toBe(full[0]);
    expect(t.state.issues[2]).toBe(full[2]);
    // Only the selection was sent.
    const sent = JSON.stringify(t.part.fake.requests[0]?.body);
    expect(sent).toContain("She dont know.");
    expect(sent).not.toContain("We was late");
    // The fingerprint is that of the same words checked in the whole text.
    const direct = setup(
      reply(
        JSON.stringify({ issues: [{ text: "dont know", error_type: "verb_form", message: "n" }] }),
      ),
    );
    const whole = await new Analyzer({ random: new CountingRandom() }).check(direct.model, TEXT);
    expect(t.state.issues[1]?.fingerprint).toBe(whole.placed[0]?.fingerprint);
    expect(t.state.issues[1]?.start).toBe(TEXT.indexOf("dont know"));
  });
});
