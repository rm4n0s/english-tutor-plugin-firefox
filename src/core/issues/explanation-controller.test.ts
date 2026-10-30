import { describe, expect, it } from "vitest";
import {
  Explainer,
  type AnalysisModel,
  type ExplainOptions,
  type ExplainRequest,
  type ExplainResult,
} from "../analysis";
import {
  CountingRandom,
  RecordingUsage,
  setup,
  streamReply,
  until,
} from "../analysis/testing/helpers";
import { AppError } from "../errors";
import { NO_USAGE } from "../analysis/usage";
import { Logger } from "../log";
import {
  ExplanationController,
  NO_LLM_EXPLANATION_MESSAGE,
  type ExplanationAction,
  type ExplanationRunner,
  type ExplanationTarget,
  type ExplanationView,
} from "./explanation-controller";
import { deferred, fiveIssues, FIVE_TEXT, newState, placed } from "./testing/helpers";

/** An edit: `removed` units at `start` replaced by `added` new ones. */
const edit = (start: number, removed: number, added: number) => ({ start, removed, added });

const MODEL = { client: {}, name: "Local" } as unknown as AnalysisModel;

/** Records what the controller tells the panel, as short strings. */
class RecordingView implements ExplanationView {
  readonly events: string[] = [];
  readonly targets: ExplanationTarget[] = [];
  handler: ((action: ExplanationAction) => void) | undefined;

  showIdle(): void {
    this.events.push("idle");
  }
  showLoading(target: ExplanationTarget): void {
    this.targets.push(target);
    this.events.push(`loading:${target.label}`);
  }
  appendText(chunk: string): void {
    this.events.push(`text:${chunk}`);
  }
  showReady(markdown: string): void {
    this.events.push(`ready:${markdown}`);
  }
  showFailed(message: string): void {
    this.events.push(`failed:${message}`);
  }
  showCancelled(): void {
    this.events.push("cancelled");
  }
  setActionHandler(handler: ((action: ExplanationAction) => void) | undefined): void {
    this.handler = handler;
  }
  press(action: ExplanationAction): void {
    this.handler?.(action);
  }
}

interface Call {
  request: ExplainRequest;
  options: ExplainOptions;
  done: ReturnType<typeof deferred<ExplainResult>>;
}

/** An explainer whose requests end when the test says so. */
class ManualRunner implements ExplanationRunner {
  readonly calls: Call[] = [];
  cancels = 0;
  resets = 0;

  explain(
    _model: AnalysisModel,
    request: ExplainRequest,
    options: ExplainOptions = {},
  ): Promise<ExplainResult> {
    const done = deferred<ExplainResult>();
    this.calls.push({ request, options, done });
    return done.promise;
  }
  cancel(): void {
    this.cancels++;
  }
  reset(): void {
    this.resets++;
  }
}

const READY = (markdown: string): ExplainResult => ({
  markdown,
  usage: NO_USAGE,
  cached: false,
  cancelled: false,
});
const CANCELLED: ExplainResult = { markdown: "", usage: NO_USAGE, cached: false, cancelled: true };

/** Let the promise callbacks of the controller run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setupManual(withModel = true) {
  const { state } = newState();
  const view = new RecordingView();
  const runner = new ManualRunner();
  const box: { model: AnalysisModel | undefined; text: string } = {
    model: withModel ? MODEL : undefined,
    text: FIVE_TEXT,
  };
  const logged: unknown[] = [];
  const log = new Logger({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (_message: string, fields?: unknown) => {
      logged.push(fields);
    },
  });
  const controller = new ExplanationController({
    state,
    explainer: runner,
    view,
    getModel: () => box.model,
    getText: () => box.text,
    log,
  });
  /** A finished check with the five issues; their ids are 1 to 5. */
  const check = (): void => {
    state.beginCheck(true);
    state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
  };
  return { state, view, runner, box, controller, check, logged };
}

describe("ExplanationController: selecting", () => {
  it("starts the explanation of the selected issue, keyed by check id and issue id", () => {
    const { state, view, runner, check } = setupManual();
    check();
    state.select(2);
    expect(view.events).toEqual(["loading:Article"]);
    expect(view.targets[0]).toEqual({
      label: "Article",
      categoryLabel: "Grammar",
      snippet: "bbbb",
    });
    const request = runner.calls[0]?.request;
    expect(request).toMatchObject({
      key: `${String(state.checkId)}:2`,
      regenerate: false,
      text: FIVE_TEXT,
      start: 5,
      end: 9,
    });
    expect(state.checkId).toBeGreaterThan(0);
  });

  it("passes the text of the editor now, with the offsets the issue has now", () => {
    const { state, runner, box, check } = setupManual();
    check();
    state.applyEdit(edit(0, 0, 3)); // "xyz" typed at the start
    box.text = `xyz${FIVE_TEXT}`;
    state.select(2);
    expect(runner.calls[0]?.request).toMatchObject({ text: `xyz${FIVE_TEXT}`, start: 8, end: 12 });
  });

  it("shows the streamed text and then the final text", async () => {
    const { state, view, runner, check } = setupManual();
    check();
    state.select(1);
    runner.calls[0]?.options.onText?.("Use ");
    runner.calls[0]?.options.onText?.("*goes*.");
    runner.calls[0]?.done.resolve(READY("Use *goes*."));
    await tick();
    expect(view.events).toEqual([
      "loading:Verb form",
      "text:Use ",
      "text:*goes*.",
      "ready:Use *goes*.",
    ]);
  });

  it("selecting another issue replaces the request, and the first one's result is ignored", async () => {
    const { state, view, runner, check } = setupManual();
    check();
    state.select(1);
    state.select(3);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.options.signal?.aborted).toBe(true);
    runner.calls[0]?.options.onText?.("late");
    runner.calls[0]?.done.resolve(READY("late"));
    runner.calls[1]?.done.resolve(READY("second"));
    await tick();
    expect(view.events).toEqual(["loading:Verb form", "loading:Collocation", "ready:second"]);
  });

  it.each([
    {
      name: "the user deselects",
      act: (c: ReturnType<typeof setupManual>) => {
        c.state.select(null);
      },
    },
    {
      name: "the selected issue's category is hidden",
      act: (c: ReturnType<typeof setupManual>) => {
        c.state.setHidden("grammar", true);
      },
    },
    {
      name: "an edit removes the selected issue",
      act: (c: ReturnType<typeof setupManual>) => {
        c.state.applyEdit(edit(0, 4, 4));
      },
    },
    {
      name: "a new check result arrives",
      act: (c: ReturnType<typeof setupManual>) => {
        c.state.beginCheck(false);
        c.state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      },
    },
    {
      name: "a text is loaded",
      act: (c: ReturnType<typeof setupManual>) => {
        c.state.reset();
      },
    },
  ])("cancels the running request and goes idle when $name", async (scenario) => {
    const c = setupManual();
    c.check();
    c.state.select(1);
    const call = c.runner.calls[0];
    scenario.act(c);
    expect(c.view.events.at(-1)).toBe("idle");
    expect(call?.options.signal?.aborted).toBe(true);
    expect(c.controller.busy).toBe(false);
    // A late result, or late text, changes nothing.
    call?.options.onText?.("late");
    call?.done.resolve(READY("late"));
    await tick();
    expect(c.view.events.filter((e) => e.startsWith("ready") || e.startsWith("text"))).toEqual([]);
  });

  it("an edit that only moves the selected issue keeps its explanation", async () => {
    const { state, view, runner, check } = setupManual();
    check();
    state.select(3);
    state.applyEdit(edit(0, 0, 2));
    runner.calls[0]?.done.resolve(READY("kept"));
    await tick();
    expect(view.events).toEqual(["loading:Collocation", "ready:kept"]);
    expect(runner.calls).toHaveLength(1);
  });

  it("a new check result empties the explainer's cache once, even while idle", () => {
    const { state, runner, check } = setupManual();
    check();
    expect(runner.resets).toBe(1);
    state.beginCheck(false);
    state.finishCheck([placed(0, 4)], FIVE_TEXT, 0);
    expect(runner.resets).toBe(2);
    state.applyEdit(edit(24, 0, 1)); // an edit is not a new result
    expect(runner.resets).toBe(2);
  });

  it("selecting an issue again asks again with the same key (the explainer answers from its cache)", () => {
    const { state, runner, check } = setupManual();
    check();
    state.select(2);
    state.select(null);
    state.select(2);
    expect(runner.calls.map((c) => c.request.key)).toEqual([
      `${String(state.checkId)}:2`,
      `${String(state.checkId)}:2`,
    ]);
    expect(runner.calls[1]?.request.regenerate).toBe(false);
  });
});

describe("ExplanationController: failures and buttons", () => {
  it("shows the failed state with no LLM, and Retry works once there is one", async () => {
    const { state, view, runner, box, check } = setupManual(false);
    check();
    state.select(1);
    expect(view.events).toEqual(["loading:Verb form", `failed:${NO_LLM_EXPLANATION_MESSAGE}`]);
    expect(runner.calls).toHaveLength(0);
    box.model = MODEL;
    view.press("retry");
    runner.calls[0]?.done.resolve(READY("now"));
    await tick();
    expect(view.events.slice(2)).toEqual(["loading:Verb form", "ready:now"]);
  });

  it.each([
    {
      name: "an AppError",
      error: new AppError("LLMCallFailed", "The server said no."),
      message: "The server said no.",
    },
    { name: "a foreign error", error: new TypeError("boom"), message: "boom" },
  ])(
    "shows $name from the request as the failed state, and Retry asks again",
    async ({ error, message }) => {
      const { state, view, runner, check, logged } = setupManual();
      check();
      state.select(1);
      runner.calls[0]?.done.reject(error);
      await tick();
      expect(view.events.at(-1)?.startsWith("failed:")).toBe(true);
      expect(view.events.at(-1)).toBe(`failed:${message}`);
      expect(logged).toHaveLength(1);
      view.press("retry");
      expect(runner.calls).toHaveLength(2);
      expect(runner.calls[1]?.request.regenerate).toBe(false);
    },
  );

  it("shows a failure of getModel as the failed state", () => {
    const { state, view, check, controller } = setupManual();
    check();
    controller.destroy();
    const view2 = new RecordingView();
    const runner = new ManualRunner();
    const c = new ExplanationController({
      state,
      explainer: runner,
      view: view2,
      getModel: () => {
        throw new AppError("LLMConfigInvalid", "The base URL is not valid.");
      },
      getText: () => FIVE_TEXT,
    });
    state.select(1);
    expect(view2.events).toEqual(["loading:Verb form", "failed:The base URL is not valid."]);
    c.destroy();
    expect(view.events).toEqual([]);
  });

  it("Cancel shows the cancelled state at once and a late result is ignored", async () => {
    const { state, view, runner, check, controller } = setupManual();
    check();
    state.select(1);
    expect(controller.busy).toBe(true);
    view.press("cancel");
    expect(view.events).toEqual(["loading:Verb form", "cancelled"]);
    expect(runner.calls[0]?.options.signal?.aborted).toBe(true);
    expect(controller.busy).toBe(false);
    runner.calls[0]?.done.resolve(READY("late"));
    await tick();
    expect(view.events).toEqual(["loading:Verb form", "cancelled"]);
    // Cancel with nothing running does nothing.
    view.press("cancel");
    expect(view.events).toHaveLength(2);
  });

  it("a result that says it was cancelled shows the cancelled state", async () => {
    const { state, view, runner, check } = setupManual();
    check();
    state.select(1);
    runner.calls[0]?.done.resolve(CANCELLED);
    await tick();
    expect(view.events.at(-1)).toBe("cancelled");
  });

  it.each([
    {
      from: "ready",
      finish: (c: Call) => {
        c.done.resolve(READY("text"));
      },
    },
    {
      from: "cancelled",
      finish: (c: Call) => {
        c.done.resolve(CANCELLED);
      },
    },
  ])("Regenerate from $from skips the cache", async ({ finish }) => {
    const { state, view, runner, check } = setupManual();
    check();
    state.select(4);
    finish(runner.calls[0]!);
    await tick();
    view.press("regenerate");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.request).toMatchObject({
      key: `${String(state.checkId)}:4`,
      regenerate: true,
    });
    expect(view.events.at(-1)).toBe("loading:Spelling");
  });

  it("Regenerate and Retry do nothing when no issue is selected", () => {
    const { view, runner } = setupManual();
    view.press("regenerate");
    view.press("retry");
    expect(runner.calls).toHaveLength(0);
  });

  it("stops listening and cancels after destroy", () => {
    const { state, view, runner, check, controller } = setupManual();
    check();
    state.select(1);
    controller.destroy();
    expect(runner.calls[0]?.options.signal?.aborted).toBe(true);
    expect(view.handler).toBeUndefined();
    const before = view.events.length;
    state.select(2);
    expect(view.events).toHaveLength(before);
  });
});

describe("ExplanationController: with the real explainer", () => {
  function realSetup(script: Parameters<typeof setup>[0]) {
    const { model, fake } = setup(script);
    const usage = new RecordingUsage();
    const explainer = new Explainer({ random: new CountingRandom(), usage });
    const { state } = newState();
    const view = new RecordingView();
    const controller = new ExplanationController({
      state,
      explainer,
      view,
      getModel: () => model,
      getText: () => FIVE_TEXT,
    });
    const check = (issues = fiveIssues()): void => {
      state.beginCheck(true);
      state.finishCheck(issues, FIVE_TEXT, 0);
    };
    return { state, view, fake, usage, controller, check, explainer };
  }

  it("streams, shows the final text, and answers the second selection from the cache", async () => {
    const { state, view, fake, usage, check } = realSetup(
      streamReply(["Use ", "*goes*."], { usage: { input: 80, output: 20 } }),
    );
    check();
    state.select(1);
    await until(() => view.events.some((e) => e.startsWith("ready:")));
    expect(view.events).toEqual([
      "loading:Verb form",
      "text:Use ",
      "text:*goes*.",
      "ready:Use *goes*.",
    ]);
    expect(usage.records.map((r) => r.kind)).toEqual(["explain"]);
    state.select(null);
    state.select(1);
    await until(() => view.events.filter((e) => e.startsWith("ready:")).length === 2);
    expect(fake.requests).toHaveLength(1);
    expect(view.events.slice(-3)).toEqual([
      "loading:Verb form",
      "text:Use *goes*.",
      "ready:Use *goes*.",
    ]);
  });

  it("a new check result forgets the cache, so the same issue asks again", async () => {
    const { state, view, fake, check } = realSetup([streamReply(["one"]), streamReply(["two"])]);
    check();
    state.select(1);
    await until(() => view.events.includes("ready:one"));
    check(); // a new result: the issues get new ids
    state.select(state.issues[0]?.id ?? null);
    await until(() => view.events.includes("ready:two"));
    expect(fake.requests).toHaveLength(2);
  });

  it("records the usage of a cancelled request that reported some", async () => {
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
    ];
    const { state, view, usage, check } = realSetup({ kind: "stream", chunks, hold: true });
    check();
    state.select(1);
    await until(() => view.events.includes("text:a"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.press("cancel");
    await until(() => usage.records.length === 1);
    expect(usage.records[0]).toMatchObject({
      kind: "explain",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(view.events.at(-1)).toBe("cancelled");
  });
});

describe("ExplanationController: regenerate(issueId) for the row menu", () => {
  it("selects an issue that is not selected and makes one request that skips the cache", () => {
    const { state, view, runner, controller, check } = setupManual();
    check();
    controller.regenerate(3);
    expect(state.selectedId).toBe(3);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.request).toMatchObject({
      key: `${String(state.checkId)}:3`,
      regenerate: true,
    });
    expect(view.events).toEqual(["loading:Collocation"]);
  });

  it("asks again for the selected issue without selecting anything", async () => {
    const { state, runner, controller, check } = setupManual();
    check();
    state.select(2);
    runner.calls[0]?.done.resolve(READY("first"));
    await tick();
    controller.regenerate(2);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.request).toMatchObject({ regenerate: true });
    expect(runner.calls[0]?.options.signal?.aborted).toBe(true);
  });

  it("a plain selection afterwards uses the cache again", () => {
    const { state, runner, controller, check } = setupManual();
    check();
    controller.regenerate(3);
    state.select(4);
    expect(runner.calls[1]?.request.regenerate).toBe(false);
  });

  it.each([
    { name: "an issue that does not exist", id: 99 },
    { name: "an issue of a hidden category", id: 3 },
  ])("does nothing for $name", ({ id }) => {
    const { state, view, runner, controller, check } = setupManual();
    check();
    state.setHidden("vocabulary", true);
    controller.regenerate(id);
    expect(runner.calls).toEqual([]);
    expect(view.events).toEqual([]);
    expect(state.selectedId).toBeNull();
  });
});
