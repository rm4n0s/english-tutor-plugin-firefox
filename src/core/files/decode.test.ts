import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { decodeTextFile, MAX_FILE_BYTES, readTextFile, type FileLike } from "./decode";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const concat = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());
const BOM = [0xef, 0xbb, 0xbf];

describe("decodeTextFile", () => {
  it.each([
    { name: "plain text", bytes: utf8("Hello there."), text: "Hello there.", ending: "lf" },
    { name: "empty file", bytes: utf8(""), text: "", ending: "lf" },
    { name: "LF line breaks", bytes: utf8("a\nb\n"), text: "a\nb\n", ending: "lf" },
    { name: "CRLF line breaks", bytes: utf8("a\r\nb\r\n"), text: "a\nb\n", ending: "crlf" },
    { name: "mixed line breaks", bytes: utf8("a\r\nb\nc"), text: "a\nb\nc", ending: "crlf" },
    { name: "a lone CR", bytes: utf8("a\rb"), text: "a\nb", ending: "lf" },
    { name: "a final CR LF", bytes: utf8("a\r\n"), text: "a\n", ending: "crlf" },
    { name: "a BOM", bytes: concat(BOM, [...utf8("Hi")]), text: "Hi", ending: "lf" },
    {
      name: "a BOM and CRLF",
      bytes: concat(BOM, [...utf8("x\r\ny")]),
      text: "x\ny",
      ending: "crlf",
    },
    { name: "a BOM only", bytes: Uint8Array.from(BOM), text: "", ending: "lf" },
    { name: "accents", bytes: utf8("café naïve"), text: "café naïve", ending: "lf" },
    { name: "emoji", bytes: utf8("fun 😀 times"), text: "fun 😀 times", ending: "lf" },
    { name: "a BOM inside the text", bytes: utf8("a﻿b"), text: "a﻿b", ending: "lf" },
  ])("$name", ({ bytes, text, ending }) => {
    expect(decodeTextFile(bytes)).toEqual({ text, lineEnding: ending });
  });

  it.each([
    { name: "a lone continuation byte", bytes: Uint8Array.from([0x61, 0x80, 0x62]) },
    { name: "an overlong sequence", bytes: Uint8Array.from([0xc0, 0xaf]) },
    { name: "a cut sequence", bytes: Uint8Array.from([0x61, 0xe2, 0x82]) },
    { name: "Latin-1 text", bytes: Uint8Array.from([0x63, 0x61, 0x66, 0xe9]) },
    { name: "UTF-16 text", bytes: Uint8Array.from([0xff, 0xfe, 0x61, 0x00]) },
    { name: "a surrogate encoded in UTF-8", bytes: Uint8Array.from([0xed, 0xa0, 0x80]) },
  ])("refuses $name as FileNotUTF8", ({ bytes }) => {
    let err: unknown;
    try {
      decodeTextFile(bytes);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("decodeTextFile->FileNotUTF8")).toBe(true);
    expect((err as AppError).message).not.toContain("café");
  });

  it.each([
    { name: "at the start", bytes: Uint8Array.from([0, 0x61]) },
    { name: "in the middle", bytes: utf8("ab\u0000cd") },
    { name: "at the end", bytes: utf8("abc\u0000") },
    { name: "after a BOM", bytes: concat(BOM, [0, 0x61]) },
  ])("refuses a NUL byte $name as FileNotUTF8", ({ bytes }) => {
    let err: unknown;
    try {
      decodeTextFile(bytes);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("decodeTextFile->FileNotUTF8")).toBe(true);
  });

  it("keeps the content out of the error", () => {
    let err: unknown;
    try {
      decodeTextFile(concat([...utf8("secret words ")], [0xff]));
    } catch (e) {
      err = e;
    }
    const error = err as AppError;
    expect(JSON.stringify([error.message, error.metadata])).not.toContain("secret");
  });
});

function fileOf(bytes: Uint8Array, size = bytes.length): FileLike {
  return {
    size,
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  };
}

const caught = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("readTextFile", () => {
  it("reads and decodes a file", async () => {
    expect(await readTextFile(fileOf(utf8("a\r\nb")))).toEqual({
      text: "a\nb",
      lineEnding: "crlf",
    });
  });

  it.each([
    { name: "exactly 10 MB", size: MAX_FILE_BYTES, ok: true },
    { name: "one byte over 10 MB", size: MAX_FILE_BYTES + 1, ok: false },
    { name: "a huge size", size: 5 * MAX_FILE_BYTES, ok: false },
  ])("a file of $name", async ({ size, ok }) => {
    let reads = 0;
    const file: FileLike = {
      size,
      arrayBuffer: () => {
        reads++;
        return Promise.resolve(new ArrayBuffer(0));
      },
    };
    if (ok) {
      await expect(readTextFile(file)).resolves.toEqual({ text: "", lineEnding: "lf" });
      return;
    }
    const err = await caught(readTextFile(file));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("readTextFile->FileReadFailed")).toBe(true);
    // The file is refused by its size, without reading it.
    expect(reads).toBe(0);
  });

  it("refuses a file that grew beyond 10 MB while it was read", async () => {
    const file: FileLike = {
      size: 10,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(MAX_FILE_BYTES + 1)),
    };
    const err = await caught(readTextFile(file));
    expect((err as AppError).hasRoute("readTextFile->FileReadFailed")).toBe(true);
  });

  it("gives FileReadFailed when the read fails", async () => {
    const file: FileLike = {
      size: 4,
      arrayBuffer: () => Promise.reject(new DOMException("denied", "NotReadableError")),
    };
    const err = await caught(readTextFile(file));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("readTextFile->FileReadFailed")).toBe(true);
    expect((err as AppError).cause).toBeInstanceOf(DOMException);
  });

  it("gives FileNotUTF8 with the route of the read", async () => {
    const err = await caught(readTextFile(fileOf(Uint8Array.from([0x61, 0xff]))));
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("readTextFile->decodeTextFile->FileNotUTF8")).toBe(true);
  });

  it("rejects with the reason of a cancelled signal, not with an AppError", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await caught(readTextFile(fileOf(utf8("x")), { signal: controller.signal }));
    expect(err).not.toBeInstanceOf(AppError);
    expect((err as DOMException).name).toBe("AbortError");
  });

  it("does not report a cancel that happens during the read as a decoding result", async () => {
    const controller = new AbortController();
    const file: FileLike = {
      size: 1,
      arrayBuffer: () => {
        controller.abort();
        return Promise.resolve(new ArrayBuffer(1));
      },
    };
    const err = await caught(readTextFile(file, { signal: controller.signal }));
    expect(err).not.toBeInstanceOf(AppError);
  });
});
