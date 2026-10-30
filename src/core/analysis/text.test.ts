import { describe, expect, it } from "vitest";
import {
  codePointAt,
  codePointBefore,
  countCodePoints,
  countWords,
  fields,
  isBoundary,
  isSpaceCode,
  isWordCodePoint,
  lowerCase,
  takeCodePoints,
  takeLastCodePoints,
  trimEndSpace,
  trimSpace,
  trimStartSpace,
  wellFormed,
} from "./text";

describe("isSpaceCode (Go's unicode.IsSpace)", () => {
  it.each([
    { code: 0x20, space: true },
    { code: 0x09, space: true },
    { code: 0x0a, space: true },
    { code: 0x0b, space: true },
    { code: 0x0c, space: true },
    { code: 0x0d, space: true },
    { code: 0x85, space: true },
    { code: 0xa0, space: true },
    { code: 0x1680, space: true },
    { code: 0x2003, space: true },
    { code: 0x2028, space: true },
    { code: 0x2029, space: true },
    { code: 0x202f, space: true },
    { code: 0x205f, space: true },
    { code: 0x3000, space: true },
    { code: 0x200b, space: false },
    { code: 0xfeff, space: false },
    { code: 0x61, space: false },
    { code: 0x00, space: false },
  ])("U+$code", ({ code, space }) => {
    expect(isSpaceCode(code)).toBe(space);
  });
});

describe("isWordCodePoint", () => {
  it.each([
    { char: "a", word: true },
    { char: "É", word: true },
    { char: "日", word: true },
    { char: "7", word: true },
    { char: "٣", word: true },
    { char: "_", word: false },
    { char: "'", word: false },
    { char: " ", word: false },
    { char: "😀", word: false },
    { char: "́", word: false },
  ])("$char", ({ char, word }) => {
    expect(isWordCodePoint(char.codePointAt(0) ?? 0)).toBe(word);
  });
});

describe("boundaries and code points", () => {
  const text = "a😀b";
  it.each([
    { index: 0, boundary: true },
    { index: 1, boundary: true },
    { index: 2, boundary: false },
    { index: 3, boundary: true },
    { index: 4, boundary: true },
    { index: 99, boundary: true },
    { index: -1, boundary: true },
  ])("isBoundary($index)", ({ index, boundary }) => {
    expect(isBoundary(text, index)).toBe(boundary);
  });

  it("a lone surrogate is a boundary on both sides", () => {
    expect(isBoundary("a\ud83db", 2)).toBe(true);
    expect(isBoundary("a\ude00b", 1)).toBe(true);
  });

  it("reads code points forwards and backwards", () => {
    expect(codePointAt(text, 1)).toBe(0x1f600);
    expect(codePointBefore(text, 3)).toBe(0x1f600);
    expect(codePointBefore(text, 1)).toBe(0x61);
    expect(codePointAt("\ud83d", 0)).toBe(0xd83d);
    expect(codePointBefore("\ude00", 1)).toBe(0xde00);
    expect(codePointBefore("😀", 2)).toBe(0x1f600);
  });
});

describe("trimming and words", () => {
  it.each([
    { input: "  a b \n", start: "a b \n", end: "  a b", both: "a b" },
    { input: " 　x ", start: "x ", end: " 　x", both: "x" },
    { input: "﻿x", start: "﻿x", end: "﻿x", both: "﻿x" },
    { input: "   ", start: "", end: "", both: "" },
    { input: "", start: "", end: "", both: "" },
  ])("trims $input", ({ input, start, end, both }) => {
    expect(trimStartSpace(input)).toBe(start);
    expect(trimEndSpace(input)).toBe(end);
    expect(trimSpace(input)).toBe(both);
  });

  it("splits fields and counts words", () => {
    expect(fields("  a \n b\t c  ")).toEqual(["a", "b", "c"]);
    expect(fields("")).toEqual([]);
    expect(countWords("  one two\nthree　four ")).toBe(4);
    expect(countWords("   ")).toBe(0);
    expect(countWords("😀 😀")).toBe(2);
  });
});

describe("code point counts and cuts", () => {
  it("counts characters, not units", () => {
    expect(countCodePoints("a😀é")).toBe(3);
    expect(countCodePoints("")).toBe(0);
  });

  it.each([
    { s: "a😀é", n: 0, first: "", last: "" },
    { s: "a😀é", n: 1, first: "a", last: "é" },
    { s: "a😀é", n: 2, first: "a😀", last: "😀é" },
    { s: "a😀é", n: 3, first: "a😀é", last: "a😀é" },
    { s: "a😀é", n: 9, first: "a😀é", last: "a😀é" },
  ])("takes $n of $s", ({ s, n, first, last }) => {
    expect(takeCodePoints(s, n)).toBe(first);
    expect(takeLastCodePoints(s, n)).toBe(last);
  });
});

describe("wellFormed", () => {
  it.each([
    { input: "plain", want: "plain" },
    { input: "a😀b", want: "a😀b" },
    { input: "a\ud83db", want: "a�b" },
    { input: "a\ude00b", want: "a�b" },
    { input: "\ude00\ud83d", want: "��" },
    { input: "\ud83d", want: "�" },
  ])("$want", ({ input, want }) => {
    expect(wellFormed(input)).toBe(want);
  });
});

describe("lowerCase", () => {
  it.each([
    { input: "Hello", want: "hello" },
    { input: "ÉCOLE", want: "école" },
    { input: "İ", want: "i" },
    { input: "Straße", want: "straße" },
    { input: "ΑΣ", want: "ασ" },
    { input: "ΑΣΤΡΟ ΑΣ", want: "αστρο ασ" },
    { input: "😀A", want: "😀a" },
    { input: "\ud83dA", want: "\ud83da" },
  ])("$input", ({ input, want }) => {
    expect(lowerCase(input)).toBe(want);
  });
});
