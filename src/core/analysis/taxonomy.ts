import { trimSpace } from "./text";

/** The three categories, in the order the legend lists them (SPEC section 5.6). */
export const CATEGORIES = ["grammar", "syntax", "vocabulary"] as const;

export type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  grammar: "Grammar",
  syntax: "Syntax",
  vocabulary: "Vocabulary",
};

/** The display name of a category; an unknown one is shown as it is. */
export function categoryLabel(category: string): string {
  return category in CATEGORY_LABELS ? CATEGORY_LABELS[category as Category] : category;
}

/**
 * One entry of the fixed taxonomy. Ids are stable (statistics store them as text), a label may
 * change.
 */
export interface ErrorType {
  readonly id: string;
  readonly label: string;
  readonly category: Category;
}

function type(id: string, label: string, category: Category): ErrorType {
  return Object.freeze({ id, label, category });
}

/** `taxonomy.go`, in display order. */
const TAXONOMY: readonly ErrorType[] = Object.freeze([
  type("subject_verb_agreement", "Subject-verb agreement", "grammar"),
  type("verb_tense", "Verb tense", "grammar"),
  type("verb_form", "Verb form", "grammar"),
  type("modal_verb", "Modal verb", "grammar"),
  type("article", "Article", "grammar"),
  type("preposition", "Preposition", "grammar"),
  type("plural_singular", "Singular/plural", "grammar"),
  type("countable_uncountable", "Countable/uncountable", "grammar"),
  type("pronoun", "Pronoun", "grammar"),
  type("comparative_superlative", "Comparative/superlative", "grammar"),
  type("grammar_other", "Other grammar", "grammar"),

  type("word_order", "Word order", "syntax"),
  type("missing_word", "Missing word", "syntax"),
  type("extra_word", "Extra word", "syntax"),
  type("sentence_fragment", "Sentence fragment", "syntax"),
  type("run_on_sentence", "Run-on sentence", "syntax"),
  type("conditional_structure", "Conditional structure", "syntax"),
  type("syntax_other", "Other syntax (including punctuation and capitalisation)", "syntax"),

  type("wrong_word", "Wrong word", "vocabulary"),
  type("confused_words", "Confused words", "vocabulary"),
  type("collocation", "Collocation", "vocabulary"),
  type("spelling", "Spelling", "vocabulary"),
  type("vocabulary_other", "Other vocabulary", "vocabulary"),
]);

/** The whole taxonomy in display order. */
export function errorTypes(): readonly ErrorType[] {
  return TAXONOMY;
}

/** The catch-all id of a category: `grammar_other`, `syntax_other`, `vocabulary_other`. */
export function otherId(category: Category): string {
  return `${category}_other`;
}

/** The type with exactly this id. */
export function lookupErrorType(id: string): ErrorType | undefined {
  return TAXONOMY.find((t) => t.id === id);
}

function fallback(id: string): ErrorType {
  const found = lookupErrorType(id);
  if (found === undefined) throw new RangeError(`the taxonomy has no ${id}`);
  return found;
}

/**
 * Maps whatever id the model returned to a taxonomy entry. A known id (ignoring case, space at the
 * ends, and spaces or hyphens used for underscores) gives that type. Anything else becomes the
 * `_other` type of the category its wording suggests, or `grammar_other`. An unknown id is not an
 * error.
 */
export function resolveErrorType(id: string): ErrorType {
  const norm = normaliseId(id);
  return lookupErrorType(norm) ?? fallback(otherId(guessCategory(norm)));
}

function normaliseId(id: string): string {
  return trimSpace(id).toLowerCase().replaceAll(" ", "_").replaceAll("-", "_");
}

/** Words that suggest a category, checked as substrings of a normalised id. */
const CATEGORY_HINTS: Readonly<Record<Category, readonly string[]>> = {
  grammar: [
    "grammar",
    "tense",
    "verb",
    "agreement",
    "article",
    "preposition",
    "plural",
    "singular",
    "pronoun",
    "modal",
    "countable",
    "comparative",
    "superlative",
    "inflect",
  ],
  syntax: [
    "syntax",
    "order",
    "sentence",
    "clause",
    "fragment",
    "punctuation",
    "capital",
    "structure",
    "conditional",
    "missing",
    "extra",
    "comma",
    "run_on",
  ],
  vocabulary: [
    "vocab",
    "word",
    "spell",
    "collocation",
    "lexical",
    "lexis",
    "diction",
    "usage",
    "idiom",
    "confus",
    "typo",
  ],
};

/** The category with the most hits; a tie goes to the earlier category. */
function guessCategory(norm: string): Category {
  let best: Category = "grammar";
  let bestHits = 0;
  for (const category of CATEGORIES) {
    const hits = CATEGORY_HINTS[category].filter((hint) => norm.includes(hint)).length;
    if (hits > bestHits) {
      best = category;
      bestHits = hits;
    }
  }
  return best;
}
