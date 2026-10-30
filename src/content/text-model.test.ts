// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { clearBody, setBody } from "./testing/html";
import { readEditableText } from "./text-model";

afterEach(() => {
  clearBody(document);
});

function read(html: string) {
  const host = setBody(document, `<div id="host" contenteditable="true">${html}</div>`);
  return { host, model: readEditableText(host, window) };
}

describe("the text of editable content", () => {
  it.each([
    { name: "plain text", html: "Hello world", text: "Hello world" },
    { name: "inline elements", html: "Hello <b>big</b> <i>world</i>", text: "Hello big world" },
    { name: "a <br> between lines", html: "one<br>two", text: "one\ntwo" },
    { name: "two <br> are an empty line", html: "one<br><br>two", text: "one\n\ntwo" },
    { name: "a trailing <br> only holds the line open", html: "one<br>", text: "one" },
    { name: "a trailing <br> after a <br>", html: "one<br><br>", text: "one\n" },
    { name: "a lone <br> is one empty line", html: "<br>", text: "" },
    { name: "two lone <br> are two empty lines", html: "<br><br>", text: "\n" },
    { name: "paragraphs are lines", html: "<p>one</p><p>two</p>", text: "one\ntwo" },
    { name: "divs are lines", html: "<div>one</div><div>two</div>", text: "one\ntwo" },
    { name: "text before a block", html: "one<div>two</div>three", text: "one\ntwo\nthree" },
    {
      name: "an empty block between",
      html: "<div>one</div><div><br></div><div>two</div>",
      text: "one\n\ntwo",
    },
    {
      name: "a block with a placeholder <br>",
      html: "<div>one<br></div><div>two</div>",
      text: "one\ntwo",
    },
    { name: "list items are lines", html: "<ul><li>a</li><li>b</li></ul>", text: "a\nb" },
    {
      name: "a heading and a paragraph",
      html: "<h2>Title</h2><p>Body text</p>",
      text: "Title\nBody text",
    },
    { name: "nested blocks", html: "<div><div>one</div><div>two</div></div>", text: "one\ntwo" },
    {
      name: "markup white space between blocks is not text",
      html: "<div>one</div>\n  <div>two</div>\n",
      text: "one\ntwo",
    },
    {
      name: "a space between two inline elements is text",
      html: "<b>one</b> <i>two</i>",
      text: "one two",
    },
    {
      name: "a space alone in an inline element",
      html: "<b>a</b><span> </span><i>b</i>",
      text: "a b",
    },
    {
      name: "script and style are skipped",
      html: "a<script>var x = 1</script><style>p{}</style>b",
      text: "ab",
    },
    { name: "empty text nodes", html: "", text: "" },
    { name: "emoji and accents are kept", html: "café \u{1F600}", text: "café \u{1F600}" },
  ])("$name", ({ html, text }) => {
    expect(read(html).model.text).toBe(text);
  });

  it("keeps the white space nodes of a host that preserves it, each at its own offsets", () => {
    const host = setBody(
      document,
      '<div id="host" contenteditable="true" style="white-space: pre-wrap"><div>one</div>\n<div>two</div></div>',
    );
    const model = readEditableText(host, window);
    expect(model.segments.map((s) => s.node.data)).toEqual(["one", "\n", "two"]);
    for (const { node, start, end } of model.segments) {
      expect(model.text.slice(start, end)).toBe(node.data);
    }
  });
});

describe("the mapping back to text nodes", () => {
  it("lists the text nodes with their offsets", () => {
    const { model } = read("Hello <b>big</b> world");
    expect(model.segments.map((s) => [s.node.data, s.start, s.end])).toEqual([
      ["Hello ", 0, 6],
      ["big", 6, 9],
      [" world", 9, 15],
    ]);
  });

  it.each([
    { name: "inside a node", start: 2, end: 4, text: "ll" },
    { name: "across nodes", start: 4, end: 11, text: "o big w" },
    { name: "the whole text", start: 0, end: 15, text: "Hello big world" },
    { name: "an empty range", start: 6, end: 6, text: "" },
    { name: "at a boundary", start: 6, end: 9, text: "big" },
  ])("makes a Range for $name", ({ start, end, text }) => {
    const { model } = read("Hello <b>big</b> world");
    const range = model.rangeFor(document, start, end);
    expect(range?.toString()).toBe(text);
  });

  it("starts a range in the node that continues and ends it in the node that came before", () => {
    const { model } = read("ab<b>cd</b>");
    expect(model.positionAt(2, "start")).toMatchObject({ offset: 0 });
    expect(model.positionAt(2, "start")?.node.data).toBe("cd");
    expect(model.positionAt(2, "end")?.node.data).toBe("ab");
    expect(model.positionAt(2, "end")?.offset).toBe(2);
  });

  it("puts a range across a line break between nodes", () => {
    const { model } = read("<p>one</p><p>two</p>");
    expect(model.text).toBe("one\ntwo");
    expect(model.rangeFor(document, 0, 7)?.toString()).toBe("onetwo");
    // The line break itself is held by no node: the range around it covers both lines.
    expect(model.rangeFor(document, 2, 5)?.toString()).toBe("et");
  });

  it("lands past the end on the last node's edge, and is undefined without text nodes", () => {
    const { model } = read("abc");
    expect(model.positionAt(99, "start")).toMatchObject({ offset: 3 });
    expect(model.positionAt(99, "end")).toMatchObject({ offset: 3 });
    const empty = read("");
    expect(empty.model.positionAt(0, "start")).toBeUndefined();
    expect(empty.model.rangeFor(document, 0, 0)).toBeUndefined();
  });

  it("maps every offset of the text back to the same character", () => {
    const { model } = read("ab<b>cd</b>ef<br>gh");
    for (let start = 0; start < model.text.length; start++) {
      const range = model.rangeFor(document, start, start + 1);
      const ch = model.text[start];
      // A line break has no node; every other character comes back as itself.
      expect(range?.toString()).toBe(ch === "\n" ? "" : ch);
    }
  });

  it.each([
    { name: "a text node and an offset in it", at: () => 0, offset: 3, expected: 3 },
    { name: "the start of the second node", at: () => 1, offset: 0, expected: 6 },
    { name: "inside the third node", at: () => 2, offset: 2, expected: 11 },
  ])("finds the offset of $name", ({ at, offset, expected }) => {
    const { model } = read("Hello <b>big</b> world");
    const node = model.segments[at()]?.node;
    expect(node && model.offsetOf(node, offset)).toBe(expected);
  });

  it("finds the offset of an element position (a caret between children)", () => {
    const { host, model } = read("Hello <b>big</b> world");
    expect(model.offsetOf(host, 0)).toBe(0);
    expect(model.offsetOf(host, 1)).toBe(6);
    expect(model.offsetOf(host, 2)).toBe(9);
    expect(model.offsetOf(host, 3)).toBe(15);
  });

  it("does not know a node outside the text", () => {
    const { model } = read("abc");
    const other = document.createTextNode("elsewhere");
    expect(model.offsetOf(other, 1)).toBeUndefined();
  });
});
