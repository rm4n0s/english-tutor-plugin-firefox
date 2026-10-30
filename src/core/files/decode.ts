import { AppError } from "../errors";
import type { LineEnding } from "../store";

/** Files over this size are refused (SPEC section 8). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** What `readTextFile` needs from a `File`, so that tests can pass a fake. */
export interface FileLike {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DecodedText {
  /** The text with `\n` line breaks, as a textarea holds it. */
  text: string;
  /** `crlf` when the file had `\r\n` line breaks. */
  lineEnding: LineEnding;
}

/**
 * Decodes the bytes of a text file (SPEC section 8): UTF-8 only (`fatal: true`), a NUL byte is
 * refused, a leading BOM is dropped, and every line break becomes `\n` (a textarea does the same
 * to its value). If the file had `\r\n` line breaks, `lineEnding` is `crlf`, so that Save writes
 * them back. Fails with `FileNotUTF8`; the file's content is never put in the error.
 */
export function decodeTextFile(bytes: Uint8Array): DecodedText {
  let decoded: string;
  try {
    // `ignoreBOM: true` keeps the BOM in the output so that it is dropped here, once, on purpose.
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (err) {
    throw new AppError(
      "FileNotUTF8",
      "The file is not valid UTF-8 text, so it was not opened.",
      { size: bytes.length },
      { cause: err },
    ).via("decodeTextFile");
  }
  if (decoded.includes("\u0000")) {
    throw new AppError("FileNotUTF8", "The file contains a NUL byte, so it is not a text file.", {
      size: bytes.length,
    }).via("decodeTextFile");
  }
  const withoutBom = decoded.startsWith("﻿") ? decoded.slice(1) : decoded;
  const lineEnding: LineEnding = withoutBom.includes("\r\n") ? "crlf" : "lf";
  return { text: withoutBom.replace(/\r\n?/g, "\n"), lineEnding };
}

/**
 * Reads and decodes a chosen file before anything in the page is replaced. A file over 10 MB, or
 * one that cannot be read, fails with `FileReadFailed`; one that is not UTF-8 text with
 * `FileNotUTF8`. A cancelled read rejects with the signal's reason (cancelling is not an error).
 */
export async function readTextFile(
  file: FileLike,
  options: { signal?: AbortSignal } = {},
): Promise<DecodedText> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (file.size > MAX_FILE_BYTES) {
    throw new AppError("FileReadFailed", "The file is larger than 10 MB, so it was not opened.", {
      size: file.size,
    }).via("readTextFile");
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    throw AppError.wrap("FileReadFailed", err, { size: file.size }).via("readTextFile");
  }
  signal?.throwIfAborted();
  // The size reported can differ from what was read (a file that changed meanwhile).
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new AppError("FileReadFailed", "The file is larger than 10 MB, so it was not opened.", {
      size: buffer.byteLength,
    }).via("readTextFile");
  }
  try {
    return decodeTextFile(new Uint8Array(buffer));
  } catch (err) {
    throw err instanceof AppError ? err.via("readTextFile") : err;
  }
}
