// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Prng } from "../analysis/testing/prng";
import { renderMarkdown } from "./render";
import { violations } from "./testing";

/** Pieces that make a renderer stumble: markdown syntax, HTML, schemes and odd characters. */
const PIECES = [
  "*",
  "**",
  "_",
  "__",
  "`",
  "``",
  "```",
  "~~~",
  "#",
  "##",
  "######",
  "#######",
  ">",
  "> ",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "2) ",
  "[",
  "]",
  "(",
  ")",
  "![",
  "](",
  "\\",
  "\\*",
  "\n",
  "\n\n",
  "\r\n",
  "  \n",
  "    ",
  "\t",
  " ",
  "  ",
  "<",
  ">",
  "</",
  "/>",
  "<script>",
  "</script>",
  "<img src=x onerror=alert(1)>",
  '<a href="x">',
  "<b>",
  "<iframe>",
  "<!--",
  "-->",
  "&amp;",
  "&#60;",
  "&lt;script&gt;",
  '"',
  "'",
  "=",
  "onclick=",
  "http://",
  "https://",
  "https://example.com",
  "http://a.b/c?d=e&f=g",
  "javascript:",
  "JaVaScRiPt:alert(1)",
  "data:text/html,",
  "file:///etc/passwd",
  "//evil.example",
  "mailto:a@b.c",
  "user:pw@",
  "[x](https://example.com)",
  "[x](javascript:alert(1))",
  "![a](http://i.example/i.png)",
  "[<b>](https://x.example)",
  "\u0000",
  "\u0001",
  "\u202e",
  "\ud83d",
  "\ude00",
  "é",
  "日本語",
  "emoji 😀",
  "a",
  "word",
  "He go",
  "snake_case",
  "x_y",
  "2 * 3",
];

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i);

function randomMarkdown(prng: Prng): string {
  const count = prng.int(60);
  let out = "";
  for (let i = 0; i < count; i++) {
    out += prng.pick(PIECES);
    // Sometimes any printable character, so that no list of pieces is the limit.
    if (prng.int(6) === 0) out += String.fromCharCode(prng.int(0x2fff));
  }
  return out;
}

describe("renderMarkdown: randomised input", () => {
  it.each(SEEDS)(
    "seed %i: only allowed elements and attributes appear, and nothing throws",
    (seed) => {
      const prng = new Prng(seed);
      for (let n = 0; n < 150; n++) {
        const markdown = randomMarkdown(prng);
        let rendered: DocumentFragment | undefined;
        try {
          rendered = renderMarkdown(document, markdown);
        } catch (err) {
          throw new Error(`threw on ${JSON.stringify(markdown)}: ${String(err)}`, { cause: err });
        }
        expect(violations(rendered), JSON.stringify(markdown)).toEqual([]);
      }
    },
  );

  it.each(SEEDS)("seed %i: arbitrary characters never make an element", (seed) => {
    const prng = new Prng(seed);
    for (let n = 0; n < 60; n++) {
      let markdown = "";
      for (let i = prng.int(200); i > 0; i--) markdown += String.fromCharCode(prng.int(0x10000));
      const rendered = renderMarkdown(document, markdown);
      expect(violations(rendered), JSON.stringify(markdown)).toEqual([]);
    }
  });

  it("keeps every piece of text: nothing but syntax characters is lost", () => {
    const prng = new Prng(7);
    for (let n = 0; n < 200; n++) {
      // Words and spaces only: the text content has the same words.
      const words = Array.from({ length: 1 + prng.int(12) }, () =>
        prng.pick(["He", "go", "to", "school", "<b>", "&amp;"]),
      );
      const rendered = renderMarkdown(document, words.join(" "));
      expect(rendered.textContent).toBe(words.join(" "));
    }
  });
});
