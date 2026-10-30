import { trimSpace, wellFormed } from "./text";

/** How many `{` positions `findObject` tries, so that a reply full of braces cannot make parsing quadratic. */
export const MAX_STARTS = 8;

/** The end (exclusive) of the JSON object or array that starts at `start`, or -1 if it never closes. */
function valueEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s.charAt(i);
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Decodes the first JSON value that starts at `start` and ignores what follows it, like Go's
 * `json.Decoder.Decode`. `undefined` if there is no complete, valid value.
 */
export function decodeAt(s: string, start: number): unknown {
  const end = valueEnd(s, start);
  if (end < 0) return undefined;
  try {
    return JSON.parse(s.slice(start, end)) as unknown;
  } catch {
    return undefined;
  }
}

/** `s` trimmed, and without a surrounding markdown code fence. */
export function stripFences(s: string): string {
  let out = trimSpace(s);
  if (out.startsWith("```")) {
    const newline = out.indexOf("\n");
    out = newline >= 0 ? out.slice(newline + 1) : "";
    out = trimSpace(out);
    if (out.endsWith("```")) out = out.slice(0, -3);
  }
  return trimSpace(out);
}

export type JsonObject = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The member of an object like Go's decoder finds it: the exact name first, else a name that
 * differs only in case.
 */
export function member(object: JsonObject, name: string): unknown {
  if (Object.hasOwn(object, name)) return object[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(object)) {
    if (key.toLowerCase() === wanted) return object[key];
  }
  return undefined;
}

/**
 * Finds the list a reply carries (SPEC section 5.2). It tries the first few `{` as the start of the
 * contract object (`{"<name>": [...]}`), so a reply like "Sure! {...}" still works. A bare array
 * counts only when it is the whole reply (after fences), because an array inside some other object
 * is not the list. The text before the last `</think>` is ignored when `afterThinking` is set.
 * `accept` checks the list's entries and returns `undefined` for a list with a wrong entry.
 */
export function findList<T>(
  reply: string,
  name: string,
  accept: (list: readonly unknown[]) => T | undefined,
  afterThinking: boolean,
): T | undefined {
  let s = reply.startsWith("﻿") ? reply.slice(1) : reply;
  if (afterThinking) {
    const think = s.lastIndexOf("</think>");
    if (think >= 0) s = s.slice(think + "</think>".length);
  }
  let tried = 0;
  for (let start = 0; start < s.length && tried < MAX_STARTS; start++) {
    if (s.charAt(start) !== "{") continue;
    tried++;
    const value = decodeAt(s, start);
    if (isObject(value)) {
      const list = member(value, name);
      if (Array.isArray(list)) {
        const accepted = accept(list as unknown[]);
        if (accepted !== undefined) return accepted;
      }
    }
  }
  const body = stripFences(s);
  if (body.startsWith("[")) {
    const value = decodeAt(body, 0);
    if (Array.isArray(value)) return accept(value as unknown[]);
  }
  return undefined;
}

/** A string member, or `""` for null or missing; `undefined` if it has another type. */
export function stringMember(object: JsonObject, name: string): string | undefined {
  const value = member(object, name);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? wellFormed(value) : undefined;
}
