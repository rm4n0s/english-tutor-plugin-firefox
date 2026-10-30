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

  describe("replaceIssues (for rebasing and merging)", () => {
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
