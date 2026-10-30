import { describe, expect, it } from "vitest";
import { fingerprint, normaliseSnippet } from "./fingerprint";

/** The fingerprint of the n-th (0-based) occurrence of `snippet` in `text`. */
function fp(text: string, snippet: string, nth: number): Promise<string> {
  let pos = -1;
  for (let i = 0; i <= nth; i++) pos = text.indexOf(snippet, pos + 1);
  expect(pos).toBeGreaterThanOrEqual(0);
  return fingerprint(text, pos, pos + snippet.length);
}

describe("normaliseSnippet", () => {
  it.each([
    { input: "He Go", want: "he go" },
    { input: "  he \n go\t", want: "he go" },
    { input: "ÉCOLE", want: "école" },
    { input: "a b　c", want: "a b c" },
    { input: "😀  Ab", want: "😀 ab" },
    { input: "", want: "" },
  ])("$input", ({ input, want }) => {
    expect(normaliseSnippet(input)).toBe(want);
  });
});

describe("fingerprint", () => {
  const text = "He go home. She say hi. He go out.";

  it("is the hex SHA-256 of the normalised snippet, a NUL and the occurrence index", async () => {
    // sha256("he go\u00000"), computed independently.
    const expected = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode("he go\u00000"))
      .then((d) => Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join(""));
    expect(await fp(text, "He go", 0)).toBe(expected);
    expect(await fp(text, "He go", 0)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same mistake in the same text", async () => {
    expect(await fp(text, "He go", 0)).toBe(await fp(text, "He go", 0));
  });

  it("differs by occurrence", async () => {
    expect(await fp(text, "He go", 0)).not.toBe(await fp(text, "He go", 1));
  });

  it("differs by snippet", async () => {
    expect(await fp(text, "He go", 0)).not.toBe(await fp(text, "She say", 0));
  });

  it("ignores case and spacing of the snippet", async () => {
    expect(await fingerprint("he  go home", 0, "he  go".length)).toBe(
      await fingerprint("HE GO home", 0, "HE GO".length),
    );
  });

  it("ignores the text after the snippet", async () => {
    expect(await fingerprint("He go home.", 0, 5)).toBe(
      await fingerprint("He go somewhere else entirely.", 0, 5),
    );
  });

  it("ignores an unrelated edit before the snippet", async () => {
    expect(await fp("Hello. He go home.", "He go", 0)).toBe(
      await fp("A much longer start of the text. He go home.", "He go", 0),
    );
  });

  it("changes for the old mistake when an identical snippet is added before it (known limit)", async () => {
    const old = await fp("He go home.", "He go", 0);
    const edited = "He go there. He go home.";
    expect(await fp(edited, "He go", 0)).toBe(old);
    expect(await fp(edited, "He go", 1)).not.toBe(old);
  });

  it("counts occurrences ignoring case", async () => {
    expect(await fingerprint("HE GO. he go", 7, 12)).toBe(await fingerprint("he go. he go", 7, 12));
  });

  it("counts occurrences without overlap", async () => {
    // "aa" in "aaaaa" before the snippet: 2 (non-overlapping), not 4.
    const a = await fingerprint("aaaaa aa", 6, 8);
    const b = await fingerprint("aaaa aa", 5, 7);
    expect(a).toBe(b);
  });

  it("handles emoji and accents, with UTF-16 offsets", async () => {
    const t = "😀 café. 😀 café.";
    const first = await fingerprint(t, 3, 7);
    const second = await fingerprint(t, t.lastIndexOf("café"), t.lastIndexOf("café") + 4);
    expect(first).not.toBe(second);
    expect(await fingerprint("café", 0, 4)).toBe(first);
  });

  it("lower-cases the same snippet the same way wherever it stands", async () => {
    // A whole-string toLowerCase turns the final sigma of "ΑΣ" into ς, but not the one in
    // "ΑΣΤΡΟ", so the first snippet would not be found in the second text.
    expect(await fingerprint("ΑΣΤΡΟ ΑΣ", 6, 8)).toBe(await fingerprint("ΑΣ ΑΣ", 3, 5));
  });

  it("clamps offsets and does not throw on an empty snippet", async () => {
    expect(await fingerprint("abc", 1, 1)).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint("abc", -5, 99)).toBe(await fingerprint("abc", 0, 3));
    expect(await fingerprint("abc", 3, 1)).toMatch(/^[0-9a-f]{64}$/);
  });
});
