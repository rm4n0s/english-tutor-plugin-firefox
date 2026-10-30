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

  describe("finishCheck with a selection (the merge of SPEC section 5.1)", () => {
    // "aaaa bbbb cccc dddd eeee": the selection 5..14 holds the 2nd and 3rd issue.
    function merged(selection: { start: number; end: number }, found: ReturnType<typeof placed>[]) {
      const { state } = newState();
      const full = state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 3);
      const before = [...state.issues];
      const part = state.beginCheck(true);
      state.finishCheck(found, FIVE_TEXT, 1, [], selection);
      return { state, before, full, part };
    }

    it("replaces the issues that overlap the selection and keeps all others as they were", () => {
      const { state, before } = merged({ start: 5, end: 14 }, [placed(6, 8, "article")]);
      expect(state.issues.map((i) => [i.start, i.end])).toEqual([
        [0, 4],
        [6, 8],
        [15, 19],
        [20, 24],
      ]);
      // The kept ones are the very same issues (ids included).
      expect(state.issues[0]).toBe(before[0]);
      expect(state.issues[2]).toBe(before[3]);
      expect(state.issues[3]).toBe(before[4]);
      expect(before.map((i) => i.id)).not.toContain(state.issues[1]?.id);
    });

    it.each([
      { name: "touching before is not overlapping", selection: { start: 4, end: 5 }, kept: 5 },
      { name: "one unit inside the first issue", selection: { start: 3, end: 6 }, kept: 3 },
      { name: "a selection of a gap", selection: { start: 14, end: 15 }, kept: 5 },
      { name: "everything", selection: { start: 0, end: 24 }, kept: 0 },
    ])("$name", ({ selection, kept }) => {
      const { state } = merged(selection, []);
      expect(state.issues).toHaveLength(kept);
    });

    it("sorts the new issues in among the kept ones, and sets the selection's not-placed count", () => {
      const { state } = merged({ start: 5, end: 14 }, [placed(10, 13, "article"), placed(5, 8)]);
      expect(state.issues.map((i) => i.start)).toEqual([0, 5, 10, 15, 20]);
      expect(state.unplaced).toBe(1);
      expect(state.outcome).toBe("finished");
      expect(state.checked).toBe(true);
    });

    it("keeps the selected issue outside the selection without telling the observers", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      const first = state.issues[0]?.id ?? 0;
      state.select(first);
      state.beginCheck(true);
      const changes = recorded(state);
      state.finishCheck([], FIVE_TEXT, 0, [], { start: 5, end: 14 });
      expect(state.selectedId).toBe(first);
      expect(changes).not.toContain("selection");
    });

    it("clears the selection when the selected issue is replaced", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      state.select(state.issues[1]?.id ?? 0);
      state.beginCheck(true);
      const changes = recorded(state);
      state.finishCheck([], FIVE_TEXT, 0, [], { start: 5, end: 14 });
      expect(state.selectedId).toBeNull();
      expect(changes).toContain("selection");
    });

    it("keeps checkId of the earlier result, so the cached explanations stay valid", () => {
      const { state, full } = merged({ start: 5, end: 14 }, [placed(6, 8, "article")]);
      expect(state.checkId).toBe(full.id);
    });

    it("takes its own check id when there was no result before", () => {
      const { state } = newState();
      const part = state.beginCheck(true);
      state.finishCheck([placed(0, 4)], FIVE_TEXT, 0, [], { start: 0, end: 4 });
      expect(state.checkId).toBe(part.id);
      expect(state.issues).toHaveLength(1);
    });

    it("moves the selection across the edits made during the check", () => {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      state.beginCheck(true);
      // "XX" typed at the start touches the first issue (it goes); the others shift by 2, and so
      // does the selection.
      const edit = { start: 0, removed: 0, added: 2 };
      state.applyEdit(edit);
      state.finishCheck([placed(5, 8, "article")], FIVE_TEXT, 0, [edit], { start: 5, end: 14 });
      expect(state.issues.map((i) => [i.start, i.end])).toEqual([
        [7, 10],
        [17, 21],
        [22, 26],
      ]);
    });

    it("marks the new issues manual and leaves the kept ones' flag", () => {
      const { state } = newState();
      state.beginCheck(false);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      state.beginCheck(true);
      state.finishCheck([placed(6, 8, "article")], FIVE_TEXT, 0, [], { start: 5, end: 14 });
      expect(state.issues.map((i) => i.manual)).toEqual([false, true, false, false]);
    });
  });

  describe("checkId", () => {
    it("is 0 before a result, the id of the check that produced the issues after one", () => {
      const { state } = newState();
      expect(state.checkId).toBe(0);
      const first = state.beginCheck(true);
      expect(state.checkId).toBe(0);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      expect(state.checkId).toBe(first.id);
      const second = state.beginCheck(false);
      expect(state.checkId).toBe(first.id); // the old result stays until the new one arrives
      state.endCheck("cancelled");
      expect(state.checkId).toBe(first.id);
      state.beginCheck(false);
      state.finishCheck([], FIVE_TEXT, 0);
      expect(state.checkId).toBeGreaterThan(second.id);
    });

    it("does not change with edits, and goes back to 0 for a loaded text", () => {
      const { state } = newState();
      const check = state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
      state.applyEdit({ start: 0, removed: 0, added: 1 });
      expect(state.checkId).toBe(check.id);
      state.reset();
      expect(state.checkId).toBe(0);
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

  describe("removeIssue (Not an error)", () => {
    function checked() {
      const { state } = newState();
      state.beginCheck(true);
      state.finishCheck(fiveIssues(), FIVE_TEXT, 1);
      return state;
    }

    it("removes one issue at once and keeps the others, the result and the revision", () => {
      const state = checked();
      const revision = state.revision;
      const changes = recorded(state);
      expect(state.removeIssue(2)).toBe(true);
      expect(state.issues.map((i) => i.id)).toEqual([1, 3, 4, 5]);
      expect(changes).toEqual(["issues"]);
      expect(state.revision).toBe(revision);
      expect(state.checked).toBe(true);
      expect(state.outcome).toBe("finished");
      expect(state.unplaced).toBe(1);
    });

    it("deselects the removed issue, and only then", () => {
      const state = checked();
      state.select(3);
      const changes = recorded(state);
      state.removeIssue(1);
      expect(state.selectedId).toBe(3);
      expect(changes).toEqual(["issues"]);
      changes.length = 0;
      state.removeIssue(3);
      expect(state.selectedId).toBeNull();
      expect(changes).toEqual(["issues", "selection"]);
    });

    it("says no and tells nobody for an id that is not there", () => {
      const state = checked();
      const changes = recorded(state);
      expect(state.removeIssue(99)).toBe(false);
      expect(changes).toEqual([]);
    });

    it("removes an issue of a hidden category too", () => {
      const state = checked();
      state.setHidden("vocabulary", true);
      expect(state.removeIssue(3)).toBe(true);
      expect(state.issues.map((i) => i.id)).toEqual([1, 2, 4, 5]);
    });
  });
});
