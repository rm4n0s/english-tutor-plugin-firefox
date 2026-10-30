// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render";
import { serialize, violations } from "./testing";

const render = (markdown: string): string => serialize(renderMarkdown(document, markdown));
const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer nofollow"';

describe("renderMarkdown: constructs", () => {
  it.each([
    ["empty", "", ""],
    ["only blank lines", "\n  \n\n", ""],
    ["paragraph", "Hello world.", "<p>Hello world.</p>"],
    ["two paragraphs", "One.\n\nTwo.", "<p>One.</p><p>Two.</p>"],
    ["a soft break joins the lines", "one\ntwo", "<p>one two</p>"],
    ["CRLF and CR are line breaks", "one\r\n\r\ntwo\rthree", "<p>one</p><p>two three</p>"],
    ["a hard break with two spaces", "one  \ntwo", "<p>one<br>two</p>"],
    ["a hard break with a backslash", "one\\\ntwo", "<p>one<br>two</p>"],
    ["a backslash at the very end stays", "one\\", "<p>one\\</p>"],
    ["bold", "a **bold** word", "<p>a <strong>bold</strong> word</p>"],
    ["bold with underscores", "a __bold__ word", "<p>a <strong>bold</strong> word</p>"],
    ["italic with a star", "an *italic* word", "<p>an <em>italic</em> word</p>"],
    ["italic with an underscore", "an _italic_ word", "<p>an <em>italic</em> word</p>"],
    ["snake_case is not italic", "use snake_case_name here", "<p>use snake_case_name here</p>"],
    [
      "an underscore after a non-ASCII letter is in a word",
      "naïve_word_here",
      "<p>naïve_word_here</p>",
    ],
    ["an underscore after an emoji can open italic", "😀_x_", "<p>😀<em>x</em></p>"],
    ["a star between spaces is text", "2 * 3 * 4", "<p>2 * 3 * 4</p>"],
    [
      "nested emphasis",
      "**bold and *italic***",
      "<p><strong>bold and <em>italic</em></strong></p>",
    ],
    ["inline code", "say `goes` here", "<p>say <code>goes</code> here</p>"],
    ["double backtick code", "``a ` b``", "<p><code>a ` b</code></p>"],
    ["code keeps markers literal", "`**x**`", "<p><code>**x**</code></p>"],
    ["an unmatched backtick stays", "a ` b", "<p>a ` b</p>"],
    ["unmatched bold stays", "a ** b", "<p>a ** b</p>"],
    ["unmatched italic stays", "a *b", "<p>a *b</p>"],
    ["an escaped marker", String.raw`2 \* 3 \*`, "<p>2 * 3 *</p>"],
    ["a backslash before a letter stays", String.raw`C:\dir`, String.raw`<p>C:\dir</p>`],
    ["heading 1 is an h3", "# What is wrong", "<h3>What is wrong</h3>"],
    ["heading 3 is an h5", "### Why", "<h5>Why</h5>"],
    ["a deep heading is capped at h6", "###### Tiny", "<h6>Tiny</h6>"],
    ["a closing sequence is dropped", "## Title ##", "<h4>Title</h4>"],
    ["a trailing # in a word stays", "# Learn C#", "<h3>Learn C#</h3>"],
    ["a heading takes inline markup", "## The **rule**", "<h4>The <strong>rule</strong></h4>"],
    ["seven hashes are text", "####### x", "<p>####### x</p>"],
    ["a # without a space is text", "#hashtag", "<p>#hashtag</p>"],
    ["a heading ends a paragraph", "text\n# Head\nmore", "<p>text</p><h3>Head</h3><p>more</p>"],
    ["unordered list", "- one\n- two", "<ul><li>one</li><li>two</li></ul>"],
    ["list with stars and pluses", "* one\n+ two", "<ul><li>one</li><li>two</li></ul>"],
    ["ordered list", "1. one\n2. two", "<ol><li>one</li><li>two</li></ol>"],
    ["ordered list with parentheses", "1) one\n2) two", "<ol><li>one</li><li>two</li></ol>"],
    ["a list item continues", "- one\n  more\n- two", "<ul><li>one more</li><li>two</li></ul>"],
    [
      "items take inline markup",
      "- **a** and `b`",
      "<ul><li><strong>a</strong> and <code>b</code></li></ul>",
    ],
    ["a blank line inside a list", "1. a\n\n2. b", "<ol><li>a</li><li>b</li></ol>"],
    ["a different kind starts a new list", "- a\n1. b", "<ul><li>a</li></ul><ol><li>b</li></ol>"],
    ["a list after a blank line and a paragraph", "- a\n\ntext", "<ul><li>a</li></ul><p>text</p>"],
    ["a list interrupts a paragraph", "text\n- a", "<p>text</p><ul><li>a</li></ul>"],
    ["a dash alone is text", "-", "<p>-</p>"],
    ["a thematic break is plain text", "---", "<p>---</p>"],
    ["block quote", "> be kind", "<blockquote><p>be kind</p></blockquote>"],
    ["block quote over lines", "> a\n> b", "<blockquote><p>a b</p></blockquote>"],
    [
      "nested block quote",
      "> > deep",
      "<blockquote><blockquote><p>deep</p></blockquote></blockquote>",
    ],
    [
      "block quote with a list",
      "> - a\n> - b",
      "<blockquote><ul><li>a</li><li>b</li></ul></blockquote>",
    ],
    ["fenced code", "```\nHe go\n```", "<pre><code>He go</code></pre>"],
    [
      "fenced code keeps lines and markup",
      "```js\na\n  **b**\n\nc\n```",
      "<pre><code>a\n  **b**\n\nc</code></pre>",
    ],
    [
      "an unclosed fence runs to the end",
      "```\nHe go\nmore",
      "<pre><code>He go\nmore</code></pre>",
    ],
    ["text after a fence", "```\nx\n```\nafter", "<pre><code>x</code></pre><p>after</p>"],
    ["indented code", "    a\n      b\n\n    c", "<pre><code>a\n  b\n\nc</code></pre>"],
    ["a tab-indented code line", "\tx", "<pre><code>x</code></pre>"],
    ["an indented line after a paragraph continues it", "text\n    more", "<p>text more</p>"],
  ])("%s", (_name, markdown, expected) => {
    expect(render(markdown)).toBe(expected);
  });
});

describe("renderMarkdown: links", () => {
  it.each([
    [
      "an https link",
      "[docs](https://example.com/a?b=1&c=2)",
      `<p><a href="https://example.com/a?b=1&amp;c=2" ${LINK_ATTRS}>docs</a></p>`,
    ],
    [
      "an http link",
      "see [the rule](http://example.com/rule) now",
      `<p>see <a href="http://example.com/rule" ${LINK_ATTRS}>the rule</a> now</p>`,
    ],
    [
      "an address is normalised",
      "[x](HTTPS://Example.COM)",
      `<p><a href="https://example.com/" ${LINK_ATTRS}>x</a></p>`,
    ],
    [
      "empty text shows the address",
      "[](https://example.com)",
      `<p><a href="https://example.com/" ${LINK_ATTRS}>https://example.com/</a></p>`,
    ],
    [
      "a title after the address is dropped",
      '[x](https://example.com "the title")',
      `<p><a href="https://example.com/" ${LINK_ATTRS}>x</a></p>`,
    ],
    [
      "markup in the text",
      "[**bold** link](https://example.com)",
      `<p><a href="https://example.com/" ${LINK_ATTRS}><strong>bold</strong> link</a></p>`,
    ],
    [
      "parentheses inside the address",
      "[x](https://example.com/a_(b))",
      `<p><a href="https://example.com/a_(b)" ${LINK_ATTRS}>x</a></p>`,
    ],
    [
      "a quote in the address cannot leave the attribute",
      '[a](https://x.example/"onmouseover="alert(1))',
      `<p><a href="https://x.example/%22onmouseover=%22alert(1)" ${LINK_ATTRS}>a</a></p>`,
    ],
    [
      "a link inside a link text is only text",
      "[a [b](https://inner.example)](https://outer.example)",
      `<p><a href="https://outer.example/" ${LINK_ATTRS}>a b</a></p>`,
    ],
    ["an incomplete link is text", "[a](https://example.com", "<p>[a](https://example.com</p>"],
    ["brackets alone are text", "[a] and [b]", "<p>[a] and [b]</p>"],
  ])("%s", (_name, markdown, expected) => {
    expect(render(markdown)).toBe(expected);
  });

  it.each([
    ["javascript", "[click](javascript:alert(1))", "click"],
    ["javascript in capitals", "[click](JaVaScRiPt:alert(1))", "click"],
    ["data", "[click](data:text/html;base64,PHNjcmlwdD4=)", "click"],
    ["file", "[click](file:///etc/passwd)", "click"],
    ["a protocol-relative address", "[click](//evil.example/x)", "click"],
    ["a relative address", "[click](/relative)", "click"],
    ["a bare word", "[click](preferences:)", "click"],
    ["mailto", "[click](mailto:a@b.example)", "click"],
    ["ftp", "[click](ftp://example.com/f)", "click"],
    ["no host", "[click](https://)", "click"],
    ["no host but a path", "[click](http:///path)", "click"],
    ["a user name and password", "[click](https://user:pw@example.com)", "click"],
    ["a user name only", "[click](https://paypal.com@evil.example)", "click"],
    ["a scheme without slashes", "[click](http:example.com)", "click"],
    ["a control character", "[click](https://exa\u0001mple.com)", "click"],
    ["an empty address", "[click]()", "click"],
    ["a very long address", `[click](https://example.com/${"a".repeat(3000)})`, "click"],
  ])("refuses %s: only the text stays", (_name, markdown, text) => {
    expect(render(markdown)).toBe(`<p>${text}</p>`);
  });

  it.each([
    ["an image", "![a cat](http://evil.example/track.png)", "<p>a cat</p>"],
    ["an image with a bad address", "![x](javascript:alert(1))", "<p>x</p>"],
    ["an image in a link", "[![alt](http://i.example/i.png)](https://example.com)", ""],
    ["a lone bang", "Wow! [not a link", "<p>Wow! [not a link</p>"],
  ])("%s becomes its alt text and is never fetched", (_name, markdown, expected) => {
    const rendered = renderMarkdown(document, markdown);
    expect(rendered.querySelector("img")).toBeNull();
    if (expected !== "") expect(serialize(rendered)).toBe(expected);
  });
});

describe("renderMarkdown: raw HTML is text", () => {
  it.each([
    ["a script", "<script>alert(1)</script>", "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"],
    ["an image tag", "<img src=x onerror=alert(1)>", "<p>&lt;img src=x onerror=alert(1)&gt;</p>"],
    ["an ampersand entity", "a &amp; b &lt;", "<p>a &amp;amp; b &amp;lt;</p>"],
    ["inside bold", "**<b onmouseover=x>**", "<p><strong>&lt;b onmouseover=x&gt;</strong></p>"],
    [
      "inside code",
      "`</code><script>x</script>`",
      "<p><code>&lt;/code&gt;&lt;script&gt;x&lt;/script&gt;</code></p>",
    ],
    [
      "inside a fence",
      "```\n</pre><script>x</script>\n```",
      "<pre><code>&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;</code></pre>",
    ],
    [
      "inside a quote",
      "> <iframe src=//evil.example>",
      "<blockquote><p>&lt;iframe src=//evil.example&gt;</p></blockquote>",
    ],
    ["inside a list", "- <style>*{}</style>", "<ul><li>&lt;style&gt;*{}&lt;/style&gt;</li></ul>"],
    ["inside a heading", "# <svg onload=alert(1)>", "<h3>&lt;svg onload=alert(1)&gt;</h3>"],
    [
      "inside link text",
      "[<img src=x onerror=alert(1)>](https://example.com)",
      `<p><a href="https://example.com/" ${LINK_ATTRS}>&lt;img src=x onerror=alert(1)&gt;</a></p>`,
    ],
  ])("%s", (_name, markdown, expected) => {
    const rendered = renderMarkdown(document, markdown);
    expect(serialize(rendered)).toBe(expected);
    expect(violations(rendered)).toEqual([]);
  });
});

describe("renderMarkdown: limits", () => {
  it("shows markers nested too deeply as text, without failing", () => {
    const deep = "*".repeat(5000);
    expect(() => renderMarkdown(document, deep)).not.toThrow();
    const nested = "[".repeat(3000) + "x" + "](https://example.com)".repeat(1);
    expect(() => renderMarkdown(document, nested)).not.toThrow();
    const quotes = "> ".repeat(500) + "x";
    const rendered = renderMarkdown(document, quotes);
    expect(violations(rendered)).toEqual([]);
    expect(rendered.textContent).toContain("x");
  });

  it("renders the prompt's own format", () => {
    const markdown =
      "### What is wrong\nUse **goes** with *he*.\n\n### Better ways\n- He `goes`\n- He went\n";
    expect(render(markdown)).toBe(
      "<h5>What is wrong</h5><p>Use <strong>goes</strong> with <em>he</em>.</p>" +
        "<h5>Better ways</h5><ul><li>He <code>goes</code></li><li>He went</li></ul>",
    );
  });

  it("renders the same text again to the same result (a re-render replaces the nodes)", () => {
    expect(render("# a\n- b")).toBe(render("# a\n- b"));
  });
});
