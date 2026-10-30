import { describe, expect, it } from "vitest";
import type { TypeCounts } from "../store/types";
import { headerLineText, IssueCounts, NOT_COUNTED_TEXT, SelectedIssueHeader } from "./counts";
import { deferred, fiveIssues, FIVE_TEXT, newState } from "./testing/helpers";

const counts = (total: number, last7 = 0, last30 = last7): TypeCounts => ({
  total,
  last7,
  last30,
});

/** A count source with fixed answers, which records what it was asked. */
class FakeSource {
  answers = new Map<string, TypeCounts>();
  readonly asked: string[] = [];
  failWith: Error | undefined;
  hold: ReturnType<typeof deferred<undefined>> | undefined;

  async countForType(type: string): Promise<TypeCounts> {
    this.asked.push(type);
    await this.hold?.promise;
    if (this.failWith !== undefined) throw this.failWith;
    return this.answers.get(type) ?? counts(0);
  }
}

function setup(manual = true) {
  const { state } = newState();
  const source = new FakeSource();
  const errors: unknown[] = [];
  const counts = new IssueCounts(state, source, (err) => errors.push(err));
  state.beginCheck(manual);
  state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
  return { state, source, counts, errors };
}

describe("headerLineText (SPEC section 4.5)", () => {
  it.each([
    {
      name: "many",
      counts: counts(7, 2),
      manual: true,
      expected: "Subject-verb agreement: you have made this mistake 7 times (2 in the last 7 days)",
    },
    {
      name: "once",
      counts: counts(1, 1),
      manual: true,
      expected: "Subject-verb agreement: you have made this mistake 1 time (1 in the last 7 days)",
    },
    {
      name: "none in the last 7 days",
      counts: counts(3, 0),
      manual: true,
      expected: "Subject-verb agreement: you have made this mistake 3 times (0 in the last 7 days)",
    },
    {
      name: "none recorded",
      counts: counts(0),
      manual: true,
      expected: "Subject-verb agreement: no mistake of this type recorded yet",
    },
    {
      name: "an auto-check issue with counts",
      counts: counts(7, 2),
      manual: false,
      expected: `Subject-verb agreement: you have made this mistake 7 times (2 in the last 7 days). ${NOT_COUNTED_TEXT}`,
    },
    {
      name: "an auto-check issue without counts",
      counts: counts(0),
      manual: false,
      expected: `Subject-verb agreement: no mistake of this type recorded yet. ${NOT_COUNTED_TEXT}`,
    },
  ])("$name", ({ counts, manual, expected }) => {
    expect(headerLineText("Subject-verb agreement", counts, manual)).toBe(expected);
  });

  it("is undefined while the counts are unknown (the panel shows the label)", () => {
    expect(headerLineText("Article", undefined, true)).toBeUndefined();
    expect(NOT_COUNTED_TEXT).toBe("This one is not counted: only the Check button counts.");
  });
});

describe("IssueCounts", () => {
  it("knows nothing before the first refresh, and so shows no badge", () => {
    const { state, counts } = setup();
    expect(state.issues.map((i) => counts.badge(i))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("refresh reads every type with an issue once, and gives a badge of the total", async () => {
    const { state, source, counts } = setup();
    source.answers.set("verb_form", counts_(7));
    source.answers.set("article", counts_(2));
    await counts.refresh();
    expect([...source.asked].sort()).toEqual([
      "article",
      "collocation",
      "spelling",
      "verb_form",
      "word_order",
    ]);
    expect(state.issues.map((i) => counts.badge(i))).toEqual([
      7,
      2,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("gives no badge for an issue of an auto-check, whatever the count", async () => {
    const { state, source, counts } = setup(false);
    source.answers.set("verb_form", counts_(7));
    await counts.refresh();
    expect(state.issues.map((i) => counts.badge(i))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(counts.get("verb_form")).toEqual(counts_(7));
  });

  it("forgets the types that have no issue any more, and zeroes after a reset", async () => {
    const { state, source, counts } = setup();
    source.answers.set("verb_form", counts_(7));
    await counts.refresh();
    state.removeIssue(1);
    await counts.refresh();
    expect(counts.get("verb_form")).toBeUndefined();
    state.beginCheck(true);
    state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
    source.answers.clear(); // the statistics were reset
    await counts.refresh();
    expect(state.issues.map((i) => counts.badge(i))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("notifies once per load", async () => {
    const { counts } = setup();
    let notified = 0;
    counts.subscribe(() => notified++);
    await counts.refresh();
    expect(notified).toBe(1);
  });

  it("reads the type of a selected issue whose counts are not known", async () => {
    const { state, source, counts } = setup(false);
    source.answers.set("article", counts_(4, 1));
    state.select(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(source.asked).toEqual(["article"]);
    expect(counts.headerLine(state.selected!)).toContain("4 times (1 in the last 7 days)");
    state.select(1);
    state.select(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(source.asked).toEqual(["article", "verb_form"]);
  });

  it("passes a failure to onError and keeps the counts it had", async () => {
    const { source, counts, errors, state } = setup();
    source.answers.set("verb_form", counts_(7));
    await counts.refresh();
    source.failWith = new Error("db");
    await counts.refresh();
    expect(errors).toHaveLength(1);
    expect(counts.badge(state.issues[0]!)).toBe(7);
  });

  it("runs loads one after another, so the latest answer wins", async () => {
    const { source, counts } = setup();
    source.answers.set("verb_form", counts_(1));
    source.hold = deferred<undefined>();
    const first = counts.refresh();
    source.answers.set("verb_form", counts_(2));
    const second = counts.refresh();
    source.hold.resolve(undefined);
    source.hold = undefined;
    await Promise.all([first, second]);
    expect(counts.get("verb_form")).toEqual(counts_(2));
  });
});

function counts_(total: number, last7 = 0): TypeCounts {
  return counts(total, last7);
}

describe("SelectedIssueHeader", () => {
  function header(manual = true) {
    const ctx = setup(manual);
    const lines: (string | undefined)[] = [];
    const view = { setHeaderLine: (text: string | undefined) => lines.push(text) };
    new SelectedIssueHeader(ctx.state, ctx.counts, view);
    return { ...ctx, lines };
  }

  it("shows the label alone until the counts arrive, then the counts text", async () => {
    const { state, source, lines } = header();
    source.answers.set("verb_form", counts_(7, 2));
    state.select(1);
    expect(lines.at(-1)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(lines.at(-1)).toBe(
      "Verb form: you have made this mistake 7 times (2 in the last 7 days)",
    );
  });

  it("clears the line when nothing is selected, and follows the selection", async () => {
    const { state, source, counts, lines } = header();
    source.answers.set("verb_form", counts_(7, 2));
    source.answers.set("article", counts_(0));
    await counts.refresh();
    state.select(2);
    expect(lines.at(-1)).toBe("Article: no mistake of this type recorded yet");
    state.select(null);
    expect(lines.at(-1)).toBeUndefined();
  });

  it("updates the line when the counts change under a selected issue (a reset in another tab)", async () => {
    const { state, source, counts, lines } = header();
    source.answers.set("verb_form", counts_(7, 2));
    await counts.refresh();
    state.select(1);
    source.answers.clear();
    await counts.refresh();
    expect(lines.at(-1)).toBe("Verb form: no mistake of this type recorded yet");
  });

  it("marks an issue of an auto-check as not counted", async () => {
    const { state, source, lines } = header(false);
    source.answers.set("verb_form", counts_(7, 2));
    state.select(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(lines.at(-1)).toBe(
      `Verb form: you have made this mistake 7 times (2 in the last 7 days). ${NOT_COUNTED_TEXT}`,
    );
  });
});
