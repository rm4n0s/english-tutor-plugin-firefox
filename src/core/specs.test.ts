import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORIES, errorTypes } from "./analysis/taxonomy";
import { parseErrorTags, parseTaxonomy, routeTestedTags } from "./testing/spec-tables";

const root = join(import.meta.dirname, "..", "..");
const spec = readFileSync(join(root, "docs", "SPEC.md"), "utf8");
const tags = parseErrorTags(spec);

/**
 * Tags of SPEC section 10 that have no route test yet. Each step that adds the code for a tag
 * adds its route test and removes the tag from this list; the test below fails if a listed tag
 * is already covered, so the list only shrinks.
 */
const TAGS_WITHOUT_ROUTE_TEST: readonly string[] = ["PageFrameBlocked", "PageModePermissionDenied"];

function testSources(dir: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources.push(...testSources(path));
    // errors.test.ts and specs.test.ts use tags as examples, not as route tests.
    else if (
      entry.name.endsWith(".test.ts") &&
      entry.name !== "errors.test.ts" &&
      entry.name !== "specs.test.ts"
    ) {
      sources.push(readFileSync(path, "utf8"));
    }
  }
  return sources;
}

describe("SPEC section 10 (error tags)", () => {
  it("lists tags", () => {
    expect(tags.length).toBeGreaterThan(0);
  });

  it("has unique PascalCase tags", () => {
    expect(tags.filter((tag, i) => tags.indexOf(tag) !== i)).toEqual([]);
    expect(tags.filter((tag) => !/^[A-Z][A-Za-z0-9]*$/.test(tag))).toEqual([]);
  });

  it("has an allow-list of untested tags that names only listed tags, once each", () => {
    expect(TAGS_WITHOUT_ROUTE_TEST.filter((tag) => !tags.includes(tag))).toEqual([]);
    expect(
      TAGS_WITHOUT_ROUTE_TEST.filter((tag, i) => TAGS_WITHOUT_ROUTE_TEST.indexOf(tag) !== i),
    ).toEqual([]);
  });

  describe("route tests", () => {
    const tested = routeTestedTags(testSources(join(root, "src")));

    it("exist for every tag that is not in the allow-list", () => {
      const missing = tags.filter(
        (tag) => !TAGS_WITHOUT_ROUTE_TEST.includes(tag) && !tested.has(tag),
      );
      expect(missing).toEqual([]);
    });

    it("are not hidden behind the allow-list (remove a tag from it once it has a route test)", () => {
      expect(TAGS_WITHOUT_ROUTE_TEST.filter((tag) => tested.has(tag))).toEqual([]);
    });
  });
});

describe("SPEC section 5.6 (taxonomy)", () => {
  const taxonomy = parseTaxonomy(spec);

  it.each([
    { category: "grammar", count: 11, first: "subject_verb_agreement", last: "grammar_other" },
    { category: "syntax", count: 7, first: "word_order", last: "syntax_other" },
    { category: "vocabulary", count: 5, first: "wrong_word", last: "vocabulary_other" },
  ])("has $count ids in $category", ({ category, count, first, last }) => {
    const ids = taxonomy.get(category) ?? [];
    expect(ids).toHaveLength(count);
    expect(ids[0]).toBe(first);
    expect(ids.at(-1)).toBe(last);
  });

  it("matches the code: the same categories and the same ids in the same order", () => {
    expect([...taxonomy.keys()]).toEqual([...CATEGORIES]);
    for (const category of CATEGORIES) {
      expect(
        errorTypes()
          .filter((t) => t.category === category)
          .map((t) => t.id),
      ).toEqual(taxonomy.get(category));
    }
    expect(errorTypes().map((t) => t.id)).toEqual([...taxonomy.values()].flat());
  });

  it("has unique ids across the categories", () => {
    const ids = [...taxonomy.values()].flat();
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

describe("spec table readers", () => {
  it.each([
    {
      name: "reads the first column of the section 10 table only",
      markdown: [
        "## 9. Data",
        "| `NotATag` | x |",
        "## 10. Error handling",
        "| Tag | Where |",
        "|---|---|",
        "| `A` | store |",
        "| `BTag` | llm |",
        "- a bullet with `Code`",
        "## 11. Testing",
        "| `AlsoNot` | x |",
      ].join("\n"),
      expected: ["A", "BTag"],
    },
    { name: "returns nothing without the section", markdown: "# nothing", expected: [] },
  ])("parseErrorTags $name", ({ markdown, expected }) => {
    expect(parseErrorTags(markdown)).toEqual(expected);
  });

  it("parseTaxonomy reads categories and ids of section 5.6 only", () => {
    const markdown = [
      "### 5.5 Edits",
      "| grammar | `no` |",
      "### 5.6 Error type taxonomy",
      "| Category | Error types (id) |",
      "|---|---|",
      "| grammar | `a`, `b_c` |",
      "| syntax | `d` |",
      "### 5.7 Counting",
      "| vocabulary | `no` |",
    ].join("\n");
    expect(parseTaxonomy(markdown)).toEqual(
      new Map([
        ["grammar", ["a", "b_c"]],
        ["syntax", ["d"]],
      ]),
    );
  });

  it.each([
    {
      name: "a bare tag",
      source: 'expect(e.hasRoute("LLMCallTimeout")).toBe(true)',
      expected: ["LLMCallTimeout"],
    },
    {
      name: "a route",
      source: "expect(err.hasRoute('Analyzer.check->OpenAIClient.chat->LLMCallFailed')).toBe(true)",
      expected: ["LLMCallFailed"],
    },
    {
      name: "a call that is only a method",
      source: 'err.hasRoute("analyzer.check")',
      expected: [],
    },
    { name: "no calls", source: "it('works', () => {})", expected: [] },
  ])("routeTestedTags reads $name", ({ source, expected }) => {
    expect([...routeTestedTags([source])]).toEqual(expected);
  });
});
