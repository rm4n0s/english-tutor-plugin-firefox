import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { MAX_CONTEXT_CHARS, MAX_MESSAGE_CHARS, MAX_SNIPPET_CHARS, parseResponse } from "./parse";
import { lookupErrorType } from "./taxonomy";
import { countCodePoints } from "./text";

const ONE_ISSUE = `{"issues":[{"text":"He go","error_type":"subject_verb_agreement","message":"Use goes.","context_before":"Yesterday ","context_after":" home"}]}`;

describe("parseResponse", () => {
  it.each([
    { name: "plain object", reply: ONE_ISSUE, texts: ["He go"], types: ["subject_verb_agreement"] },
    { name: "no issues", reply: '{"issues": []}', texts: [], types: [] },
    {
      name: "json fence",
      reply: "```json\n" + ONE_ISSUE + "\n```",
      texts: ["He go"],
      types: ["subject_verb_agreement"],
    },
    {
      name: "plain fence",
      reply: "```\n" + ONE_ISSUE + "\n```\n",
      texts: ["He go"],
      types: ["subject_verb_agreement"],
    },
    {
      name: "prose before and after",
      reply: "Sure, here you go:\n" + ONE_ISSUE + "\nHope this helps!",
      texts: ["He go"],
      types: ["subject_verb_agreement"],
    },
    {
      name: "braces in the prose before",
      reply: "Result {see below}: " + ONE_ISSUE,
      texts: ["He go"],
      types: ["subject_verb_agreement"],
    },
    {
      name: "thinking before the answer",
      reply:
        "<think>Maybe {a}, {b}, {c}, {d}, {e}, {f}, {g}, {h}, {i}. Draft: " +
        '{"issues":[{"text":"draft","error_type":"article"}]}' +
        "</think>\n" +
        ONE_ISSUE,
      texts: ["He go"],
      types: ["subject_verb_agreement"],
    },
    {
      name: "a closing think tag without an opening one",
      reply: 'Hmm {"issues":[{"text":"draft"}]} ok.</think>' + ONE_ISSUE,
      texts: ["He go"],
      types: ["subject_verb_agreement"],
    },
    {
      name: "leading byte order mark",
      reply: "﻿" + ONE_ISSUE,
      texts: ["He go"],
      types: ["subject_verb_agreement"],
    },
    {
      name: "bare array",
      reply: '[{"text":"a b","error_type":"article"}]',
      texts: ["a b"],
      types: ["article"],
    },
    {
      name: "fenced bare array",
      reply: '```json\n[{"text":"a b","error_type":"article"}]\n```',
      texts: ["a b"],
      types: ["article"],
    },
    { name: "empty bare array", reply: "[]", texts: [], types: [] },
    {
      name: "unknown fields are ignored",
      reply: '{"issues":[{"text":"x","error_type":"article","severity":"high"}],"summary":"ok"}',
      texts: ["x"],
      types: ["article"],
    },
    {
      name: "member names in another case",
      reply: '{"Issues":[{"Text":"x","Error_Type":"article"}]}',
      texts: ["x"],
      types: ["article"],
    },
    {
      name: "unknown type becomes other",
      reply: '{"issues":[{"text":"x","error_type":"punctuation"}]}',
      texts: ["x"],
      types: ["syntax_other"],
    },
    {
      name: "missing type becomes grammar_other",
      reply: '{"issues":[{"text":"x"}]}',
      texts: ["x"],
      types: ["grammar_other"],
    },
    {
      name: "empty text is dropped",
      reply:
        '{"issues":[{"text":"","error_type":"article"},{"text":"  ","error_type":"article"},{"text":"ok","error_type":"article"}]}',
      texts: ["ok"],
      types: ["article"],
      dropped: 2,
    },
    {
      name: "null entries and null texts are dropped",
      reply: '{"issues":[null,{"text":null},{"text":"ok"}]}',
      texts: ["ok"],
      types: ["grammar_other"],
      dropped: 2,
    },
    {
      name: "snippet is trimmed",
      reply: '{"issues":[{"text":"  go  ","error_type":"verb_form"}]}',
      texts: ["go"],
      types: ["verb_form"],
    },
    {
      name: "several issues keep order",
      reply:
        '{"issues":[{"text":"a","error_type":"article"},{"text":"b","error_type":"spelling"}]}',
      texts: ["a", "b"],
      types: ["article", "spelling"],
    },
    {
      name: "unicode text",
      reply: '{"issues":[{"text":"café 😀","error_type":"spelling"}]}',
      texts: ["café 😀"],
      types: ["spelling"],
    },
    {
      name: "escaped quotes and braces inside strings",
      reply: 'Here: {"issues":[{"text":"say \\"hi\\" }","error_type":"article"}]} done',
      texts: ['say "hi" }'],
      types: ["article"],
    },
    {
      name: "a later object after a failed one",
      reply: '{oops} {"issues":[{"text":"x","error_type":"article"}]}',
      texts: ["x"],
      types: ["article"],
    },
  ])("$name", ({ reply, texts, types, dropped }) => {
    const parsed = parseResponse(reply);
    expect(parsed.dropped).toBe(dropped ?? 0);
    expect(parsed.issues.map((i) => i.text)).toEqual(texts);
    expect(parsed.issues.map((i) => i.type.id)).toEqual(types);
  });

  it("reads all fields of an issue", () => {
    const issue = parseResponse(ONE_ISSUE).issues[0];
    expect(issue).toMatchObject({
      message: "Use goes.",
      contextBefore: "Yesterday ",
      contextAfter: " home",
    });
    expect(issue?.type.category).toBe("grammar");
  });

  it("replaces lone surrogates, which UTF-8 cannot hold, by U+FFFD", () => {
    const parsed = parseResponse('{"issues":[{"text":"a\\ud800b","error_type":"article"}]}');
    expect(parsed.issues[0]?.text).toBe("a�b");
  });

  describe("limits", () => {
    const long = "é".repeat(1000);
    const emoji = "😀".repeat(1000);

    it("uses the type label for an empty message, and cuts long fields", () => {
      const parsed = parseResponse(
        JSON.stringify({
          issues: [
            {
              text: "x",
              error_type: "spelling",
              message: "",
              context_before: long,
              context_after: long,
            },
            { text: "y", error_type: "spelling", message: long },
          ],
        }),
      );
      expect(parsed.issues[0]?.message).toBe("Spelling");
      expect(countCodePoints(parsed.issues[0]?.contextBefore ?? "")).toBe(MAX_CONTEXT_CHARS);
      expect(countCodePoints(parsed.issues[0]?.contextAfter ?? "")).toBe(MAX_CONTEXT_CHARS);
      expect(countCodePoints(parsed.issues[1]?.message ?? "")).toBe(MAX_MESSAGE_CHARS);
    });

    it("counts characters, not UTF-16 units, and never splits a surrogate pair", () => {
      const parsed = parseResponse(
        JSON.stringify({
          issues: [{ text: "x", message: emoji, context_before: emoji, context_after: emoji }],
        }),
      );
      const issue = parsed.issues[0];
      expect(issue?.message).toBe("😀".repeat(MAX_MESSAGE_CHARS));
      expect(issue?.contextBefore).toBe("😀".repeat(MAX_CONTEXT_CHARS));
      expect(issue?.contextAfter).toBe("😀".repeat(MAX_CONTEXT_CHARS));
    });

    it("keeps the end of context_before and the start of context_after", () => {
      const parsed = parseResponse(
        JSON.stringify({
          issues: [
            {
              text: "x",
              context_before: "a".repeat(300) + "END",
              context_after: "START" + "b".repeat(300),
            },
          ],
        }),
      );
      expect(parsed.issues[0]?.contextBefore.endsWith("END")).toBe(true);
      expect(parsed.issues[0]?.contextAfter.startsWith("START")).toBe(true);
    });

    it.each([
      { name: "just over the limit", chars: MAX_SNIPPET_CHARS + 1, kept: 0, dropped: 1 },
      { name: "exactly the limit", chars: MAX_SNIPPET_CHARS, kept: 1, dropped: 0 },
    ])("a snippet $name", ({ chars, kept, dropped }) => {
      const parsed = parseResponse(
        JSON.stringify({ issues: [{ text: "a".repeat(chars), error_type: "article" }] }),
      );
      expect(parsed.issues).toHaveLength(kept);
      expect(parsed.dropped).toBe(dropped);
    });

    it("counts a snippet of emoji in characters", () => {
      const parsed = parseResponse(
        JSON.stringify({
          issues: [{ text: "😀".repeat(MAX_SNIPPET_CHARS), error_type: "article" }],
        }),
      );
      expect(parsed.issues).toHaveLength(1);
    });
  });

  describe("invalid replies", () => {
    it.each([
      { name: "empty", reply: "" },
      { name: "white space", reply: "  \n " },
      { name: "prose", reply: "I found no errors in your text. Well done!" },
      { name: "truncated json", reply: '{"issues":[{"text":"a","error_type":"article"' },
      { name: "object without issues", reply: '{"errors":[]}' },
      { name: "issues is null", reply: '{"issues": null}' },
      { name: "issues is a string", reply: '{"issues": "none"}' },
      { name: "issues entries of the wrong type", reply: '{"issues": [1, 2]}' },
      { name: "a field of the wrong type", reply: '{"issues": [{"text": 5}]}' },
      { name: "empty object", reply: "{}" },
      { name: "null", reply: "null" },
      { name: "number", reply: "42" },
      { name: "only a fence", reply: "```json\n```" },
      { name: "an array inside another object", reply: '{"result": [{"text":"a"}]}' },
      { name: "a bare array after prose", reply: 'Here: [{"text":"a"}]' },
      { name: "an answer before a closing think tag", reply: `${ONE_ISSUE}</think>` },
      { name: "many braces and no json", reply: "{ ".repeat(10000) },
    ])("$name", ({ reply }) => {
      let thrown: unknown;
      try {
        parseResponse(reply);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      const err = thrown as AppError;
      expect(err.hasRoute("parseResponse->LLMResponseInvalid")).toBe(true);
      expect(err.message).not.toBe("");
      expect(err.metadata).toEqual({ reply_length: reply.length });
    });

    it("never puts the reply in the error", () => {
      const reply = "I found no errors in your text. Well done!";
      try {
        parseResponse(reply);
      } catch (err) {
        const text = JSON.stringify(err instanceof AppError ? [err.message, err.metadata] : "");
        expect(text).not.toContain("found no errors");
      }
    });
  });

  it("only tries a bounded number of braces", () => {
    const started = Date.now();
    expect(() => parseResponse("{".repeat(200000))).toThrow(AppError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("always gives taxonomy types and non-empty text, for any input (randomised)", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const pieces = [
      '{"issues":[',
      '{"text":"',
      '"error_type":"',
      '"',
      "]}",
      "[",
      "]",
      "{",
      "}",
      ",",
      "```",
      "</think>",
      "a",
      "é",
      "😀",
      "\\",
      '\\"',
      ":",
    ];
    for (let i = 0; i < 2000; i++) {
      let reply = "";
      for (let n = next() % 24; n > 0; n--) reply += pieces[next() % pieces.length] ?? "";
      let parsed;
      try {
        parsed = parseResponse(reply);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        continue;
      }
      for (const issue of parsed.issues) {
        expect(issue.text).not.toBe("");
        expect(lookupErrorType(issue.type.id)).toBeDefined();
      }
    }
  });
});
