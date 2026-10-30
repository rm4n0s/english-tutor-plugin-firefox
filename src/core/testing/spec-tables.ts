/** Readers for the tables of docs/SPEC.md that the spec test checks against the code. */

function section(markdown: string, heading: RegExp, endHeading: RegExp): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const length = rest.findIndex((line) => endHeading.test(line));
  return (length === -1 ? rest : rest.slice(0, length)).join("\n");
}

/** The tags of the table in section 10 (first column, in backticks), in order. */
export function parseErrorTags(markdown: string): string[] {
  const body = section(markdown, /^## 10\. /, /^## /);
  return [...body.matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \|/gm)].map((match) => match[1] ?? "");
}

/** The taxonomy table of section 5.6: category name to error type ids, in order. */
export function parseTaxonomy(markdown: string): Map<string, string[]> {
  const body = section(markdown, /^### 5\.6 /, /^#{2,3} /);
  const taxonomy = new Map<string, string[]>();
  for (const row of body.matchAll(/^\| ([a-z]+) \| (.+) \|$/gm)) {
    const category = row[1] ?? "";
    const ids = [...(row[2] ?? "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1] ?? "");
    taxonomy.set(category, ids);
  }
  return taxonomy;
}

/**
 * The tags that have a route test: every string literal given to `hasRoute(...)` that is a tag
 * or ends with `->Tag` counts for that tag.
 */
export function routeTestedTags(testSources: readonly string[]): Set<string> {
  const tags = new Set<string>();
  for (const source of testSources) {
    for (const call of source.matchAll(/hasRoute\(\s*(["'`])([^"'`]+)\1/g)) {
      const route = call[2] ?? "";
      const tag = route.split("->").pop() ?? "";
      if (/^[A-Z][A-Za-z0-9]*$/.test(tag)) tags.add(tag);
    }
  }
  return tags;
}
