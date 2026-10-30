import { describe, expect, it } from "vitest";
import type { IssueChange } from "./state";
import { fiveIssues, FIVE_TEXT, newState, placed } from "./testing/helpers";

function recorded(state: ReturnType<typeof newState>["state"]): IssueChange[] {
  const changes: IssueChange[] = [];
  state.subscribe((change) => changes.push(change));
  return changes;
}

describe("IssueState", () => {
  it("starts empty, unchecked and at revision 0", () => {
    const { state } = newState();
    expect(state.issues).toEqual([]);
    expect(state.selectedId).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.checked).toBe(false);
    expect(state.outcome).toBe("none");
    expect(state.revision).toBe(0);
    expect(state.unplaced).toBe(0);
  });

  describe("finishCheck", () => {
    it("turns placed issues into text issues with snippets, categories and unique ids", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 2);
      expect(state.issues.map((i) => [i.snippet, i.category, i.start, i.end])).toEqual([
        ["aaaa", "grammar", 0, 4],
        ["bbbb", "grammar", 5, 9],
        ["cccc", "vocabulary", 10, 14],
        ["dddd", "vocabulary", 15, 19],
        ["eeee", "syntax", 20, 24],
      ]);
      expect(new Set(state.issues.map((i) => i.id)).size).toBe(5);
      expect(state.checked).toBe(true);
      expect(state.outcome).toBe("finished");
      expect(state.unplaced).toBe(2);
      expect(state.pending).toBeNull();
    });

    it("never reuses an id, so an old selection cannot land on a new issue", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck([placed(0, 4)], FIVE_TEXT, 0);
      const first = state.issues[0]?.id ?? 0;
      state.beginCheck(true);
      state.finishCheck([placed(0, 4)], FIVE_TEXT, 0);
      expect(state.issues[0]?.id).toBeGreaterThan(first);
    });

    it("clears the selection and tells the observers what changed", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      state.select(state.issues[1]?.id ?? 0);
      const changes = recorded(state);
      state.beginCheck(false);
      state.finishCheck([placed(0, 4)], FIVE_TEXT, 0);
      expect(state.selectedId).toBeNull();
      expect(changes).toEqual(["pending", "pending", "issues", "selection", "outcome"]);
    });
  });

  describe("pending checks", () => {
    it.each([
      { manual: true, expected: true },
      { manual: false, expected: false },
    ])("remembers whether the check is manual ($manual)", ({ manual, expected }) => {
      const { state, clock } = newState();
      clock.set(7_000);
      const pending = state.beginCheck(manual);
      expect(state.pending).toEqual({
        id: pending.id,
        revision: 0,
        manual: expected,
        startedAt: 7_000,
      });
    });

    it("snapshots the revision and replaces a pending check with a new one", () => {
      const { state } = newState();
      const first = state.beginCheck(true);
      state.bumpRevision();
      const second = state.beginCheck(false);
      expect(second.id).not.toBe(first.id);
      expect(second.revision).toBe(1);
      expect(state.pending?.id).toBe(second.id);
    });

    it.each(["cancelled", "failed"] as const)("endCheck(%s) keeps the issues", (outcome) => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      state.beginCheck(true);
      state.endCheck(outcome);
      expect(state.issues).toHaveLength(5);
      expect(state.checked).toBe(true);
      expect(state.outcome).toBe(outcome);
      expect(state.pending).toBeNull();
    });

    it("a first check that fails or is cancelled leaves the text unchecked", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.endCheck("failed");
      expect(state.checked).toBe(false);
    });
  });

  describe("selection", () => {
    function checked() {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      return state;
    }

    it("selects an issue by id and clears with null", () => {
      const state = checked();
      const changes = recorded(state);
      const id = state.issues[2]?.id ?? 0;
      state.select(id);
      expect(state.selected?.snippet).toBe("cccc");
      state.select(null);
      expect(state.selected).toBeUndefined();
      expect(changes).toEqual(["selection", "selection"]);
    });

    it("selecting an id that does not exist, or the selected issue again, changes nothing", () => {
      const state = checked();
      const changes = recorded(state);
      state.select(999);
      expect(changes).toEqual([]);
      const id = state.issues[0]?.id ?? 0;
      state.select(id);
      state.select(id);
      expect(changes).toEqual(["selection"]);
    });

    it("cannot select an issue of a hidden category", () => {
      const state = checked();
      state.setHidden("vocabulary", true);
      state.select(state.issues[2]?.id ?? 0);
      expect(state.selectedId).toBeNull();
    });
  });

  describe("categories", () => {
    function checked() {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      return state;
    }

    it.each([
      { hide: ["vocabulary"], shown: ["aaaa", "bbbb", "eeee"] },
      { hide: ["grammar", "syntax"], shown: ["cccc", "dddd"] },
      { hide: ["grammar", "vocabulary", "syntax"], shown: [] },
      { hide: [], shown: ["aaaa", "bbbb", "cccc", "dddd", "eeee"] },
    ] as const)("hiding $hide shows $shown", ({ hide, shown }) => {
      const state = checked();
      for (const category of hide) state.setHidden(category, true);
      expect(state.visibleIssues.map((i) => i.snippet)).toEqual(shown);
      expect(state.issues).toHaveLength(5);
      expect(state.hiddenCategories).toEqual(
        ["grammar", "syntax", "vocabulary"].filter((c) => (hide as readonly string[]).includes(c)),
      );
    });

    it("toggles, and tells the observers once per real change", () => {
      const state = checked();
      const changes = recorded(state);
      state.toggleCategory("syntax");
      state.setHidden("syntax", true);
      state.toggleCategory("syntax");
      expect(changes).toEqual(["visibility", "visibility"]);
      expect(state.isHidden("syntax")).toBe(false);
    });

    it("deselects an issue of the category that is hidden, and only then", () => {
      const state = checked();
      state.select(state.issues[4]?.id ?? 0);
      state.setHidden("vocabulary", true);
      expect(state.selected?.snippet).toBe("eeee");
      const changes = recorded(state);
      state.setHidden("syntax", true);
      expect(state.selectedId).toBeNull();
      expect(changes).toEqual(["visibility", "selection"]);
    });
  });

  describe("reset", () => {
    it("drops the issues, the selection and the outcome, and moves the revision on", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 3);
      state.select(state.issues[0]?.id ?? 0);
      const changes = recorded(state);
      state.reset();
      expect(state.issues).toEqual([]);
      expect(state.selectedId).toBeNull();
      expect(state.checked).toBe(false);
      expect(state.outcome).toBe("none");
      expect(state.unplaced).toBe(0);
      expect(state.revision).toBe(1);
      expect(changes).toEqual(["revision", "issues", "selection", "outcome"]);
    });

    it("tells nobody about issues when there were none", () => {
      const { state } = newState();
      const changes = recorded(state);
      state.reset();
      expect(changes).toEqual(["revision"]);
    });

    it("leaves a pending check alone", () => {
      const { state } = newState();
      const pending = state.beginCheck(true);
      state.reset();
      expect(state.pending?.id).toBe(pending.id);
    });
  });

  describe("applyEdit (SPEC section 5.5)", () => {
    function checked() {
      const made = newState();
      made.state.beginCheck(true);
      made.state.finishCheck(fiveIssues(), FIVE_TEXT, 1);
      return made.state;
    }

    it("moves the issues after the edit, drops the touched ones, and leaves the earlier ones", () => {
      const state = checked();
      const kept = state.issues[0];
      // "aaaa bbbb cccc ..." -> an insertion inside "cccc".
      state.applyEdit({ start: 12, removed: 0, added: 3 });
      expect(state.issues.map((i) => [i.snippet, i.start, i.end])).toEqual([
        ["aaaa", 0, 4],
        ["bbbb", 5, 9],
        ["dddd", 18, 22],
        ["eeee", 23, 27],
      ]);
      expect(state.issues[0]).toBe(kept);
      expect(state.revision).toBe(1);
    });

    it("keeps the snippet of a moved issue (it is what was checked)", () => {
      const state = checked();
      state.applyEdit({ start: 2, removed: 0, added: 3 }); // inside "aaaa"
      expect(state.issues.map((i) => [i.snippet, i.start])).toEqual([
        ["bbbb", 8],
        ["cccc", 13],
        ["dddd", 18],
        ["eeee", 23],
      ]);
    });

    it("tells the observers what changed", () => {
      const state = checked();
      const changes = recorded(state);
      state.applyEdit({ start: 100, removed: 0, added: 1 });
      expect(changes).toEqual(["revision"]);
      changes.length = 0;
      state.applyEdit({ start: 2, removed: 0, added: 1 });
      expect(changes).toEqual(["revision", "issues"]);
    });

    it("removes a selected issue that the edit touched, and keeps one that only moved", () => {
      const state = checked();
      state.select(state.issues[2]?.id ?? 0);
      state.applyEdit({ start: 100, removed: 0, added: 1 });
      expect(state.selected?.snippet).toBe("cccc");
      state.applyEdit({ start: 1, removed: 0, added: 2 }); // touches "aaaa" only
      expect(state.selected?.snippet).toBe("cccc");
      expect(state.selected?.start).toBe(12);
      const changes = recorded(state);
      state.applyEdit({ start: 13, removed: 1, added: 1 }); // inside the selected one
      expect(state.selectedId).toBeNull();
      expect(changes).toEqual(["revision", "issues", "selection"]);
    });

    it("goes back to not checked when no issue is left", () => {
      const made = newState();
      const { state } = made;
      state.beginCheck(true);
      state.finishCheck([placed(0, 4)], "aaaa bbbb", 2);
      const changes = recorded(state);
      state.applyEdit({ start: 2, removed: 1, added: 1 });
      expect(state.issues).toEqual([]);
      expect(state.checked).toBe(false);
      expect(state.outcome).toBe("none");
      expect(state.unplaced).toBe(0);
      expect(changes).toEqual(["revision", "issues", "outcome"]);
    });

    it("an edit of a text with no issues and a finished check ('No errors found') clears the result", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck([], "aaaa", 0);
      expect(state.checked).toBe(true);
      const changes = recorded(state);
      state.applyEdit({ start: 0, removed: 0, added: 1 });
      expect(state.checked).toBe(false);
      expect(state.outcome).toBe("none");
      expect(changes).toEqual(["revision", "issues", "outcome"]);
    });

    it("an edit of an unchecked text only counts the revision", () => {
      const { state } = newState();
      const changes = recorded(state);
      state.applyEdit({ start: 0, removed: 0, added: 1 });
      expect(changes).toEqual(["revision"]);
      expect(state.revision).toBe(1);
    });
  });

  describe("the edit log while a check runs", () => {
    it("logs edits in order, from the start of the check", () => {
      const { state } = newState();
      state.applyEdit({ start: 0, removed: 0, added: 1 }); // before the check: not logged
      state.beginCheck(true);
      expect(state.editsDuringCheck).toEqual([]);
      state.applyEdit({ start: 5, removed: 1, added: 0 });
      state.applyEdit({ start: 2, removed: 0, added: 4 });
      expect(state.editsDuringCheck).toEqual([
        { start: 5, removed: 1, added: 0 },
        { start: 2, removed: 0, added: 4 },
      ]);
    });

    it("a new check starts a new log", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.applyEdit({ start: 5, removed: 1, added: 0 });
      state.beginCheck(true);
      expect(state.editsDuringCheck).toEqual([]);
    });

    it("overflows after the limit (the default is 100,000)", () => {
      const { state } = newState();
      state.beginCheck(true);
      for (let i = 0; i < 100_000; i++) state.applyEdit({ start: 0, removed: 0, added: 1 });
      expect(state.editsDuringCheck).toHaveLength(100_000);
      state.applyEdit({ start: 0, removed: 0, added: 1 });
      expect(state.editsDuringCheck).toBeUndefined();
    });

    it.each([
      {
        name: "a loaded text",
        act: (s: ReturnType<typeof newState>["state"]) => {
          s.reset();
        },
      },
      {
        name: "a revision bump",
        act: (s: ReturnType<typeof newState>["state"]) => {
          s.bumpRevision();
        },
      },
    ])("cannot be rebased across $name", ({ act }) => {
      const { state } = newState();
      state.beginCheck(true);
      act(state);
      expect(state.editsDuringCheck).toBeUndefined();
    });

    it("finishCheck rebases the result across the edits it is given", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0, [
        { start: 0, removed: 0, added: 2 }, // touches "aaaa"
        { start: 13, removed: 1, added: 0 }, // inside "cccc" after the shift (12..16)
        { start: 30, removed: 0, added: 5 },
      ]);
      expect(state.issues.map((i) => [i.snippet, i.start, i.end])).toEqual([
        ["bbbb", 7, 11],
        ["dddd", 16, 20],
        ["eeee", 21, 25],
      ]);
    });

    it("discardCheck ends the check and leaves the old issues and outcome", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      state.beginCheck(true);
      state.discardCheck();
      expect(state.pending).toBeNull();
      expect(state.issues).toHaveLength(5);
      expect(state.outcome).toBe("finished");
    });
  });

  describe("the manual flag", () => {
    it.each([
      { manual: true, expected: [true, true] },
      { manual: false, expected: [false, false] },
    ])("issues of a check with manual=$manual carry it", ({ manual, expected }) => {
      const { state } = newState();
      state.beginCheck(manual);
      state.finishCheck([placed(0, 4), placed(5, 9)], FIVE_TEXT, 0);
      expect(state.issues.map((i) => i.manual)).toEqual(expected);
    });
  });

  describe("replaceIssues (for merging)", () => {
    it("keeps the selection when its issue is still there and drops it otherwise", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      const [a, b] = state.issues;
      state.select(b?.id ?? 0);
      state.replaceIssues([a!, b!]);
      expect(state.selected?.snippet).toBe("bbbb");
      state.replaceIssues([a!]);
      expect(state.selectedId).toBeNull();
    });
  });

  it("stops telling a listener that unsubscribed", () => {
    const { state } = newState();
    const changes: IssueChange[] = [];
    const stop = state.subscribe((c) => changes.push(c));
    state.bumpRevision();
    stop();
    state.bumpRevision();
    expect(changes).toEqual(["revision"]);
  });
});
