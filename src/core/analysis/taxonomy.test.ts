import { describe, expect, it } from "vitest";
import {
  categoryLabel,
  CATEGORIES,
  errorTypes,
  lookupErrorType,
  otherId,
  resolveErrorType,
} from "./taxonomy";

describe("taxonomy", () => {
  it("is complete: ids, order and categories of SPEC section 5.6", () => {
    const want = {
      grammar: [
        "subject_verb_agreement",
        "verb_tense",
        "verb_form",
        "modal_verb",
        "article",
        "preposition",
        "plural_singular",
        "countable_uncountable",
        "pronoun",
        "comparative_superlative",
        "grammar_other",
      ],
      syntax: [
        "word_order",
        "missing_word",
        "extra_word",
        "sentence_fragment",
        "run_on_sentence",
        "conditional_structure",
        "syntax_other",
      ],
      vocabulary: ["wrong_word", "confused_words", "collocation", "spelling", "vocabulary_other"],
    };
    for (const category of CATEGORIES) {
      expect(
        errorTypes()
          .filter((t) => t.category === category)
          .map((t) => t.id),
      ).toEqual(want[category]);
    }
    const ids = errorTypes().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(errorTypes().filter((t) => t.label === "")).toEqual([]);
  });

  it.each(CATEGORIES)("%s has an _other type in its own category", (category) => {
    expect(lookupErrorType(otherId(category))?.category).toBe(category);
  });

  it("cannot be changed from outside", () => {
    const first = errorTypes()[0];
    expect(Object.isFrozen(errorTypes())).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each([
    { id: "verb_tense", category: "grammar" },
    { id: "spelling", category: "vocabulary" },
    { id: "word_order", category: "syntax" },
    { id: "Verb_Tense", category: undefined },
    { id: "", category: undefined },
  ])("lookupErrorType($id)", ({ id, category }) => {
    expect(lookupErrorType(id)?.category).toBe(category);
  });

  it.each([
    { name: "known id", input: "verb_tense", want: "verb_tense" },
    { name: "known id with different case and space", input: "  Verb Tense ", want: "verb_tense" },
    {
      name: "known id with hyphens",
      input: "subject-verb-agreement",
      want: "subject_verb_agreement",
    },
    { name: "category name only", input: "grammar", want: "grammar_other" },
    { name: "vocabulary wording", input: "vocabulary error", want: "vocabulary_other" },
    { name: "word choice wording", input: "word_choice_issue", want: "vocabulary_other" },
    { name: "punctuation", input: "punctuation", want: "syntax_other" },
    { name: "capitalisation", input: "capitalization", want: "syntax_other" },
    { name: "unknown grammar wording", input: "tense_consistency", want: "grammar_other" },
    { name: "unknown syntax wording", input: "clause_structure_problem", want: "syntax_other" },
    { name: "nothing suggests a category", input: "zzz", want: "grammar_other" },
    { name: "empty", input: "", want: "grammar_other" },
    { name: "very long", input: "x".repeat(10000), want: "grammar_other" },
    { name: "non-ASCII", input: "ÉCRITURE 日本語", want: "grammar_other" },
  ])("resolveErrorType: $name", ({ input, want }) => {
    expect(resolveErrorType(input).id).toBe(want);
  });

  it("gives labels to categories, and shows an unknown one as it is", () => {
    expect(CATEGORIES.map(categoryLabel)).toEqual(["Grammar", "Syntax", "Vocabulary"]);
    expect(categoryLabel("other")).toBe("other");
  });
});
