// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExplainOptions, ExplainRequest, ExplainResult } from "../core/analysis";
import { AppError } from "../core/errors";
import type { ExplanationRunner } from "../core/issues";
import { deferred, placed, resultOf } from "../core/issues/testing/helpers";
import { Logger } from "../core/log";
import type { FrameMessage } from "../core/page-mode/protocol";
import { FakeScheduler } from "../core/testing/fake-clock";
import { FakeLinkOpener } from "../platform/testing/fake-link-opener";
import { BoxSession } from "./box-session";
import { BoxExplainers } from "./explainers";
import { Popover } from "./popover";
import { MODEL, sessionDeps, settle } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** The element a selector finds, which the test needs to be there. */
function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

const TEXT = "Yesterday I seen him. He go home.";
// "I seen" 10..16 (verb_form, grammar), "He go" 22..27 (subject_verb_agreement, grammar).
const ISSUES = [placed(10, 16, "verb_form"), placed(22, 27, "subject_verb_agreement")];

/** An explainer that answers from a script, and records what it was asked. */
class FakeExplainer implements ExplanationRunner {
  readonly asked: { request: ExplainRequest; signal: AbortSignal | undefined }[] = [];
  cancelled = 0;
  resets = 0;
  /** What the next request does; the default answers at once with a one-line explanation. */
  next: ((request: ExplainRequest, options: ExplainOptions) => Promise<ExplainResult>) | undefined;

  explain(
    _model: unknown,
    request: ExplainRequest,
    options: ExplainOptions = {},
  ): Promise<ExplainResult> {
    this.asked.push({ request, signal: options.signal });
    if (this.next !== undefined) return this.next(request, options);
    options.onText?.("Use goes.");
    return Promise.resolve({
      markdown: "Use goes.",
      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
      cached: false,
      cancelled: false,
    });
  }
  cancel(): void {
    this.cancelled++;
  }
  reset(): void {
    this.resets++;
  }
}

async function setup(options: { model?: boolean; stats?: Partial<StatsFake> } = {}) {
  const scheduler = new FakeScheduler();
  const logged: string[] = [];
  const record = (message: string) => {
    logged.push(message);
  };
  const log = new Logger({ debug: record, info: record, warn: record, error: record });
  const stats = new StatsFake(options.stats);
  const explainers: FakeExplainer[] = [];
  const links = new FakeLinkOpener();
  const changed = vi.fn();
  const popover = new Popover({
    doc: document,
    root: document.body,
    scheduler,
    stats,
    explainers: new BoxExplainers(() => {
      const explainer = new FakeExplainer();
      explainers.push(explainer);
      return explainer;
    }),
    getModel: () => (options.model === false ? undefined : MODEL),
    links,
    statsChanged: changed,
    log,
  });
  // A session that has been checked: it holds the two issues.
  const sent: FrameMessage[] = [];
  const parts = sessionDeps({ log });
  parts.runner.answer(resultOf(ISSUES));
  const session = new BoxSession(parts.deps, 1, "session:box-1", TEXT, 0);
  session.focus(0, TEXT);
  await settle();
  const send = (message: FrameMessage) => {
    sent.push(message);
  };
  const ids = session.state.issues.map((i) => i.id);
  const text = (selector: string) => document.querySelector(selector)?.textContent ?? "";
  return {
    popover,
    session,
    stats,
    explainers,
    links,
    scheduler,
    logged,
    sent,
    send,
    ids,
    changed,
    text,
  };
}

class StatsFake {
  readonly notErrors: { source: string; fingerprint: string }[] = [];
  readonly counted: string[] = [];
  fails: Error | undefined;
  pending: ReturnType<typeof deferred<undefined>> | undefined;
  total = 0;

  constructor(overrides: Partial<StatsFake> = {}) {
    Object.assign(this, overrides);
  }

  notAnError(source: string, fingerprint: string): Promise<boolean> {
    this.notErrors.push({ source, fingerprint });
    if (this.fails !== undefined) return Promise.reject(this.fails);
    if (this.pending !== undefined) return this.pending.promise.then(() => true);
    return Promise.resolve(true);
  }

  countForType(type: string) {
    this.counted.push(type);
    return Promise.resolve({ total: this.total, last7: 0, last30: 0 });
  }
}

describe("Popover: opening", () => {
  it("shows the shared explanation panel in its compact layout for the issue, and starts the explanation", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[1]!, 340, t.send);
    expect(t.popover.box).toBe(1);
    expect(t.popover.issue).toBe(t.ids[1]);
    const card = el("#popover");
    expect(card.hidden).toBe(false);
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.querySelector(".explain-compact")).not.toBeNull();
    expect(card.style.getPropertyValue("max-height")).toBe("340px");
    // The session's selection is the card's issue, so the explanation request was made for it.
    expect(t.session.state.selectedId).toBe(t.ids[1]);
    expect(t.explainers).toHaveLength(1);
    expect(t.explainers[0]?.asked[0]?.request).toMatchObject({ start: 22, end: 27, text: TEXT });
    await settle();
    expect(t.text("#explain-body")).toContain("Use goes.");
    expect(t.popover.panelState).toBe("ready");
    // The buttons: Not an error, Regenerate (ready), and All issues in the same row.
    const buttons = [...card.querySelectorAll(".explain-actions button")]
      .filter((b) => !(b as HTMLElement).hidden)
      .map((b) => b.textContent);
    expect(buttons).toEqual(["Not an error", "Regenerate", "All issues"]);
  });

  it("shows the header with the label first and then the counts of the error type", async () => {
    const t = await setup();
    t.stats.total = 7;
    t.popover.open(t.session, t.ids[1]!, 340, t.send);
    expect(t.text("#explain-header")).toBe("Subject-verb agreement");
    await settle();
    expect(t.stats.counted).toEqual(["subject_verb_agreement"]);
    expect(t.text("#explain-header")).toContain("you have made this mistake 7 times");
    // An issue of an automatic check is not counted.
    expect(t.text("#explain-header")).toContain("This one is not counted");
  });

  it("tells the content script how high the card is, once per height", async () => {
    const t = await setup();
    const height = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 131.4 } as DOMRect);
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    expect(t.sent).toEqual([{ type: "popover-size", box: 1, issue: t.ids[0], height: 132 }]);
    // The same size again, and a card that has no size yet, say nothing.
    t.popover.open(t.session, t.ids[0]!, 300, t.send);
    expect(t.sent).toHaveLength(1);
    expect(document.getElementById("popover")?.style.getPropertyValue("max-height")).toBe("300px");
    height.mockReturnValue({ height: 0 } as DOMRect);
    t.popover.open(t.session, t.ids[1]!, 300, t.send);
    expect(t.sent).toHaveLength(1);
    height.mockReturnValue({ height: 200 } as DOMRect);
    t.popover.open(t.session, t.ids[0]!, 300, t.send);
    expect(t.sent.at(-1)).toEqual({ type: "popover-size", box: 1, issue: t.ids[0], height: 200 });
  });

  it("closes at once, telling the content script, for an issue that is gone", async () => {
    const t = await setup();
    t.popover.open(t.session, 999, 340, t.send);
    expect(t.sent).toEqual([{ type: "popover-closed", box: 1 }]);
    expect(t.popover.issue).toBeUndefined();
    expect(t.explainers).toHaveLength(0);
    expect(document.getElementById("popover")!.hidden).toBe(true);
  });

  it("with no LLM, shows the failed state with the message and Retry", async () => {
    const t = await setup({ model: false });
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    expect(t.popover.panelState).toBe("failed");
    expect(t.text(".explain-error")).toBe(
      "No LLM is configured. Add one in Preferences to get explanations.",
    );
    expect(t.explainers[0]?.asked).toEqual([]);
  });

  it("shows a failed request in the card, and Retry asks again", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    const explainer = t.explainers[0]!;
    explainer.next = () => Promise.reject(new AppError("LLMCallFailed", "The server said no."));
    (document.getElementById("explain-regenerate") as HTMLButtonElement).click();
    await settle();
    expect(t.popover.panelState).toBe("failed");
    expect(t.text(".explain-error")).toBe("The server said no.");
    explainer.next = undefined;
    (document.getElementById("explain-retry") as HTMLButtonElement).click();
    await settle();
    expect(t.popover.panelState).toBe("ready");
    expect(explainer.asked).toHaveLength(3);
  });

  it("Regenerate skips the cache; Cancel stops a running request and says so", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    const explainer = t.explainers[0]!;
    const held = deferred<ExplainResult>();
    explainer.next = () => held.promise;
    (document.getElementById("explain-regenerate") as HTMLButtonElement).click();
    expect(explainer.asked.at(-1)?.request.regenerate).toBe(true);
    expect(t.popover.panelState).toBe("loading");
    (document.getElementById("explain-cancel") as HTMLButtonElement).click();
    expect(t.popover.panelState).toBe("cancelled");
    expect(t.text(".explain-message")).toBe("Explanation cancelled.");
  });
});

describe("Popover: switching and closing", () => {
  it("switches to another issue with the same session, keeping one explainer (its cache)", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    t.popover.open(t.session, t.ids[1]!, 340, t.send);
    expect(t.popover.issue).toBe(t.ids[1]);
    expect(t.session.state.selectedId).toBe(t.ids[1]);
    expect(t.explainers).toHaveLength(1);
    expect(t.explainers[0]?.asked.map((a) => a.request.start)).toEqual([10, 22]);
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    expect(t.explainers).toHaveLength(1);
    expect(t.explainers[0]?.asked.map((a) => a.request.key)).toEqual([
      `1:${String(t.ids[0])}`,
      `1:${String(t.ids[1])}`,
      `1:${String(t.ids[0])}`,
    ]);
  });

  it("closing cancels the running request, drops the selection and hides the card", async () => {
    const t = await setup();
    const held = deferred<ExplainResult>();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    const explainer = t.explainers[0]!;
    await settle();
    explainer.next = (_request, options) => {
      options.signal?.addEventListener("abort", () => {
        held.resolve({
          markdown: "",
          usage: { inputTokens: 0, outputTokens: 0, estimated: false },
          cached: false,
          cancelled: true,
        });
      });
      return held.promise;
    };
    (document.getElementById("explain-regenerate") as HTMLButtonElement).click();
    const signal = explainer.asked.at(-1)?.signal;
    t.popover.close();
    expect(signal?.aborted).toBe(true);
    expect(t.session.state.selectedId).toBeNull();
    expect(document.getElementById("popover")!.hidden).toBe(true);
    expect(t.popover.issue).toBeUndefined();
    // Closing says nothing to the content script: it asked for it.
    expect(t.sent.filter((m) => m.type === "popover-closed")).toEqual([]);
  });

  it("closes only for the box it was asked about", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    t.popover.close(2);
    expect(t.popover.issue).toBe(t.ids[0]);
    t.popover.close(1);
    expect(t.popover.issue).toBeUndefined();
  });

  it("closes itself when the issue goes (an edit, a new result), and says so", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    // An edit inside the issue removes it and its selection.
    t.session.edit({ revision: 1, start: 12, removed: 0, inserted: "x" });
    expect(t.popover.issue).toBeUndefined();
    expect(t.sent.at(-1)).toEqual({ type: "popover-closed", box: 1 });
  });

  it("closes on Escape pressed in the card, and ignores an Escape a page script dispatched", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(t.popover.issue).toBe(t.ids[0]);
    const escape = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(escape, "isTrusted", { value: true });
    document.dispatchEvent(escape);
    expect(t.popover.issue).toBeUndefined();
    expect(t.sent.at(-1)).toEqual({ type: "popover-closed", box: 1 });
  });

  it("forgets the cached explanations of a check result that was replaced, at the next open", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    t.popover.close();
    const explainer = t.explainers[0]!;
    // Same result: the cache stays.
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    expect(explainer.resets).toBe(0);
    t.popover.close();
    // A new check result: the old explanations are for issues that are gone.
    t.session.state.beginCheck(false);
    t.session.state.finishCheck(ISSUES, TEXT, 0);
    const first = t.session.state.issues[0];
    if (first === undefined) throw new Error("no issue");
    t.popover.open(t.session, first.id, 340, t.send);
    expect(explainer.resets).toBe(1);
    expect(t.explainers).toHaveLength(1);
  });
});

describe("Popover: Not an error and All issues", () => {
  it("Not an error records the pair under the box's source, removes the issue and closes the card", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    (document.getElementById("explain-not-error") as HTMLButtonElement).click();
    await settle();
    expect(t.stats.notErrors).toEqual([{ source: "session:box-1", fingerprint: "fp-10-16" }]);
    expect(t.session.state.issues.map((i) => i.id)).toEqual([t.ids[1]]);
    expect(t.popover.issue).toBeUndefined();
    expect(t.sent.at(-1)).toEqual({ type: "popover-closed", box: 1 });
    expect(t.changed).toHaveBeenCalledTimes(1);
  });

  it("keeps the issue and the card, and says why, when the statistics cannot be changed", async () => {
    const t = await setup({
      stats: { fails: new AppError("StatsResetFailed", "The mistake could not be removed.") },
    });
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    (document.getElementById("explain-not-error") as HTMLButtonElement).click();
    await settle();
    expect(t.session.state.issues).toHaveLength(2);
    expect(t.popover.issue).toBe(t.ids[0]);
    const error = document.getElementById("popover-error")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("The mistake could not be removed.");
    expect(t.changed).not.toHaveBeenCalled();
    // The message goes with the next open.
    t.popover.open(t.session, t.ids[1]!, 340, t.send);
    expect(error.hidden).toBe(true);
  });

  it("wraps an error that is not an AppError, without showing the user's text or a reply", async () => {
    const t = await setup({ stats: { fails: new TypeError("secret detail") } });
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    (document.getElementById("explain-not-error") as HTMLButtonElement).click();
    await settle();
    const shown = document.getElementById("popover-error")?.textContent ?? "";
    expect(shown).not.toContain("secret detail");
    expect(shown).not.toBe("");
  });

  it("does not close a card that moved on while Not an error was being stored", async () => {
    const pending = deferred<undefined>();
    const t = await setup({ stats: { pending } });
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    (document.getElementById("explain-not-error") as HTMLButtonElement).click();
    t.popover.open(t.session, t.ids[1]!, 340, t.send);
    pending.resolve(undefined);
    await settle();
    // The first issue is gone for good, and the card is still open for the second.
    expect(t.session.state.issues.map((i) => i.id)).toEqual([t.ids[1]]);
    expect(t.popover.issue).toBe(t.ids[1]);
  });

  it("All issues asks the content script for the dialog and leaves the card as it is", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    (document.getElementById("popover-all-issues") as HTMLButtonElement).click();
    expect(t.sent.at(-1)).toEqual({ type: "all-issues", box: 1 });
    expect(t.popover.issue).toBe(t.ids[0]);
  });

  it("keeps the focus in the text box: a press on a button is cancelled, a press on the text is not", async () => {
    const t = await setup();
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    const press = (target: Element) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press(document.getElementById("explain-not-error") as Element)).toBe(true);
    expect(press(document.getElementById("popover-all-issues") as Element)).toBe(true);
    expect(press(document.getElementById("explain-body") as Element)).toBe(false);
  });
});

describe("Popover: links in the explanation", () => {
  async function withLink() {
    const t = await setup();
    const explainer = () => t.explainers[0]!;
    t.popover.open(t.session, t.ids[0]!, 340, t.send);
    await settle();
    explainer().next = (_request, options) => {
      options.onText?.("See [the guide](https://example.com/guide).");
      return Promise.resolve({
        markdown: "See [the guide](https://example.com/guide).",
        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        cached: false,
        cancelled: false,
      });
    };
    (document.getElementById("explain-regenerate") as HTMLButtonElement).click();
    await settle();
    return t;
  }

  it("asks first, inside the card, which grows to hold the question; Open link opens it in a new tab", async () => {
    const t = await withLink();
    const card = el("#popover");
    el("#explain-body a").click();
    expect(t.links.opened).toEqual([]);
    expect(document.getElementById("link-confirm")!.hidden).toBe(false);
    expect(document.getElementById("link-confirm-url")?.textContent).toBe(
      "https://example.com/guide",
    );
    expect(card.classList.contains("popover-confirming")).toBe(true);
    document.getElementById("link-confirm-open")!.click();
    await settle();
    expect(t.links.opened).toEqual(["https://example.com/guide"]);
    expect(card.classList.contains("popover-confirming")).toBe(false);
  });

  it("opens nothing when the user cancels, or when the card closes with the question open", async () => {
    const t = await withLink();
    el("#explain-body a").click();
    document.getElementById("link-confirm-cancel")!.click();
    await settle();
    expect(t.links.opened).toEqual([]);
    el("#explain-body a").click();
    t.popover.close();
    await settle();
    expect(document.getElementById("link-confirm")!.hidden).toBe(true);
    expect(t.links.opened).toEqual([]);
  });
});
