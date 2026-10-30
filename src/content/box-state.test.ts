// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { WireIssue } from "../core/page-mode/protocol";
import { BoxState } from "./box-state";
import { clearBody, setBody } from "./testing/html";

afterEach(() => {
  clearBody(document);
});

const issue = (
  id: number,
  start: number,
  end: number,
  category: WireIssue["category"] = "grammar",
) => ({ id, start, end, category }) satisfies WireIssue;

function textarea(value: string) {
  const element = setBody(document, "<textarea></textarea>") as HTMLTextAreaElement;
  element.value = value;
  return { element, state: new BoxState(1, element, "textarea", "session:s", window) };
}

describe("BoxState: the text of a box and its edits", () => {
  it("reads the text when it is made, at revision 0, with its source", () => {
    const { state } = textarea("He go to school");
    expect(state.text).toBe("He go to school");
    expect(state.revision).toBe(0);
    expect(state.source).toBe("session:s");
    expect(state.status).toBe("idle");
    expect(state.issues).toEqual([]);
  });

  it("reads an input's value", () => {
    const element = setBody(document, '<input type="text">') as HTMLInputElement;
    element.value = "one two three";
    expect(new BoxState(1, element, "input", "session:s", window).text).toBe("one two three");
  });

  it("reads editable content as lines of its text nodes, and keeps the mapping", () => {
    const element = setBody(document, '<div contenteditable="true"><p>one</p><p>two</p></div>');
    const state = new BoxState(1, element, "editable", "session:s", window);
    expect(state.text).toBe("one\ntwo");
    expect(state.model?.segments.map((s) => s.node.data)).toEqual(["one", "two"]);
  });

  it.each([
    {
      name: "typing at the end",
      before: "He go",
      after: "He go.",
      edit: { start: 5, removed: 0, added: 1 },
      inserted: ".",
    },
    {
      name: "typing at the start",
      before: "He go",
      after: "Oh. He go",
      edit: { start: 0, removed: 0, added: 4 },
      inserted: "Oh. ",
    },
    {
      name: "deleting a word",
      before: "He go home",
      after: "He home",
      edit: { start: 3, removed: 3, added: 0 },
      inserted: "",
    },
    {
      name: "replacing a word",
      before: "He go home",
      after: "He goes home",
      edit: { start: 5, removed: 0, added: 2 },
      inserted: "es",
    },
    {
      name: "replacing everything",
      before: "abc",
      after: "xyz",
      edit: { start: 0, removed: 3, added: 3 },
      inserted: "xyz",
    },
    {
      name: "pasting an emoji",
      before: "a b",
      after: "a \u{1F600} b",
      edit: { start: 2, removed: 0, added: 3 },
      inserted: "\u{1F600} ",
    },
  ])("finds the edit of $name", ({ before, after, edit, inserted }) => {
    const { element, state } = textarea(before);
    element.value = after;
    const found = state.sync();
    expect(found).toEqual({ edit, inserted });
    expect(state.text).toBe(after);
    expect(state.revision).toBe(1);
  });

  it("finds nothing when the text is the same, and keeps the revision", () => {
    const { state } = textarea("same");
    expect(state.sync()).toBeUndefined();
    expect(state.revision).toBe(0);
  });

  it("counts every edit", () => {
    const { element, state } = textarea("a");
    for (const [i, value] of ["ab", "abc", "ab", "a"].entries()) {
      element.value = value;
      state.sync();
      expect(state.revision).toBe(i + 1);
    }
  });

  it("finds the edits of editable content", () => {
    const element = setBody(document, '<div contenteditable="true">He go home</div>');
    const state = new BoxState(1, element, "editable", "session:s", window);
    const text = element.firstChild as Text;
    text.data = "He goes home";
    expect(state.sync()).toEqual({ edit: { start: 5, removed: 0, added: 2 }, inserted: "es" });
    expect(state.model?.text).toBe("He goes home");
  });
});

describe("BoxState: what the frame says", () => {
  it("takes the state of the current revision", () => {
    const { state } = textarea("He go");
    const issues = [issue(1, 0, 5)];
    expect(state.apply({ revision: 0, status: "checked", issues })).toBe(true);
    expect(state.status).toBe("checked");
    expect(state.issues).toEqual(issues);
    expect(state.message).toBeUndefined();
  });

  it("keeps the message of a failure", () => {
    const { state } = textarea("He go");
    state.apply({ revision: 0, status: "failed", message: "The request failed", issues: [] });
    expect(state.message).toBe("The request failed");
  });

  it("drops a state for another revision and changes nothing", () => {
    const { element, state } = textarea("He go");
    element.value = "He goes";
    state.sync();
    expect(state.apply({ revision: 0, status: "checked", issues: [issue(1, 0, 5)] })).toBe(false);
    expect(state.status).toBe("idle");
    expect(state.issues).toEqual([]);
  });
});

describe("BoxState: edits move and remove issues at once (SPEC section 5.5)", () => {
  const text = "Yesterday I seen him. He go home.";
  const seen = issue(1, 10, 16);
  const go = issue(2, 22, 27);

  function checked(value = text) {
    const box = textarea(value);
    box.state.apply({ revision: 0, status: "checked", issues: [seen, go] });
    return box;
  }

  it.each([
    {
      name: "an edit before both moves them",
      at: 0,
      remove: 0,
      add: "Oh! ",
      expected: [
        { ...seen, start: 14, end: 20 },
        { ...go, start: 26, end: 31 },
      ],
    },
    {
      name: "an edit between them moves the later one",
      at: 17,
      remove: 0,
      add: "!",
      expected: [seen, { ...go, start: 23, end: 28 }],
    },
    {
      name: "an edit touching the first removes it",
      at: 12,
      remove: 1,
      add: "",
      expected: [{ ...go, start: 21, end: 26 }],
    },
    {
      name: "typing right after a word removes it",
      at: 16,
      remove: 0,
      add: "x",
      expected: [{ ...go, start: 23, end: 28 }],
    },
    { name: "an edit after both leaves them", at: 33, remove: 0, add: "!", expected: [seen, go] },
  ])("$name", ({ at, remove, add, expected }) => {
    const { element, state } = checked();
    element.value = element.value.slice(0, at) + add + element.value.slice(at + remove);
    state.sync();
    expect(state.issues).toEqual(expected);
  });

  it("goes back to idle when an edit leaves no issue after a finished check", () => {
    const { element, state } = checked();
    element.value = "Totally new text, but long enough";
    state.sync();
    expect(state.issues).toEqual([]);
    expect(state.status).toBe("idle");
  });

  it("keeps a failure's status when there are no issues, and a finished check that found none", () => {
    const { element, state } = textarea("one two three");
    state.apply({ revision: 0, status: "failed", message: "m", issues: [] });
    element.value = "one two three four";
    state.sync();
    expect(state.status).toBe("failed");
  });
});
