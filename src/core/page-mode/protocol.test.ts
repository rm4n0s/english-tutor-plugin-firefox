import { describe, expect, it } from "vitest";
import {
  applyEditMessage,
  connectMessage,
  frameIdOfFragment,
  parseConnectMessage,
  parseContentMessage,
  parseFrameMessage,
} from "./protocol";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("the frame's id", () => {
  it.each([
    { name: "a UUID", value: ID, ok: true },
    { name: "a UUID in the fragment", value: `#${ID}`, ok: true },
    { name: "upper case", value: ID.toUpperCase(), ok: false },
    { name: "empty", value: "", ok: false },
    { name: "a hash only", value: "#", ok: false },
    { name: "too short", value: ID.slice(1), ok: false },
    { name: "with text around", value: `x${ID}`, ok: false },
    { name: "two hashes", value: `##${ID}`, ok: false },
    { name: "not hex", value: ID.replace("a", "g"), ok: false },
  ])("frameIdOfFragment reads $name", ({ value, ok }) => {
    expect(frameIdOfFragment(value)).toBe(ok ? ID : undefined);
  });

  it("the connect message round-trips and nothing else is one", () => {
    expect(parseConnectMessage(connectMessage(ID))).toBe(ID);
    for (const data of [
      null,
      "english-tutor-page-ui",
      { type: "english-tutor-page-ui" },
      { type: "english-tutor-page-ui", id: 5 },
      { type: "english-tutor-page-ui", id: "nope" },
      { type: "other", id: ID },
      { id: ID },
    ]) {
      expect(parseConnectMessage(data)).toBeUndefined();
    }
  });
});

describe("messages from the content script", () => {
  it.each([
    { type: "focus", box: 1, source: "session:s", revision: 0, text: "one two three" },
    { type: "focus", box: 0, source: "", revision: 9, text: "" },
    { type: "edit", box: 3, revision: 4, start: 0, removed: 2, inserted: "x" },
    { type: "edit", box: 3, revision: 4, start: 7, removed: 0, inserted: "" },
    { type: "text", box: 2, revision: 8, text: "all of it" },
    { type: "blur", box: 5 },
    { type: "forget", box: 6 },
    { type: "popover-open", box: 2, issue: 7, maxHeight: 340 },
    { type: "popover-close", box: 2 },
    { type: "dialog-open", box: 2, issue: 7 },
    { type: "dialog-open", box: 2, issue: null },
    { type: "dialog-close", box: 2 },
  ])("accepts $type $box", (message) => {
    expect(parseContentMessage(message)).toEqual(message);
  });

  it.each([
    { name: "null", data: null },
    { name: "a string", data: "focus" },
    { name: "an array", data: [] },
    { name: "no box", data: { type: "blur" } },
    { name: "a negative box", data: { type: "blur", box: -1 } },
    { name: "a fractional box", data: { type: "blur", box: 1.5 } },
    { name: "a box that is a string", data: { type: "blur", box: "1" } },
    { name: "an unsafe integer", data: { type: "blur", box: 2 ** 60 } },
    { name: "an unknown type", data: { type: "explode", box: 1 } },
    { name: "a focus without text", data: { type: "focus", box: 1, source: "s", revision: 0 } },
    { name: "a focus without source", data: { type: "focus", box: 1, revision: 0, text: "x" } },
    {
      name: "a focus with a negative revision",
      data: { type: "focus", box: 1, source: "s", revision: -1, text: "x" },
    },
    {
      name: "an edit without inserted text",
      data: { type: "edit", box: 1, revision: 1, start: 0, removed: 0 },
    },
    {
      name: "an edit with a negative start",
      data: { type: "edit", box: 1, revision: 1, start: -1, removed: 0, inserted: "" },
    },
    {
      name: "an edit with removed as a string",
      data: { type: "edit", box: 1, revision: 1, start: 0, removed: "0", inserted: "" },
    },
    { name: "a text without revision", data: { type: "text", box: 1, text: "x" } },
    { name: "a popover without an issue", data: { type: "popover-open", box: 1, maxHeight: 9 } },
    {
      name: "a popover with a negative height",
      data: { type: "popover-open", box: 1, issue: 1, maxHeight: -1 },
    },
    {
      name: "a popover whose issue is a string",
      data: { type: "popover-open", box: 1, issue: "1", maxHeight: 9 },
    },
    { name: "a dialog without a box", data: { type: "dialog-open", issue: null } },
    { name: "a dialog whose issue is a string", data: { type: "dialog-open", box: 1, issue: "1" } },
    { name: "a dialog with a negative issue", data: { type: "dialog-open", box: 1, issue: -1 } },
    { name: "a dialog close without a box", data: { type: "dialog-close" } },
  ])("refuses $name", ({ data }) => {
    expect(parseContentMessage(data)).toBeUndefined();
  });
});

describe("messages from the frame", () => {
  const issue = { id: 1, start: 0, end: 4, category: "grammar" };

  it.each([
    { type: "ready" },
    { type: "resync", box: 2 },
    { type: "popover-size", box: 2, issue: 4, height: 180 },
    { type: "popover-closed", box: 2 },
    { type: "all-issues", box: 2 },
    { type: "dialog-ready", box: 2 },
    { type: "dialog-select", box: 2, issue: 5 },
    { type: "dialog-select", box: 2, issue: null },
    { type: "dialog-closed", box: 2 },
    { type: "state", box: 1, revision: 3, status: "idle", issues: [] },
    { type: "state", box: 1, revision: 3, status: "checking", issues: [issue] },
    {
      type: "state",
      box: 1,
      revision: 3,
      status: "checked",
      issues: [issue, { ...issue, id: 2, category: "vocabulary" }],
    },
    { type: "state", box: 1, revision: 3, status: "failed", message: "It failed", issues: [] },
    { type: "state", box: 1, revision: 3, status: "no-llm", message: "No LLM", issues: [] },
    { type: "state", box: 1, revision: 3, status: "too-long", message: "Long", issues: [] },
  ])("accepts $type", (message) => {
    expect(parseFrameMessage(message)).toEqual(message);
  });

  it.each([
    { name: "null", data: null },
    { name: "an unknown type", data: { type: "boom", box: 1 } },
    { name: "a popover size without a height", data: { type: "popover-size", box: 1, issue: 1 } },
    {
      name: "a popover size with a fractional height",
      data: { type: "popover-size", box: 1, issue: 1, height: 1.5 },
    },
    { name: "a popover size without an issue", data: { type: "popover-size", box: 1, height: 9 } },
    { name: "a popover closed without a box", data: { type: "popover-closed" } },
    { name: "a dialog ready without a box", data: { type: "dialog-ready" } },
    { name: "a dialog closed without a box", data: { type: "dialog-closed" } },
    { name: "a dialog select without an issue", data: { type: "dialog-select", box: 1 } },
    { name: "a dialog select with a string", data: { type: "dialog-select", box: 1, issue: "2" } },
    {
      name: "a state without a box",
      data: { type: "state", revision: 0, status: "idle", issues: [] },
    },
    {
      name: "a state with an unknown status",
      data: { type: "state", box: 1, revision: 0, status: "sleeping", issues: [] },
    },
    {
      name: "a state with issues that are not a list",
      data: { type: "state", box: 1, revision: 0, status: "idle", issues: {} },
    },
    {
      name: "an issue that is not an object",
      data: { type: "state", box: 1, revision: 0, status: "idle", issues: [3] },
    },
    {
      name: "an issue with an unknown category",
      data: {
        type: "state",
        box: 1,
        revision: 0,
        status: "idle",
        issues: [{ ...issue, category: "style" }],
      },
    },
    {
      name: "an issue that ends before it starts",
      data: {
        type: "state",
        box: 1,
        revision: 0,
        status: "idle",
        issues: [{ ...issue, start: 5, end: 2 }],
      },
    },
    {
      name: "an issue with a negative id",
      data: { type: "state", box: 1, revision: 0, status: "idle", issues: [{ ...issue, id: -1 }] },
    },
    {
      name: "a message that is not a string",
      data: { type: "state", box: 1, revision: 0, status: "failed", message: 5, issues: [] },
    },
    {
      name: "a state without a revision",
      data: { type: "state", box: 1, status: "idle", issues: [] },
    },
  ])("refuses $name", ({ data }) => {
    expect(parseFrameMessage(data)).toBeUndefined();
  });
});

describe("applyEditMessage", () => {
  it.each([
    {
      name: "an insertion",
      text: "abc",
      edit: { start: 1, removed: 0, inserted: "X" },
      expected: "aXbc",
    },
    {
      name: "a deletion",
      text: "abc",
      edit: { start: 1, removed: 1, inserted: "" },
      expected: "ac",
    },
    {
      name: "a replacement",
      text: "abc",
      edit: { start: 0, removed: 3, inserted: "xyz!" },
      expected: "xyz!",
    },
    {
      name: "an edit at the end",
      text: "abc",
      edit: { start: 3, removed: 0, inserted: "d" },
      expected: "abcd",
    },
    {
      name: "an edit past the end",
      text: "abc",
      edit: { start: 4, removed: 0, inserted: "d" },
      expected: undefined,
    },
    {
      name: "a removal past the end",
      text: "abc",
      edit: { start: 2, removed: 2, inserted: "" },
      expected: undefined,
    },
  ])("$name", ({ text, edit, expected }) => {
    expect(applyEditMessage(text, edit)).toBe(expected);
  });
});
