import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import { placed, resultOf } from "../core/issues/testing/helpers";
import { BoxSession, NO_LLM_MESSAGE, NOT_CHECKED_MESSAGE, TOO_LONG_MESSAGE } from "./box-session";
import { sessionDeps, settle, states } from "./testing";

const TEXT = "Yesterday I seen him. He go home.";
// "I seen" is 10..16, "He go" is 22..27.
const ISSUES = [placed(10, 16, "verb_form"), placed(22, 27, "subject_verb_agreement")];

function make(text = TEXT, revision = 0) {
  const t = sessionDeps();
  const session = new BoxSession(t.deps, 1, "session:s", text, revision);
  return { ...t, session };
}

describe("BoxSession: the check on focus", () => {
  it("checks a text with 3 words or more when the box gets the focus, and sends the issues", async () => {
    const t = make();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    expect(t.runner.asked).toHaveLength(1);
    expect(t.runner.asked[0]?.text).toBe(TEXT);
    const last = states(t.sent).at(-1);
    expect(last).toMatchObject({ box: 1, revision: 0, status: "checked" });
    expect(last?.issues.map((i) => [i.start, i.end, i.category])).toEqual([
      [10, 16, "grammar"],
      [22, 27, "grammar"],
    ]);
  });

  it("is an automatic check: nothing marks it as manual (it is never recorded)", async () => {
    const t = make();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    expect(t.session.state.issues.every((issue) => !issue.manual)).toBe(true);
  });

  it("says checking while the check runs", async () => {
    const t = make();
    const finish = t.runner.hold();
    t.session.focus(0, TEXT);
    await settle();
    expect(states(t.sent).at(-1)?.status).toBe("checking");
    finish(resultOf(ISSUES));
    await settle();
    expect(states(t.sent).at(-1)?.status).toBe("checked");
  });

  it.each([
    { name: "no words", text: "" },
    { name: "two words", text: "Hello there" },
    { name: "only white space", text: "   \n  " },
  ])("does not check $name, and says idle", async ({ text }) => {
    const t = make(text);
    t.session.focus(0, text);
    await settle();
    expect(t.runner.asked).toEqual([]);
    expect(states(t.sent).at(-1)?.status).toBe("idle");
  });

  it("checks exactly 3 words", async () => {
    const t = make("one two three");
    t.runner.answer(resultOf([]));
    t.session.focus(0, "one two three");
    await settle();
    expect(t.runner.asked).toHaveLength(1);
    expect(states(t.sent).at(-1)?.status).toBe("checked");
  });

  it("does not check again when it focuses a box that has a result for its text", async () => {
    const t = make();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    t.session.blur();
    t.session.focus(0, TEXT);
    await settle();
    expect(t.runner.asked).toHaveLength(1);
    expect(states(t.sent).at(-1)?.status).toBe("checked");
  });

  it("checks again on a focus after a failure", async () => {
    const t = make();
    t.runner.fail(new AppError("LLMCallFailed", "It failed")).answer(resultOf([]));
    t.session.focus(0, TEXT);
    await settle();
    t.session.blur();
    t.session.focus(0, TEXT);
    await settle();
    expect(t.runner.asked).toHaveLength(2);
    expect(states(t.sent).at(-1)?.status).toBe("checked");
  });
});

describe("BoxSession: too long, failures and no LLM", () => {
  it("says too-long for more than 10,000 words and sends nothing to the LLM", async () => {
    const text = Array.from({ length: 10_001 }, () => "word").join(" ");
    const t = make(text);
    t.session.focus(0, text);
    await settle();
    expect(t.runner.asked).toEqual([]);
    expect(states(t.sent).at(-1)).toMatchObject({ status: "too-long", message: TOO_LONG_MESSAGE });
  });

  it("checks exactly 10,000 words", async () => {
    const text = Array.from({ length: 10_000 }, () => "word").join(" ");
    const t = make(text);
    t.runner.answer(resultOf([]));
    t.session.focus(0, text);
    await settle();
    expect(t.runner.asked).toHaveLength(1);
  });

  it("says failed with the error's message, and keeps the old issues", async () => {
    const t = make();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    t.session.edit({ revision: 1, start: TEXT.length, removed: 0, inserted: " Ok." });
    t.runner.fail(new AppError("LLMCallTimeout", "The request timed out"));
    t.scheduler.advance(3000);
    await settle();
    const last = states(t.sent).at(-1);
    expect(last).toMatchObject({ status: "failed", message: "The request timed out" });
    expect(last?.issues).toHaveLength(2);
  });

  it("says no-llm when there is none, and does not call the runner", async () => {
    const t = make();
    t.settings.model = undefined;
    t.session.focus(0, TEXT);
    await settle();
    expect(t.runner.asked).toEqual([]);
    expect(states(t.sent).at(-1)).toMatchObject({ status: "no-llm", message: NO_LLM_MESSAGE });
  });

  it("recovers when the LLM appears: the next focus checks", async () => {
    const t = make();
    t.settings.model = undefined;
    t.session.focus(0, TEXT);
    await settle();
    t.session.blur();
    t.settings.model = sessionDeps().settings.model;
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    expect(states(t.sent).at(-1)?.status).toBe("checked");
  });
});

describe("BoxSession: edits", () => {
  async function checked() {
    const t = make();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    t.sent.length = 0;
    return t;
  }

  it("moves and removes issues at once, and answers with the revision it now has", async () => {
    const t = await checked();
    // Typing inside "I seen" (at 12) removes it; "He go" moves by one.
    t.session.edit({ revision: 1, start: 12, removed: 0, inserted: "X" });
    const last = states(t.sent).at(-1);
    expect(last?.revision).toBe(1);
    expect(last?.issues.map((i) => [i.start, i.end])).toEqual([[23, 28]]);
    expect(t.session.text).toBe("Yesterday I Xseen him. He go home.");
  });

  it("goes idle when no issue is left", async () => {
    const t = await checked();
    t.session.edit({ revision: 1, start: 12, removed: 0, inserted: "X" });
    t.session.edit({ revision: 2, start: 24, removed: 0, inserted: "Y" });
    const last = states(t.sent).at(-1);
    expect(last).toMatchObject({ revision: 2, status: "idle" });
    expect(last?.issues).toEqual([]);
  });

  it("asks for the whole text when an edit skips a revision, and ignores edits until it comes", async () => {
    const t = await checked();
    t.session.edit({ revision: 3, start: 0, removed: 0, inserted: "x" });
    expect(t.sent.filter((m) => m.type === "resync")).toEqual([{ type: "resync", box: 1 }]);
    t.session.edit({ revision: 4, start: 0, removed: 0, inserted: "y" });
    expect(t.sent.filter((m) => m.type === "resync")).toHaveLength(2);
    expect(t.session.text).toBe(TEXT);
    t.session.setText(4, "A new text here");
    expect(t.session.text).toBe("A new text here");
    expect(t.session.wireRevision).toBe(4);
    t.session.edit({ revision: 5, start: 0, removed: 1, inserted: "a" });
    expect(t.session.text).toBe("a new text here");
  });

  it("asks for the text when an edit does not fit", async () => {
    const t = await checked();
    t.session.edit({ revision: 1, start: 500, removed: 5, inserted: "" });
    expect(t.sent.some((m) => m.type === "resync")).toBe(true);
    expect(t.session.text).toBe(TEXT);
  });

  it("ignores an edit it already has", async () => {
    const t = await checked();
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "x" });
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "x" });
    expect(t.session.text.startsWith("xxYes")).toBe(false);
    expect(t.session.wireRevision).toBe(1);
  });

  it("a loaded text (after a resync) clears the issues", async () => {
    const t = await checked();
    t.session.setText(7, "Something else entirely now");
    const last = states(t.sent).at(-1);
    expect(last).toMatchObject({ revision: 7, status: "idle" });
    expect(last?.issues).toEqual([]);
  });

  it("takes the content script's text and revision on a focus that disagrees", async () => {
    const t = await checked();
    t.runner.answer(resultOf([]));
    t.session.focus(5, "A completely different text");
    await settle();
    expect(t.session.text).toBe("A completely different text");
    expect(t.session.wireRevision).toBe(5);
    expect(states(t.sent).at(-1)).toMatchObject({ revision: 5, status: "checked" });
  });
});

describe("BoxSession: the check after the pause in typing", () => {
  async function focused() {
    const t = make();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    t.runner.asked.length = 0;
    return t;
  }

  it("starts after the auto_check_delay_s of no typing, and each key restarts the wait", async () => {
    const t = await focused();
    t.runner.answer(resultOf([]));
    t.session.edit({ revision: 1, start: TEXT.length, removed: 0, inserted: " a" });
    t.scheduler.advance(2000);
    t.session.edit({ revision: 2, start: TEXT.length + 2, removed: 0, inserted: "b" });
    t.scheduler.advance(2999);
    expect(t.runner.asked).toEqual([]);
    t.scheduler.advance(1);
    await settle();
    expect(t.runner.asked).toHaveLength(1);
    expect(t.runner.asked[0]?.text).toBe(`${TEXT} ab`);
  });

  it("uses the delay of the settings each time", async () => {
    const t = await focused();
    t.settings.delaySeconds = 1;
    t.runner.answer(resultOf([]));
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "x" });
    t.scheduler.advance(1000);
    await settle();
    expect(t.runner.asked).toHaveLength(1);
  });

  it("checks only the focused box: a box that lost the focus is not checked", async () => {
    const t = await focused();
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "x" });
    t.session.blur();
    t.scheduler.advance(10_000);
    await settle();
    expect(t.runner.asked).toEqual([]);
  });

  it("does not check a text that has fewer than 3 words", async () => {
    const t = await focused();
    t.session.setText(1, "one two");
    t.session.edit({ revision: 2, start: 7, removed: 0, inserted: "!" });
    t.scheduler.advance(10_000);
    await settle();
    expect(t.runner.asked).toEqual([]);
  });

  it("does not cancel a running check: it waits for another pause", async () => {
    const t = await focused();
    const finish = t.runner.hold();
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "x" });
    t.scheduler.advance(3000);
    await settle();
    expect(t.runner.asked).toHaveLength(1);
    t.session.edit({ revision: 2, start: 0, removed: 0, inserted: "y" });
    t.runner.answer(resultOf([]));
    t.scheduler.advance(3000);
    await settle();
    // The first is still running: no second request yet.
    expect(t.runner.asked).toHaveLength(1);
    finish(resultOf(ISSUES));
    await settle();
    t.scheduler.advance(3000);
    await settle();
    expect(t.runner.asked).toHaveLength(2);
  });

  it("rebases a result across the edits made while it was being made", async () => {
    const t = make();
    const finish = t.runner.hold();
    t.session.focus(0, TEXT);
    await settle();
    // Typing at the start while the check runs: the issues of the result move by 4.
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "Oh! " });
    finish(resultOf(ISSUES));
    await settle();
    const last = states(t.sent).at(-1);
    expect(last?.revision).toBe(1);
    expect(last?.issues.map((i) => [i.start, i.end])).toEqual([
      [14, 20],
      [26, 31],
    ]);
  });
});

describe("BoxSession: leaving", () => {
  it("cancels a running check and sends nothing after it is disposed", async () => {
    const t = make();
    const finish = t.runner.hold();
    t.session.focus(0, TEXT);
    await settle();
    t.session.dispose();
    const count = t.sent.length;
    finish(resultOf(ISSUES));
    await settle();
    expect(t.sent).toHaveLength(count);
    expect(t.scheduler.pending).toBe(0);
  });

  it("stops a waiting pause when the box loses the focus or is disposed", async () => {
    const t = make();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "x" });
    expect(t.scheduler.pending).toBe(1);
    t.session.blur();
    expect(t.scheduler.pending).toBe(0);
  });
});

describe("BoxSession: the dialog's manual check", () => {
  /** A box that has been checked once, automatically. */
  async function checked() {
    const t = make();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    return t;
  }

  it("records the placed issues under the box's source, with the LLM's name, and announces it", async () => {
    const t = await checked();
    // The automatic check recorded nothing.
    expect(t.recorder.recorded).toEqual([]);
    expect(t.recorder.announced).toBe(0);
    t.runner.answer(resultOf(ISSUES));
    const end = await t.session.checkManually();
    expect(end).toEqual({});
    expect(t.recorder.recorded).toEqual([
      {
        source: "session:s",
        llmName: "Fake LLM",
        mistakes: [
          {
            error_type: "verb_form",
            category: "grammar",
            snippet: "I seen",
            fingerprint: "fp-10-16",
          },
          {
            error_type: "subject_verb_agreement",
            category: "grammar",
            snippet: "He go",
            fingerprint: "fp-22-27",
          },
        ],
      },
    ]);
    expect(t.recorder.announced).toBe(1);
    // The issues are the manual check's: they get the counts of SPEC section 4.4.
    expect(t.session.state.issues.every((issue) => issue.manual)).toBe(true);
    expect(states(t.sent).at(-1)?.status).toBe("checked");
  });

  it("announces nothing when every mistake was recorded before", async () => {
    const t = await checked();
    t.recorder.inserted = 0;
    t.runner.answer(resultOf(ISSUES));
    await t.session.checkManually();
    expect(t.recorder.recorded).toHaveLength(1);
    expect(t.recorder.announced).toBe(0);
  });

  it("checks a text with fewer than 3 words, which the automatic check would not", async () => {
    const t = make("Hello there");
    t.runner.answer(resultOf([]));
    await t.session.checkManually();
    expect(t.runner.asked.map((a) => a.text)).toEqual(["Hello there"]);
  });

  it("replaces a running automatic check, which ends without touching the state", async () => {
    const t = make();
    const finishAuto = t.runner.hold();
    t.session.focus(0, TEXT);
    await settle();
    expect(t.session.state.pending?.manual).toBe(false);
    t.runner.answer(resultOf([ISSUES[0]!]));
    await t.session.checkManually();
    finishAuto(resultOf(ISSUES));
    await settle();
    expect(t.session.state.issues).toHaveLength(1);
    expect(t.recorder.recorded).toHaveLength(1);
    expect(t.recorder.recorded[0]?.mistakes).toHaveLength(1);
  });

  it("cancels: the issues and the recorded mistakes stay as they were", async () => {
    const t = await checked();
    const finish = t.runner.hold();
    const running = t.session.checkManually();
    await settle();
    expect(t.session.state.pending?.manual).toBe(true);
    t.session.cancelCheck();
    finish(resultOf([]));
    await running;
    expect(t.session.state.pending).toBeNull();
    expect(t.session.state.issues).toHaveLength(2);
    expect(t.recorder.recorded).toEqual([]);
    expect(states(t.sent).at(-1)?.status).toBe("checked");
  });

  it("does not record a check that a newer manual check replaced", async () => {
    const t = make();
    const finishFirst = t.runner.hold();
    const first = t.session.checkManually();
    await settle();
    t.runner.answer(resultOf(ISSUES));
    await t.session.checkManually();
    finishFirst(resultOf([ISSUES[0]!]));
    await first;
    expect(t.recorder.recorded).toHaveLength(1);
    expect(t.recorder.recorded[0]?.mistakes).toHaveLength(2);
  });

  it("records under the source of the box, whatever happened to the text meanwhile", async () => {
    const t = make();
    const finish = t.runner.hold();
    const running = t.session.checkManually();
    await settle();
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "Oh, " });
    finish(resultOf(ISSUES));
    await running;
    // Recorded as checked (the text sent), even though an edit moved the issues since.
    expect(t.recorder.recorded[0]?.mistakes.map((m) => m.snippet)).toEqual(["I seen", "He go"]);
  });

  it("shows the failure and records nothing when the check fails", async () => {
    const t = await checked();
    t.runner.fail(new AppError("LLMCallFailed", "The server said no"));
    await t.session.checkManually();
    expect(states(t.sent).at(-1)).toMatchObject({
      status: "failed",
      message: "The server said no",
    });
    expect(t.session.state.issues).toHaveLength(2);
    expect(t.recorder.recorded).toEqual([]);
  });

  it("says no-llm when there is none, and calls nothing", async () => {
    const t = make();
    t.settings.model = undefined;
    await t.session.checkManually();
    expect(t.runner.asked).toEqual([]);
    expect(states(t.sent).at(-1)).toMatchObject({ status: "no-llm", message: NO_LLM_MESSAGE });
  });

  it("refuses a text over 10,000 words without sending it", async () => {
    const text = Array.from({ length: 10_001 }, () => "w").join(" ");
    const t = make(text);
    const end = await t.session.checkManually();
    expect(end).toEqual({ tooLong: true });
    expect(t.runner.asked).toEqual([]);
    expect(states(t.sent).at(-1)).toMatchObject({ status: "too-long", message: TOO_LONG_MESSAGE });
  });

  it("keeps the issues and reports a failed recording, with the route of the tag", async () => {
    const t = await checked();
    t.recorder.fails = new AppError("ErrorEventSaveFailed", "The mistakes could not be saved");
    t.runner.answer(resultOf(ISSUES));
    const end = await t.session.checkManually();
    expect(end.recordError).toBeInstanceOf(AppError);
    expect(end.recordError?.hasRoute("BoxSession.record->ErrorEventSaveFailed")).toBe(true);
    expect(t.session.state.issues).toHaveLength(2);
    expect(t.recorder.announced).toBe(0);
    expect(states(t.sent).at(-1)?.status).toBe("checked");
  });

  it("wraps a recording failure that is not an AppError", async () => {
    const t = await checked();
    t.recorder.fails = new Error("disk");
    t.runner.answer(resultOf(ISSUES));
    const end = await t.session.checkManually();
    expect(end.recordError?.hasRoute("BoxSession.record->ErrorEventSaveFailed")).toBe(true);
  });

  it("sends nothing after the session is disposed", async () => {
    const t = make();
    const finish = t.runner.hold();
    const running = t.session.checkManually();
    await settle();
    t.session.dispose();
    const before = t.sent.length;
    finish(resultOf(ISSUES));
    await running;
    expect(t.sent).toHaveLength(before);
    expect(t.recorder.recorded).toEqual([]);
  });
});

describe("BoxSession: automatic checks turned off (page_mode_auto_check)", () => {
  function off() {
    const t = make();
    t.settings.autoCheck = false;
    return t;
  }

  it.each([
    {
      name: "on focus, with enough words",
      act: (t: ReturnType<typeof off>) => {
        t.session.focus(0, TEXT);
      },
    },
    {
      name: "after the typing pause",
      act: (t: ReturnType<typeof off>) => {
        t.session.focus(0, TEXT);
        t.session.edit({ revision: 1, start: TEXT.length, removed: 0, inserted: " more" });
        t.scheduler.advance(60_000);
      },
    },
    {
      name: "after several edits and a long wait",
      act: (t: ReturnType<typeof off>) => {
        t.session.focus(0, TEXT);
        for (let i = 1; i <= 3; i++) {
          t.session.edit({ revision: i, start: 0, removed: 0, inserted: "x" });
          t.scheduler.advance(10_000);
        }
      },
    },
  ])("sends no request $name", async ({ act }) => {
    const t = off();
    t.runner.answer(resultOf(ISSUES));
    act(t);
    await settle();
    expect(t.runner.asked).toEqual([]);
    const last = states(t.sent).at(-1);
    expect(last?.status).toBe("idle");
    expect(last?.message).toBe(NOT_CHECKED_MESSAGE);
    expect(NOT_CHECKED_MESSAGE).toBe("Not checked yet. Click the badge, then Check.");
  });

  it("says idle with the tooltip only while the text has no result: ticked, idle has no message", async () => {
    const t = make("one two");
    t.session.focus(0, "one two");
    await settle();
    expect(states(t.sent).at(-1)?.message).toBeUndefined();
  });

  it("the dialog's Check still works, is recorded, and later edits start no check", async () => {
    const t = off();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    expect(t.runner.asked).toEqual([]);
    await t.session.checkManually();
    expect(t.runner.asked).toHaveLength(1);
    expect(t.recorder.recorded).toHaveLength(1);
    expect(t.recorder.recorded[0]?.source).toBe("session:s");
    const last = states(t.sent).at(-1);
    expect(last?.status).toBe("checked");
    expect(last?.message).toBeUndefined();
    expect(last?.issues).toHaveLength(2);
    // Edits move the underlines as usual, and no automatic check follows.
    t.session.edit({ revision: 1, start: 0, removed: 0, inserted: "So " });
    t.scheduler.advance(60_000);
    await settle();
    expect(t.runner.asked).toHaveLength(1);
    expect(
      states(t.sent)
        .at(-1)
        ?.issues.map((i) => i.start),
    ).toEqual([13, 25]);
  });

  it("applies a change of the setting on the next focus, with no reload", async () => {
    const t = off();
    t.runner.answer(resultOf(ISSUES));
    t.session.focus(0, TEXT);
    await settle();
    expect(t.runner.asked).toEqual([]);
    t.session.blur();
    t.settings.autoCheck = true;
    t.session.focus(0, TEXT);
    await settle();
    expect(t.runner.asked).toHaveLength(1);
  });
});
