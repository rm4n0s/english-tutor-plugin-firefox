import { describe, expect, it } from "vitest";
import {
  NEW_TEXT,
  parseSavedTab,
  serialiseSavedTab,
  TabText,
  tabTitle,
  type SavedTab,
} from "./tab-text";

describe("tabTitle", () => {
  it.each([
    { name: undefined, unsaved: false, expected: "Untitled – English Tutor" },
    { name: undefined, unsaved: true, expected: "Untitled* – English Tutor" },
    { name: "essay", unsaved: false, expected: "essay – English Tutor" },
    { name: "essay", unsaved: true, expected: "essay* – English Tutor" },
  ])("$name, unsaved $unsaved", ({ name, unsaved, expected }) => {
    expect(tabTitle(name, unsaved)).toBe(expected);
  });
});

describe("TabText", () => {
  it("starts as an empty, saved, nameless text", () => {
    const t = new TabText();
    expect([t.name, t.documentId, t.lineEnding, t.dirty, t.unsaved, t.title]).toEqual([
      undefined,
      undefined,
      "lf",
      false,
      false,
      "Untitled – English Tutor",
    ]);
  });

  type Step = (t: TabText) => void;
  it.each<{ name: string; steps: Step[]; unsaved: boolean; dirty: boolean; title: string }>([
    {
      name: "an edit",
      steps: [(t) => t.edited("Hello")],
      unsaved: true,
      dirty: true,
      title: "Untitled* – English Tutor",
    },
    {
      name: "an edit to white space only",
      steps: [(t) => t.edited("  \n ")],
      unsaved: false,
      dirty: true,
      title: "Untitled – English Tutor",
    },
    {
      name: "an edit, then a save",
      steps: [(t) => t.edited("Hello"), (t) => t.saved()],
      unsaved: false,
      dirty: false,
      title: "Untitled – English Tutor",
    },
    {
      name: "a loaded text",
      steps: [
        (t) => t.loaded({ name: "essay", documentId: undefined, lineEnding: "crlf" }, "Hello"),
      ],
      unsaved: false,
      dirty: false,
      title: "essay – English Tutor",
    },
    {
      name: "a loaded text, then an edit",
      steps: [
        (t) => t.loaded({ name: "essay", documentId: 3, lineEnding: "lf" }, "Hello"),
        (t) => t.edited("Hello!"),
      ],
      unsaved: true,
      dirty: true,
      title: "essay* – English Tutor",
    },
    {
      name: "an edit, then a new text",
      steps: [(t) => t.edited("Hello"), (t) => t.loaded(NEW_TEXT, "")],
      unsaved: false,
      dirty: false,
      title: "Untitled – English Tutor",
    },
    {
      name: "an edit that empties the text",
      steps: [(t) => t.edited("Hello"), (t) => t.edited("")],
      unsaved: false,
      dirty: true,
      title: "Untitled – English Tutor",
    },
    {
      name: "a restored dirty text",
      steps: [
        (t) => t.loaded({ name: undefined, documentId: undefined, lineEnding: "lf" }, "x", true),
      ],
      unsaved: true,
      dirty: true,
      title: "Untitled* – English Tutor",
    },
    {
      name: "a rename of a dirty text",
      steps: [(t) => t.edited("Hello"), (t) => t.rename("renamed")],
      unsaved: true,
      dirty: true,
      title: "renamed* – English Tutor",
    },
  ])("$name", ({ steps, unsaved, dirty, title }) => {
    const t = new TabText();
    for (const step of steps) step(t);
    expect([t.unsaved, t.dirty, t.title]).toEqual([unsaved, dirty, title]);
  });

  it("attaches to a document and detaches, keeping the name", () => {
    const t = new TabText();
    t.attach(5, "My title");
    expect([t.documentId, t.name]).toEqual([5, "My title"]);
    t.detach();
    expect([t.documentId, t.name]).toEqual([undefined, "My title"]);
  });

  it("tells listeners about every change until they unsubscribe", () => {
    const t = new TabText();
    let calls = 0;
    const stop = t.subscribe(() => calls++);
    t.edited("a");
    t.saved();
    t.rename("x");
    t.attach(1, "y");
    t.detach();
    t.loaded(NEW_TEXT, "");
    expect(calls).toBe(6);
    stop();
    t.edited("b");
    expect(calls).toBe(6);
  });
});

const SAVED: SavedTab = {
  text: "Hello\nthere",
  source: "session:123e4567-e89b-42d3-a456-426614174000",
  name: "essay",
  documentId: undefined,
  lineEnding: "crlf",
  dirty: true,
};

describe("the saved tab", () => {
  it.each<{ name: string; tab: SavedTab }>([
    { name: "a new text", tab: { ...SAVED, name: undefined } },
    { name: "a named text", tab: SAVED },
    { name: "a library text", tab: { ...SAVED, source: "doc:12", documentId: 12, dirty: false } },
    { name: "a detached library text", tab: { ...SAVED, source: "doc:4", dirty: false } },
    { name: "an empty text", tab: { ...SAVED, text: "" } },
    { name: "emoji and quotes", tab: { ...SAVED, text: 'say "😀"\n\\  ' } },
  ])("round-trips $name", ({ tab }) => {
    expect(parseSavedTab(serialiseSavedTab(tab))).toEqual(tab);
  });

  const good = JSON.parse(serialiseSavedTab(SAVED)) as Record<string, unknown>;
  const withField = (field: string, value: unknown): string =>
    JSON.stringify({ ...good, [field]: value });
  it.each([
    { name: "nothing stored", raw: null },
    { name: "undefined", raw: undefined },
    { name: "an empty string", raw: "" },
    { name: "broken JSON", raw: "{" },
    { name: "a number", raw: "5" },
    { name: "null", raw: "null" },
    { name: "an array", raw: "[]" },
    { name: "another version", raw: withField("v", 2) },
    { name: "a text that is not a string", raw: withField("text", 5) },
    { name: "a missing text", raw: withField("text", undefined) },
    { name: "a source that is not a string", raw: withField("source", 1) },
    { name: "an unknown source", raw: withField("source", "file:/etc/passwd") },
    { name: "an empty session source", raw: withField("source", "session:") },
    { name: "a document source with a bad id", raw: withField("source", "doc:abc") },
    { name: "a document source with id 0", raw: withField("source", "doc:0") },
    { name: "a dirty flag that is not a boolean", raw: withField("dirty", "yes") },
    { name: "a name that is a number", raw: withField("name", 3) },
    { name: "an unknown line ending", raw: withField("lineEnding", "cr") },
    { name: "a document id of 0", raw: withField("documentId", 0) },
    { name: "a fractional document id", raw: withField("documentId", 1.5) },
    { name: "a document id that is a string", raw: withField("documentId", "3") },
  ])("gives nothing for $name", ({ raw }) => {
    expect(parseSavedTab(raw)).toBeUndefined();
  });

  it("treats an empty stored name as no name", () => {
    expect(parseSavedTab(withField("name", ""))?.name).toBeUndefined();
  });
});
