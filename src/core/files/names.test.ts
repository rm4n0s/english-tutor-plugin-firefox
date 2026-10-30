import { describe, expect, it } from "vitest";
import {
  baseName,
  cleanTitle,
  defaultTitle,
  downloadFileName,
  nameFromFileName,
  nameFromPath,
  withLineEnding,
} from "./names";

describe("defaultTitle", () => {
  it.each([
    { text: "Hello world", expected: "Hello world" },
    { text: "First line\nSecond line", expected: "First line" },
    { text: "First line\r\nSecond line", expected: "First line" },
    { text: "\n\n   \n  Third line  \nmore", expected: "Third line" },
    { text: "", expected: "Untitled" },
    { text: "   \n\t\n", expected: "Untitled" },
    { text: "a".repeat(60), expected: "a".repeat(60) },
    { text: "a".repeat(61), expected: "a".repeat(60) },
    { text: "a".repeat(200), expected: "a".repeat(60) },
    // Cut by code points, never inside a surrogate pair.
    { text: "😀".repeat(70), expected: "😀".repeat(60) },
    { text: `${"b".repeat(59)}😀😀`, expected: `${"b".repeat(59)}😀` },
    // White space left at the cut is dropped.
    { text: `${"c".repeat(59)} dddd`, expected: "c".repeat(59) },
  ])("$text.length characters -> $expected", ({ text, expected }) => {
    expect(defaultTitle(text)).toBe(expected);
  });
});

describe("cleanTitle", () => {
  it.each([
    { typed: "  My essay  ", expected: "My essay" },
    { typed: "My essay", expected: "My essay" },
    { typed: "", expected: undefined },
    { typed: "   \t ", expected: undefined },
    { typed: "x".repeat(200), expected: "x".repeat(200) },
    { typed: "x".repeat(250), expected: "x".repeat(200) },
    { typed: "😀".repeat(250), expected: "😀".repeat(200) },
  ])("$typed.length characters -> $expected", ({ typed, expected }) => {
    expect(cleanTitle(typed)).toBe(expected);
  });
});

describe("names from files", () => {
  it.each([
    { fileName: "essay.txt", expected: "essay" },
    { fileName: "notes.md", expected: "notes" },
    { fileName: "my essay.final.txt", expected: "my essay.final" },
    { fileName: "no-extension", expected: "no-extension" },
    { fileName: ".txt", expected: ".txt" },
    { fileName: ".hidden", expected: ".hidden" },
    { fileName: "essay.", expected: "essay" },
    { fileName: "/home/user/Downloads/essay.txt", expected: "essay" },
    { fileName: "C:\\Users\\me\\essay.txt", expected: "essay" },
    { fileName: "  spaced .txt", expected: "spaced" },
    { fileName: "", expected: undefined },
  ])("nameFromFileName($fileName) = $expected", ({ fileName, expected }) => {
    expect(nameFromFileName(fileName)).toBe(expected);
  });

  it.each([
    { path: "/home/user/Downloads/essay.txt", expected: "essay" },
    { path: "/home/user/Downloads/essay(1).txt", expected: "essay(1)" },
    { path: "C:\\Users\\me\\Documents\\my essay.txt", expected: "my essay" },
    { path: "essay.txt", expected: "essay" },
    { path: "/home/user/Downloads/", expected: undefined },
    { path: "", expected: undefined },
  ])("nameFromPath($path) = $expected", ({ path, expected }) => {
    expect(nameFromPath(path)).toBe(expected);
  });

  it.each([
    { path: "a/b/c.txt", expected: "c.txt" },
    { path: "a\\b\\c.txt", expected: "c.txt" },
    { path: "c.txt", expected: "c.txt" },
    { path: "a/b\\c.txt", expected: "c.txt" },
    { path: "dir/", expected: "" },
  ])("baseName($path) = $expected", ({ path, expected }) => {
    expect(baseName(path)).toBe(expected);
  });
});

describe("downloadFileName", () => {
  it.each([
    { name: "essay", expected: "essay.txt" },
    { name: "essay.txt", expected: "essay.txt" },
    { name: "notes.md", expected: "notes.md" },
    { name: "My essay about school", expected: "My essay about school.txt" },
    { name: "v1.2 draft", expected: "v1.2 draft.txt" },
    { name: "Mr. Smith", expected: "Mr. Smith.txt" },
    { name: "Dr.Smith", expected: "Dr.Smith.txt" },
    { name: "report.2024", expected: "report.2024" },
    { name: 'a/b\\c:d*e?f"g<h>i|j', expected: "a_b_c_d_e_f_g_h_i_j.txt" },
    { name: "tab\there\nnewline", expected: "tab_here_newline.txt" },
    { name: "../../etc/passwd", expected: "_.._etc_passwd.txt" },
    { name: "..", expected: "Untitled.txt" },
    { name: "...hidden", expected: "hidden.txt" },
    { name: "  spaced  ", expected: "spaced.txt" },
    { name: "ends with dots...", expected: "ends with dots.txt" },
    { name: "", expected: "Untitled.txt" },
    { name: "   ", expected: "Untitled.txt" },
    { name: "x".repeat(300), expected: `${"x".repeat(116)}.txt` },
    { name: `${"y".repeat(300)}.md`, expected: `${"y".repeat(117)}.md` },
    { name: "😀".repeat(200), expected: `${"😀".repeat(116)}.txt` },
  ])("downloadFileName($name) = $expected", ({ name, expected }) => {
    expect(downloadFileName(name)).toBe(expected);
  });

  it("never gives a path, a back-reference or an empty name", () => {
    for (const name of ["/", "\\", "../x", "a/../b", ".", "..", "/etc/passwd", "C:\\x", "   "]) {
      const result = downloadFileName(name);
      expect(result).not.toMatch(/[/\\:]/);
      expect(result.startsWith(".")).toBe(false);
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe("withLineEnding", () => {
  it.each([
    { text: "a\nb\nc", ending: "lf" as const, expected: "a\nb\nc" },
    { text: "a\nb\nc", ending: "crlf" as const, expected: "a\r\nb\r\nc" },
    { text: "", ending: "crlf" as const, expected: "" },
    { text: "no break", ending: "crlf" as const, expected: "no break" },
    { text: "\n\n", ending: "crlf" as const, expected: "\r\n\r\n" },
  ])("$ending: $text", ({ text, ending, expected }) => {
    expect(withLineEnding(text, ending)).toBe(expected);
  });
});
