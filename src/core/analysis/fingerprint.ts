import { fields, lowerCase } from "./text";

/**
 * Lower-cases a snippet and collapses every run of white space into one space, so that trivial
 * differences do not make a different mistake.
 */
export function normaliseSnippet(s: string): string {
  return fields(lowerCase(s)).join(" ");
}

/** The number of non-overlapping occurrences of `needle` in `haystack` (`needle` is not empty). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let from = 0; ;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

/**
 * Identifies one mistake within one text (SPEC section 5.7): the hex SHA-256 of the normalised
 * snippet `text.slice(start, end)`, a NUL, and its occurrence index, the number of times the same
 * snippet (ignoring case) occurs, without overlapping, in the text before `start`. Nothing that
 * comes from the model's own judgement goes into it (no error type, context or position), because
 * the model can answer differently on every run. `start` and `end` are clamped into the text.
 */
export async function fingerprint(text: string, start: number, end: number): Promise<string> {
  const from = Math.min(Math.max(start, 0), text.length);
  const to = Math.min(Math.max(end, from), text.length);
  const snippet = text.slice(from, to);
  const occurrence =
    snippet === "" ? 0 : countOccurrences(lowerCase(text.slice(0, from)), lowerCase(snippet));
  const data = new TextEncoder().encode(`${normaliseSnippet(snippet)}\u0000${String(occurrence)}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
