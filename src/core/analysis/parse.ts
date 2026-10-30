import { AppError } from "../errors";
import { findList, isObject, stringMember, type JsonObject } from "./json";
import { resolveErrorType, type ErrorType } from "./taxonomy";
import { countCodePoints, takeCodePoints, takeLastCodePoints, trimSpace } from "./text";

/**
 * Limits on what a reply may contribute (SPEC section 5.2), in characters (code points). A model
 * that ignores the contract cannot make the UI show a huge tooltip or keep a huge snippet.
 */
export const MAX_MESSAGE_CHARS = 300;
export const MAX_CONTEXT_CHARS = 200;
export const MAX_SNIPPET_CHARS = 2000;

/** One error reported by the model, validated but not yet placed in the text. */
export interface Issue {
  /** The faulty snippet as the model copied it, trimmed. Never empty. */
  readonly text: string;
  readonly type: ErrorType;
  /** The one-line summary shown as the tooltip. */
  readonly message: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
}

export interface Parsed {
  readonly issues: readonly Issue[];
  /** Entries that were unusable (no text, or a snippet over the limit). */
  readonly dropped: number;
}

/** The message of `LLMResponseInvalid` for a reply that does not fit the contract. */
export const INVALID_REPLY_MESSAGE = "The model's answer was not in the expected format.";

/** Entries of an `issues` list, or `undefined` if one entry has a field of the wrong type. */
function rawIssues(list: readonly unknown[]): JsonObject[] | undefined {
  const out: JsonObject[] = [];
  for (const entry of list) {
    // A null entry decodes to an empty issue, which is then dropped.
    if (entry === null) {
      out.push({});
      continue;
    }
    if (!isObject(entry)) return undefined;
    for (const field of ["text", "error_type", "message", "context_before", "context_after"]) {
      if (stringMember(entry, field) === undefined) return undefined;
    }
    out.push(entry);
  }
  return out;
}

function field(object: JsonObject, name: string): string {
  return stringMember(object, name) ?? "";
}

/**
 * Parses the model's reply. It is tolerant about packaging: markdown code fences and text before
 * or after the JSON are ignored, so is text before a closing `</think>`, and a bare JSON array of
 * issues is accepted. It is strict about content: the JSON must contain an `issues` list. Entries
 * without text are dropped and counted, unknown error types are mapped by `resolveErrorType`, and
 * over-long fields are cut. Anything else throws `LLMResponseInvalid`, with the reply's length and
 * never the reply.
 */
export function parseResponse(reply: string): Parsed {
  const raw = findList(reply, "issues", rawIssues, true);
  if (raw === undefined) {
    throw new AppError("LLMResponseInvalid", INVALID_REPLY_MESSAGE, {
      reply_length: reply.length,
    }).via("parseResponse");
  }
  const issues: Issue[] = [];
  let dropped = 0;
  for (const entry of raw) {
    // Surrounding white space is not part of the faulty snippet, and the locator needs the
    // snippet exactly as it is in the text.
    const text = trimSpace(field(entry, "text"));
    if (text === "" || countCodePoints(text) > MAX_SNIPPET_CHARS) {
      dropped++;
      continue;
    }
    const type = resolveErrorType(field(entry, "error_type"));
    const message = trimSpace(field(entry, "message"));
    issues.push({
      text,
      type,
      message: takeCodePoints(message === "" ? type.label : message, MAX_MESSAGE_CHARS),
      contextBefore: takeLastCodePoints(field(entry, "context_before"), MAX_CONTEXT_CHARS),
      contextAfter: takeCodePoints(field(entry, "context_after"), MAX_CONTEXT_CHARS),
    });
  }
  return { issues, dropped };
}
