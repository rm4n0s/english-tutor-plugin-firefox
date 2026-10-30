import { takeCodePoints, trimSpace } from "../analysis/text";
import type { LineEnding } from "../store";

/** The longest title the title dialog accepts, in code points. */
export const MAX_TITLE_LENGTH = 200;

/** The default title of a text is its first line cut to this many code points (SPEC section 8). */
export const DEFAULT_TITLE_LENGTH = 60;

/** The name shown for a text that has none, in the tab title and as a download name. */
export const UNTITLED = "Untitled";

/** The longest download file name the extension proposes, in code points, `.txt` included. */
const MAX_FILE_NAME_LENGTH = 120;

/** A name has an extension when it ends in a dot and 1 to 4 letters or digits. */
const EXTENSION = /\.[\p{L}\p{N}]{1,4}$/u;

/**
 * The default title of a text for Save to library and the proposed name of Save As: its first
 * line that is not only white space, trimmed and cut to 60 code points (never inside a surrogate
 * pair). A text without such a line gives "Untitled".
 */
export function defaultTitle(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = trimSpace(line);
    if (trimmed !== "") return trimSpace(takeCodePoints(trimmed, DEFAULT_TITLE_LENGTH));
  }
  return UNTITLED;
}

/**
 * The title the user typed, made fit to store: white space trimmed, at most 200 code points.
 * Undefined when nothing is left.
 */
export function cleanTitle(typed: string): string | undefined {
  const trimmed = trimSpace(typed);
  if (trimmed === "") return undefined;
  return trimSpace(takeCodePoints(trimmed, MAX_TITLE_LENGTH));
}

/** `base` without its last extension (a dot that does not start the name). */
function withoutExtension(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The name of a text that was opened from a file: the file's name without its extension.
 * Undefined when nothing is left (a file called `.txt`, say).
 */
export function nameFromFileName(fileName: string): string | undefined {
  const name = trimSpace(withoutExtension(baseName(fileName)));
  return name === "" ? undefined : name;
}

/** The last part of a path written with `/` or `\`. */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * The name a text gets from the path of a downloaded file (the name the user typed in Save As):
 * the file's name without its extension. Undefined when nothing is left.
 */
export function nameFromPath(path: string): string | undefined {
  return nameFromFileName(baseName(path));
}

/**
 * The file name Save and Save As offer to the browser for a text with this name (SPEC section 8):
 * `.txt` is added when the name has no extension. Characters a file name cannot have on common
 * systems become `_`, dots and spaces at the start and end go (the browser refuses `..`), and a
 * very long name is cut. The file name is relative: `downloads.download` refuses paths.
 */
export function downloadFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is replaced
  const safe = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_");
  let cleaned = safe.replace(/^[\s.]+/u, "").replace(/[\s.]+$/u, "");
  if (cleaned === "") cleaned = UNTITLED;
  const extension = EXTENSION.exec(cleaned)?.[0] ?? ".txt";
  const base = EXTENSION.test(cleaned) ? cleaned.slice(0, -extension.length) : cleaned;
  const room = MAX_FILE_NAME_LENGTH - extension.length;
  return `${trimSpace(takeCodePoints(base, room))}${extension}`;
}

/** The text as it is written to a file: line breaks are `\n` in the editor, `\r\n` for CRLF. */
export function withLineEnding(text: string, ending: LineEnding): string {
  return ending === "crlf" ? text.replace(/\n/g, "\r\n") : text;
}
