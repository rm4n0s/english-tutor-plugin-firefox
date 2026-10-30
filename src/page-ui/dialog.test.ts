// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AnalysisModel,
  ExplainOptions,
  ExplainRequest,
  ExplainResult,
} from "../core/analysis";
import { AppError } from "../core/errors";
import type { ExplanationRunner } from "../core/issues";
import { placed, resultOf } from "../core/issues/testing/helpers";
import { Logger } from "../core/log";
import type { FrameMessage } from "../core/page-mode/protocol";
import { FakeScheduler } from "../core/testing/fake-clock";
import type { FrameActions } from "../platform/page-mode";
import { FakeLinkOpener } from "../platform/testing/fake-link-opener";
import { BoxSession } from "./box-session";
import { Dialog } from "./dialog";
import { BoxExplainers } from "./explainers";
import { MODEL, sessionDeps, settle } from "./testing";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}
const text = (selector: string) => document.querySelector(selector)?.textContent ?? "";

const TEXT = "Yesterday I seen him. He go home.";
// "I seen" 10..16 (verb_form, grammar), "He go" 22..27 (subject_verb_agreement, grammar).
const ISSUES = [placed(10, 16, "verb_form"), placed(22, 27, "subject_verb_agreement")];

class FakeExplainer implements ExplanationRunner {
  readonly asked: ExplainRequest[] = [];
  explain(
    _model: unknown,
    request: ExplainRequest,
    options: ExplainOptions = {},
  ): Promise<ExplainResult> {
    this.asked.push(request);
    options.onText?.("Use goes.");
    return Promise.resolve({
      markdown: "Use goes.",
      usage: { inputTokens: 1, outputTokens: 1, estimated: false },
      cached: false,
      cancelled: false,
    });
  }
  cancel(): void {
    // Nothing runs.
  }
  reset(): void {
    // Nothing is cached.
  }
}

class StatsFake {
  readonly notErrors: { source: string; fingerprint: string }[] = [];
  readonly counted: string[] = [];
  fails: Error | undefined;
  total = 0;

  notAnError(source: string, fingerprint: string): Promise<boolean> {
    this.notErrors.push({ source, fingerprint });
    return this.fails === undefined ? Promise.resolve(true) : Promise.reject(this.fails);
  }

  countForType(type: string) {
    this.counted.push(type);
    return Promise.resolve({ total: this.total, last7: 0, last30: 0 });
  }
}

class ActionsFake implements FrameActions {
  readonly tutor: string[] = [];
  options = 0;
  fails: Error | undefined;

  openInTutor(text: string): Promise<void> {
    this.tutor.push(text);
    return this.fails === undefined ? Promise.resolve() : Promise.reject(this.fails);
  }

  openOptions(): Promise<void> {
    this.options++;
    return this.fails === undefined ? Promise.resolve() : Promise.reject(this.fails);
  }
}

async function setup(options: { model?: boolean; text?: string } = {}) {
  const scheduler = new FakeScheduler();
  const logged: string[] = [];
  const record = (message: string) => {
    logged.push(message);
  };
  const log = new Logger({ debug: record, info: record, warn: record, error: record });
  const stats = new StatsFake();
  const actions = new ActionsFake();
  const links = new FakeLinkOpener();
  const explainer = new FakeExplainer();
  const statsChanged = vi.fn();
  const settingsListeners = new Set<() => void>();
  const statsListeners = new Set<() => void>();
  const settings = {
    model: options.model === false ? (undefined as AnalysisModel | undefined) : MODEL,
    getModel() {
      return this.model;
    },
    subscribe(listener: () => void) {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    },
  };
  const dialog = new Dialog({
    doc: document,
    root: document.body,
    scheduler,
    stats,
    explainers: new BoxExplainers(() => explainer),
    settings,
    links,
    actions,
    statsChanged,
    onStatsChanged: (listener) => {
      statsListeners.add(listener);
      return () => {
        statsListeners.delete(listener);
      };
    },
    log,
  });
  const parts = sessionDeps({ log });
  parts.settings.model = settings.model;
  const bodyText = options.text ?? TEXT;
  parts.runner.answer(resultOf(ISSUES));
  const session = new BoxSession(parts.deps, 1, "session:box-1", bodyText, 0);
  session.focus(0, bodyText);
  await settle();
  const sent: FrameMessage[] = [];
  const send = (message: FrameMessage) => {
    sent.push(message);
  };
  const ids = session.state.issues.map((i) => i.id);
  return {
    dialog,
    session,
    parts,
    stats,
    actions,
    links,
    explainer,
    settings,
    settingsChanged: () => {
      for (const listener of [...settingsListeners]) listener();
    },
    statsChangedElsewhere: () => {
      for (const listener of [...statsListeners]) listener();
    },
    statsChanged,
    scheduler,
    logged,
    sent,
    send,
    ids,
    open: (issue: number | null = null) => {
      dialog.open(session, issue, send);
    },
  };
}

const click = (selector: string) => {
  el(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
};
const rows = () => [...document.querySelectorAll<HTMLElement>(".issue-row")];
const trusted = <T extends Event>(event: T): T => {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
};

describe("Dialog: opening", () => {
  it("shows the issues list on top and the explanation panel below, and says it is drawn", async () => {
    const t = await setup();
    t.open();
    expect(el("#dialog").hidden).toBe(false);
    expect(el("#dialog").getAttribute("role")).toBe("dialog");
    expect(text("#issues-header")).toBe("Issues (2)");
    expect(rows().map((r) => r.querySelector(".row-snippet")?.textContent)).toEqual([
      "I seen",
      "He go",
    ]);
    expect(rows().map((r) => r.querySelector(".row-label")?.textContent)).toEqual([
      "Verb form",
      "Subject-verb agreement",
    ]);
    // The list is above the explanation, which is idle until an issue is selected.
    const dialog = el("#dialog");
    const order = [...dialog.children].map((c) => c.id);
    expect(order.indexOf("dialog-issues")).toBeLessThan(order.indexOf("dialog-explanation"));
    expect(text("#explanation-hint")).toContain("Select an error");
    expect(t.sent).toEqual([{ type: "dialog-ready", box: 1 }]);
    // No legend toggles: those are for the tutor page.
    expect(document.querySelector(".legend")).toBeNull();
  });

  it("has Check, Open in English Tutor and Close, and Not an error once an issue is selected", async () => {
    const t = await setup();
    t.open();
    expect(text("#dialog-check")).toBe("Check");
    expect(text("#dialog-open-tutor")).toBe("Open in English Tutor");
    expect(text("#dialog-close")).toBe("Close");
    expect(document.querySelector("#explain-not-error")).toBeNull();
    click(".issue-row");
    expect(text("#explain-not-error")).toBe("Not an error");
  });

  it("selects the issue the popover showed when it is opened with one, and reports it", async () => {
    const t = await setup();
    t.open(t.ids[1] ?? 0);
    expect(t.session.state.selectedId).toBe(t.ids[1]);
    expect(t.sent).toEqual([
      { type: "dialog-select", box: 1, issue: t.ids[1] },
      { type: "dialog-ready", box: 1 },
    ]);
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
    await settle();
    expect(t.explainer.asked).toHaveLength(1);
  });

  it("opens with nothing selected when the issue is gone", async () => {
    const t = await setup();
    t.open(999);
    expect(t.session.state.selectedId).toBeNull();
    expect(t.sent).toEqual([{ type: "dialog-ready", box: 1 }]);
  });

  it("shows the empty line of an unchecked box", async () => {
    const t = await setup({ text: "one two" });
    // Nothing was checked: the first answer queued by `setup` was never asked for.
    t.open();
    expect(rows()).toHaveLength(0);
    expect(text(".empty")).toContain("Press Check");
  });
});

describe("Dialog: the text changes while it is open", () => {
  it("shows the empty state, with no row, when the page empties the box, and Check is disabled", async () => {
    const t = await setup();
    t.open(t.ids[0] ?? 0);
    expect(rows()).toHaveLength(2);
    t.session.edit({ revision: 1, start: 0, removed: TEXT.length, inserted: "" });
    await settle();
    expect(rows()).toHaveLength(0);
    expect(text("#issues-header")).toBe("Issues (0)");
    expect(text(".empty")).toContain("Press Check");
    expect((el("#dialog-check") as HTMLButtonElement).disabled).toBe(true);
    expect(t.session.state.selectedId).toBeNull();
  });

  it("drops the rows of a text the page replaced, whatever the new text says", async () => {
    const t = await setup();
    t.open();
    t.session.edit({ revision: 1, start: 0, removed: TEXT.length, inserted: "Another text now" });
    await settle();
    expect(rows()).toHaveLength(0);
    expect(text(".empty")).toContain("Press Check");
  });
});

describe("Dialog: selecting a row", () => {
  it("selects the issue in the state, tells the content script, and explains it", async () => {
    const t = await setup();
    t.open();
    t.sent.length = 0;
    rows()[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(t.session.state.selectedId).toBe(t.ids[1]);
    expect(t.sent).toEqual([{ type: "dialog-select", box: 1, issue: t.ids[1] }]);
    await settle();
    expect(t.explainer.asked).toHaveLength(1);
    expect(text("#explain-snippet") + text("#explain-body")).toContain("He go");
    expect(text("#explain-body")).toContain("Use goes.");
  });

  it("says no issue is selected when the selection is cleared", async () => {
    const t = await setup();
    t.open(t.ids[0] ?? 0);
    t.sent.length = 0;
    t.session.state.select(null);
    expect(t.sent).toEqual([{ type: "dialog-select", box: 1, issue: null }]);
  });

  it("shows the header line with the counts of the type", async () => {
    const t = await setup();
    t.stats.total = 3;
    t.open(t.ids[0] ?? 0);
    await settle();
    expect(text("#explain-header")).toContain("Verb form: you have made this mistake 3 times");
  });
});

describe("Dialog: Check", () => {
  it("runs a manual check, records it, and shows its issues with their counts", async () => {
    const t = await setup();
    t.open();
    t.stats.total = 2;
    t.parts.runner.answer(resultOf([placed(22, 27, "subject_verb_agreement")]));
    click("#dialog-check");
    await settle();
    expect(t.parts.recorder.recorded).toHaveLength(1);
    expect(t.parts.recorder.recorded[0]?.source).toBe("session:box-1");
    expect(t.parts.recorder.recorded[0]?.llmName).toBe("Fake LLM");
    expect(t.parts.recorder.announced).toBe(1);
    expect(text("#issues-header")).toBe("Issues (1)");
    // The count badge of the manual check's row.
    expect(text(".count-badge")).toBe("x2");
    expect(text("#dialog-status")).toBe("1 issue");
  });

  it("becomes Cancel while it runs, and Cancel leaves everything as it was", async () => {
    const t = await setup();
    t.open();
    const finish = t.parts.runner.hold();
    click("#dialog-check");
    await settle();
    expect(text("#dialog-check")).toBe("Cancel");
    expect(text("#dialog-status")).toBe("Checking...");
    click("#dialog-check");
    finish(resultOf([]));
    await settle();
    expect(text("#dialog-check")).toBe("Check");
    expect(text("#issues-header")).toBe("Issues (2)");
    expect(t.parts.recorder.recorded).toEqual([]);
    expect(text("#dialog-status")).toBe("Check cancelled");
  });

  it("shows Check, not Cancel, while an automatic check runs: pressing it replaces that check", async () => {
    const t = await setup();
    t.open();
    t.session.state.beginCheck(false);
    expect(text("#dialog-status")).toBe("Checking...");
    expect(text("#dialog-check")).toBe("Check");
    expect((el("#dialog-check") as HTMLButtonElement).disabled).toBe(false);
    t.parts.runner.answer(resultOf(ISSUES));
    click("#dialog-check");
    await settle();
    expect(t.parts.recorder.recorded).toHaveLength(1);
  });

  it("shows the failure in the error line and keeps the issues", async () => {
    const t = await setup();
    t.open();
    t.parts.runner.fail(new AppError("LLMCallFailed", "The server said no"));
    click("#dialog-check");
    await settle();
    expect(el("#dialog-error").hidden).toBe(false);
    expect(text("#dialog-error")).toBe("The server said no");
    expect(el("#dialog-error").getAttribute("role")).toBe("alert");
    expect(text("#dialog-status")).toBe("Check failed");
    expect(rows()).toHaveLength(2);
  });

  it("shows a failed recording without hiding the issues", async () => {
    const t = await setup();
    t.open();
    t.parts.recorder.fails = new AppError("ErrorEventSaveFailed", "Could not save the mistakes");
    t.parts.runner.answer(resultOf(ISSUES));
    click("#dialog-check");
    await settle();
    expect(text("#dialog-error")).toBe("Could not save the mistakes");
    expect(rows()).toHaveLength(2);
  });

  it("is disabled for a blank text, and Open in English Tutor too", async () => {
    const t = await setup({ text: "   " });
    t.open();
    expect((el("#dialog-check") as HTMLButtonElement).disabled).toBe(true);
    expect((el("#dialog-open-tutor") as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears the selection and the explanation when the new result replaces the issues", async () => {
    const t = await setup();
    t.open(t.ids[0] ?? 0);
    await settle();
    t.sent.length = 0;
    t.parts.runner.answer(resultOf(ISSUES));
    click("#dialog-check");
    await settle();
    expect(t.session.state.selectedId).toBeNull();
    expect(t.sent).toContainEqual({ type: "dialog-select", box: 1, issue: null });
    expect(document.querySelector("#explanation-hint")).not.toBeNull();
  });
});

describe("Dialog: no LLM", () => {
  it("says so in the panel, with a link that opens the options page, and Check is disabled", async () => {
    const t = await setup({ model: false });
    t.open();
    expect(text("#explanation-hint")).toBe(
      "No LLM is configured. Add one in Preferences to start checking.",
    );
    expect((el("#dialog-check") as HTMLButtonElement).disabled).toBe(true);
    const link = el("#options-link");
    const opened = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(opened);
    expect(opened.defaultPrevented).toBe(true);
    expect(t.actions.options).toBe(1);
  });

  it("follows the settings: Check works once an LLM is set up", async () => {
    const t = await setup({ model: false });
    t.open();
    t.settings.model = MODEL;
    t.settingsChanged();
    expect((el("#dialog-check") as HTMLButtonElement).disabled).toBe(false);
    expect(text("#explanation-hint")).toContain("Select an error");
  });

  it("shows why the options page did not open", async () => {
    const t = await setup({ model: false });
    t.open();
    t.actions.fails = new AppError(
      "PageDialogActionFailed",
      "No answer from the background script",
    );
    click("#options-link");
    await settle();
    expect(text("#dialog-error")).toBe("No answer from the background script");
    expect(t.logged.some((m) => m.includes("background script"))).toBe(true);
  });
});

describe("Dialog: Not an error", () => {
  it("adds the pair to the ignore set under the box's source, and the issue and its row go at once", async () => {
    const t = await setup();
    t.open(t.ids[0] ?? 0);
    await settle();
    click("#explain-not-error");
    await settle();
    expect(t.stats.notErrors).toEqual([{ source: "session:box-1", fingerprint: "fp-10-16" }]);
    expect(t.session.state.issues.map((i) => i.id)).toEqual([t.ids[1]]);
    expect(rows()).toHaveLength(1);
    expect(t.statsChanged).toHaveBeenCalledTimes(1);
    expect(t.sent.at(-1)).toEqual({ type: "dialog-select", box: 1, issue: null });
  });

  it("keeps the issue and shows the message when it fails", async () => {
    const t = await setup();
    t.stats.fails = new AppError("StatsResetFailed", "The change could not be saved");
    t.open(t.ids[0] ?? 0);
    await settle();
    click("#explain-not-error");
    await settle();
    expect(t.session.state.issues).toHaveLength(2);
    expect(text("#dialog-error")).toBe("The change could not be saved");
    expect(t.statsChanged).not.toHaveBeenCalled();
  });

  it("shows a fixed message, not the error's own text, for a failure that is not an AppError", async () => {
    const t = await setup();
    t.stats.fails = new Error("secret user text");
    t.open(t.ids[0] ?? 0);
    await settle();
    click("#explain-not-error");
    await settle();
    expect(text("#dialog-error")).toBe("The change could not be saved.");
    expect(t.logged.join("\n")).not.toContain("secret user text");
  });
});

describe("Dialog: Open in English Tutor", () => {
  it("hands the box's text to the background script, and changes nothing in the dialog", async () => {
    const t = await setup();
    t.open();
    click("#dialog-open-tutor");
    await settle();
    expect(t.actions.tutor).toEqual([TEXT]);
    expect(el("#dialog").hidden).toBe(false);
    expect(el("#dialog-error").hidden).toBe(true);
  });

  it("shows the message when it fails", async () => {
    const t = await setup();
    t.open();
    t.actions.fails = new AppError("PageDialogActionFailed", "English Tutor could not be opened");
    click("#dialog-open-tutor");
    await settle();
    expect(text("#dialog-error")).toBe("English Tutor could not be opened");
  });

  it("wraps a failure that is not an AppError, without showing its text", async () => {
    const t = await setup();
    t.open();
    t.actions.fails = new Error("no receiver");
    click("#dialog-open-tutor");
    await settle();
    expect(el("#dialog-error").hidden).toBe(false);
    expect(t.logged.some((m) => m.includes("background script"))).toBe(true);
  });
});

describe("Dialog: closing", () => {
  it("closes on the Close button and tells the content script, and selects nothing any more", async () => {
    const t = await setup();
    t.open(t.ids[0] ?? 0);
    t.sent.length = 0;
    click("#dialog-close");
    expect(el("#dialog").hidden).toBe(true);
    // The selection is dropped without a message of its own: the close says it.
    expect(t.sent).toEqual([{ type: "dialog-closed", box: 1 }]);
    expect(t.session.state.selectedId).toBeNull();
    expect(document.querySelector(".issue-row")).toBeNull();
  });

  it("closes on a trusted Escape, and not on one the page made up", async () => {
    const t = await setup();
    t.open();
    t.sent.length = 0;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(el("#dialog").hidden).toBe(false);
    document.dispatchEvent(trusted(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(el("#dialog").hidden).toBe(true);
    expect(t.sent).toEqual([{ type: "dialog-closed", box: 1 }]);
  });

  it("closes on the content script's request, without a message back", async () => {
    const t = await setup();
    t.open();
    t.sent.length = 0;
    t.dialog.close(2);
    expect(el("#dialog").hidden).toBe(false);
    t.dialog.close(1);
    expect(el("#dialog").hidden).toBe(true);
    expect(t.sent).toEqual([]);
  });

  it("keeps a check that runs: closing the dialog does not cancel it", async () => {
    const t = await setup();
    t.open();
    const finish = t.parts.runner.hold();
    click("#dialog-check");
    await settle();
    click("#dialog-close");
    expect(t.session.state.pending?.manual).toBe(true);
    finish(resultOf([placed(10, 16, "verb_form")]));
    await settle();
    expect(t.session.state.issues).toHaveLength(1);
    expect(t.parts.recorder.recorded).toHaveLength(1);
  });

  it("is replaced when it opens for another box, without a message about the first", async () => {
    const t = await setup();
    t.open(t.ids[0] ?? 0);
    const other = sessionDeps();
    other.runner.answer(resultOf([placed(0, 3, "verb_form")]));
    const second = new BoxSession(other.deps, 2, "session:box-2", "Foo bar baz", 0);
    second.focus(0, "Foo bar baz");
    await settle();
    t.sent.length = 0;
    t.dialog.open(second, null, t.send);
    expect(t.dialog.box).toBe(2);
    expect(text("#issues-header")).toBe("Issues (1)");
    expect(t.session.state.selectedId).toBeNull();
    expect(t.sent).toEqual([{ type: "dialog-ready", box: 2 }]);
  });
});

describe("Dialog: focus and counts", () => {
  it("cancels the press on a button, so the text box keeps its focus, but not on a row", async () => {
    const t = await setup();
    t.open();
    const press = (target: Element) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(press(el("#dialog-check"))).toBe(true);
    expect(press(el("#dialog-close"))).toBe(true);
    expect(press(el("#dialog-open-tutor"))).toBe(true);
    expect(press(rows()[0]!)).toBe(false);
  });

  it("never takes the focus by itself", async () => {
    const t = await setup();
    t.open(t.ids[0] ?? 0);
    expect(document.activeElement).toBe(document.body);
  });

  it("reads the counts again when another page announces stats-changed", async () => {
    const t = await setup();
    t.open();
    await settle();
    const before = t.stats.counted.length;
    t.statsChangedElsewhere();
    await settle();
    expect(t.stats.counted.length).toBeGreaterThan(before);
  });

  it("stops listening for other pages when it is closed", async () => {
    const t = await setup();
    t.open();
    await settle();
    click("#dialog-close");
    const before = t.stats.counted.length;
    t.statsChangedElsewhere();
    await settle();
    expect(t.stats.counted).toHaveLength(before);
  });

  it("opens links of the explanation after the confirmation, through the frame's opener", async () => {
    const t = await setup();
    t.explainer.explain = (_m, _r, options) => {
      options?.onText?.("See [guide](https://example.com/guide).");
      return Promise.resolve({
        markdown: "See [guide](https://example.com/guide).",
        usage: { inputTokens: 1, outputTokens: 1, estimated: false },
        cached: false,
        cancelled: false,
      });
    };
    t.open(t.ids[0] ?? 0);
    await settle();
    el("#explain-body a").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(t.links.opened).toEqual([]);
    click("#link-confirm-open");
    await settle();
    expect(t.links.opened).toEqual(["https://example.com/guide"]);
  });
});
