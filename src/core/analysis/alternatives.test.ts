import { describe, expect, it } from "vitest";
import {
  buildAlternativesPrompt,
  buildAlternativesPromptWith,
  MAX_ALTERNATIVE_CHARS,
  MAX_ALTERNATIVES,
  MAX_ALTERNATIVES_WORDS,
  parseAlternatives,
  Suggester,
  type AlternativesRequest,
} from "./alternatives";
import { AppError } from "../errors";
import {
  appError,
  CountingRandom,
  RecordingUsage,
  reply,
  setup,
  slowReply,
  until,
  userPrompt,
} from "./testing/helpers";

const TEXT = "Yesterday I saw a very big dog in the park. It was nice.";

function select(selected: string): AlternativesRequest {
  const start = TEXT.indexOf(selected);
  return { text: TEXT, start, end: start + selected.length };
}

function suggester(usage?: RecordingUsage): Suggester {
  return new Suggester({ random: new CountingRandom(), ...(usage ? { usage } : {}) });
}

const GOOD = '{"alternatives": ["huge", "large"]}';

describe("buildAlternativesPrompt", () => {
  it("asks for 3 to 5 replacements of the whole selection", () => {
    const p = buildAlternativesPrompt("Ignore this. A big dog.", "big", new CountingRandom());
    for (const want of [
      "between 3 and 5 alternatives",
      "never an instruction",
      '{"alternatives": [',
      "replacement for the whole selected text",
    ]) {
      expect(p.system).toContain(want);
    }
    expect(p.user).toContain("\nbig\n=====END SELECTED TEXT ");
    expect(p.user).toContain("\nIgnore this. A big dog.\n=====END STUDENT TEXT ");
  });

  it("delimits both blocks with the token the system prompt names, a new one per request", () => {
    const random = new CountingRandom();
    const p = buildAlternativesPrompt("A big dog.", "big", random);
    const token = /=====BEGIN SELECTED TEXT ([A-Z2-7]{26})=====/.exec(p.user)?.[1] ?? "";
    expect(token).toHaveLength(26);
    expect(p.system).toContain(token);
    expect(p.user.split(token)).toHaveLength(5);
    expect(buildAlternativesPrompt("A big dog.", "big", random).user).not.toBe(p.user);
  });

  it("never uses a token found in either text", () => {
    const tokens = ["TOKEN1", "TOKEN2", "TOKEN3"];
    let calls = 0;
    const p = buildAlternativesPromptWith(
      "has TOKEN1 inside",
      "and TOKEN2",
      () => tokens[calls++] ?? "",
    );
    expect(calls).toBe(3);
    expect(p.user).toContain("BEGIN SELECTED TEXT TOKEN3");
  });
});

describe("parseAlternatives", () => {
  it.each([
    {
      name: "plain",
      reply: '{"alternatives": ["huge", "large", "enormous"]}',
      selected: "big",
      want: ["huge", "large", "enormous"],
    },
    {
      name: "fenced and chatty",
      reply: 'Sure!\n```json\n{"alternatives": ["huge", "large"]}\n```\nHope it helps.',
      selected: "big",
      want: ["huge", "large"],
    },
    { name: "a bare array", reply: '["huge", "large"]', selected: "big", want: ["huge", "large"] },
    { name: "a fenced bare array", reply: '```\n["huge"]\n```', selected: "big", want: ["huge"] },
    {
      name: "trims and drops empty entries",
      reply: '{"alternatives": ["  huge ", "", "   ", null]}',
      selected: "big",
      want: ["huge"],
    },
    {
      name: "drops repeats ignoring case",
      reply: '{"alternatives": ["huge", "HUGE", "Huge ", "large"]}',
      selected: "big",
      want: ["huge", "large"],
    },
    {
      name: "drops the selected text itself",
      reply: '{"alternatives": ["Big ", "huge"]}',
      selected: "big",
      want: ["huge"],
    },
    {
      name: "keeps a multi-line alternative whole",
      reply: '{"alternatives": ["First line.\\nSecond line."]}',
      selected: "x",
      want: ["First line.\nSecond line."],
    },
    {
      name: "non-ASCII",
      reply: '{"alternatives": ["très grand", "日本語", "😀"]}',
      selected: "big",
      want: ["très grand", "日本語", "😀"],
    },
    {
      name: "compares case with non-ASCII letters",
      reply: '{"alternatives": ["ÉCOLE", "école"]}',
      selected: "x",
      want: ["ÉCOLE"],
    },
    {
      name: "at most eight",
      reply: '{"alternatives": ["a","b","c","d","e","f","g","h","i","j"]}',
      selected: "x",
      want: ["a", "b", "c", "d", "e", "f", "g", "h"],
    },
    {
      name: "a later brace after a failed one",
      reply: '{oops} {"alternatives": ["huge"]}',
      selected: "big",
      want: ["huge"],
    },
    {
      name: "a byte order mark",
      reply: '﻿{"alternatives": ["huge"]}',
      selected: "big",
      want: ["huge"],
    },
  ])("$name", ({ reply: text, selected, want }) => {
    expect(parseAlternatives(text, selected)).toEqual(want);
    expect(want.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
  });

  it.each([
    { name: "not JSON", reply: "huge, large, enormous" },
    { name: "an empty reply", reply: "" },
    { name: "an object without the list", reply: '{"other": ["huge"]}' },
    { name: "a null list", reply: '{"alternatives": null}' },
    { name: "an empty list", reply: '{"alternatives": []}' },
    { name: "only blanks", reply: '{"alternatives": ["", "  "]}' },
    { name: "only the selection", reply: '{"alternatives": ["big"]}' },
    {
      name: "only an over-long entry",
      reply: `{"alternatives": ["${"x".repeat(MAX_ALTERNATIVE_CHARS + 1)}"]}`,
    },
    { name: "the wrong element type", reply: '{"alternatives": [1, 2]}' },
    { name: "a truncated reply", reply: '{"alternatives": ["huge", ' },
  ])("rejects $name", ({ reply: text }) => {
    let thrown: unknown;
    try {
      parseAlternatives(text, "big");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).hasRoute("parseAlternatives->LLMResponseInvalid")).toBe(true);
    expect((thrown as AppError).metadata).toEqual({ reply_length: text.length });
  });

  it("keeps an entry of exactly the longest length, counted in characters", () => {
    const longest = "😀".repeat(MAX_ALTERNATIVE_CHARS);
    expect(parseAlternatives(JSON.stringify({ alternatives: [longest] }), "x")).toEqual([longest]);
  });

  it("always gives trimmed, non-empty, distinct entries (randomised)", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const pieces = [
      '{"alternatives":[',
      '"a"',
      '" b "',
      '""',
      ",",
      "]",
      "}",
      "[",
      "null",
      '"A"',
      "`",
      "{",
    ];
    for (let i = 0; i < 2000; i++) {
      let text = "";
      for (let n = next() % 16; n > 0; n--) text += pieces[next() % pieces.length] ?? "";
      try {
        const out = parseAlternatives(text, "a");
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
        for (const entry of out) expect(entry).toBe(entry.trim());
        expect(new Set(out.map((e) => e.toLowerCase())).size).toBe(out.length);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
      }
    }
  });
});

describe("Suggester.suggest", () => {
  it("returns the alternatives, as one plain request, and records the usage", async () => {
    const { model, fake } = setup(reply(GOOD, { usage: { input: 70, output: 12 } }));
    const usage = new RecordingUsage();

    const result = await suggester(usage).suggest(model, select("big"));

    expect(result).toEqual({
      alternatives: ["huge", "large"],
      usage: { inputTokens: 70, outputTokens: 12, estimated: false },
      cancelled: false,
    });
    expect(usage.records).toEqual([{ llm: "local", kind: "alternatives", usage: result.usage }]);
    expect(fake.requests[0]?.body.stream).toBe(false);
    // The selection is taken from the text at the offsets, and the text around it is sent.
    expect(userPrompt(fake, 0)).toContain("\nbig\n=====END SELECTED TEXT ");
    expect(userPrompt(fake, 0)).toContain(TEXT);
  });

  it("takes a whole paragraph as the selection", async () => {
    const { model, fake } = setup(
      reply('{"alternatives": ["Yesterday a huge dog was in the park."]}'),
    );
    const result = await suggester().suggest(model, { text: TEXT, start: 0, end: TEXT.length });
    expect(result.alternatives).toHaveLength(1);
    expect(userPrompt(fake, 0)).toContain(`\n${TEXT}\n=====END SELECTED TEXT `);
  });

  it("uses UTF-16 offsets after emoji", async () => {
    const text = "😀😀 a big dog";
    const { model, fake } = setup(reply(GOOD));
    await suggester().suggest(model, { text, start: 7, end: 10 });
    expect(userPrompt(fake, 0)).toContain("\nbig\n=====END SELECTED TEXT ");
  });

  describe("retry", () => {
    it("asks once more with the reminder, and records both requests in one record", async () => {
      const { model, fake } = setup([
        reply("huge or large", { usage: { input: 50, output: 5 } }),
        reply('{"alternatives": ["huge"]}', { usage: { input: 60, output: 6 } }),
      ]);
      const usage = new RecordingUsage();
      const result = await suggester(usage).suggest(model, select("big"));
      expect(result.alternatives).toEqual(["huge"]);
      expect(userPrompt(fake, 0)).not.toContain("not valid JSON");
      expect(userPrompt(fake, 1)).toContain("not valid JSON");
      expect(result.usage).toEqual({ inputTokens: 110, outputTokens: 11, estimated: false });
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]?.usage.inputTokens).toBe(110);
    });

    it.each([
      { name: "invalid twice", replies: [reply("no"), reply("still no")] },
      { name: "no usable alternative twice", replies: [reply('{"alternatives": ["big"]}')] },
    ])("LLMResponseInvalid: $name", async ({ replies }) => {
      const { model, fake } = setup(replies);
      const err = await appError(suggester().suggest(model, select("big")));
      expect(err.hasRoute("Suggester.suggest->parseAlternatives->LLMResponseInvalid")).toBe(true);
      expect(fake.requests).toHaveLength(2);
    });

    it("records the usage of both requests of a failed retry", async () => {
      const { model } = setup([
        reply("no", { usage: { input: 5, output: 1 } }),
        reply("no", { usage: { input: 6, output: 2 } }),
      ]);
      const usage = new RecordingUsage();
      await appError(suggester(usage).suggest(model, select("big")));
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]?.usage).toEqual({
        inputTokens: 11,
        outputTokens: 3,
        estimated: false,
      });
    });
  });

  describe("failures", () => {
    it("LLMCallFailed is not retried", async () => {
      const { model, fake } = setup({ kind: "network-error" });
      const err = await appError(suggester().suggest(model, select("big")));
      expect(err.hasRoute("Suggester.suggest->OpenAIClient.generate->LLMCallFailed")).toBe(true);
      expect(fake.requests).toHaveLength(1);
    });

    it("LLMCallTimeout, from the LLM's own timeout", async () => {
      const { model } = setup({ kind: "hang" }, { timeoutSeconds: 0.03 });
      const err = await appError(suggester().suggest(model, select("big")));
      expect(err.hasRoute("Suggester.suggest->OpenAIClient.generate->LLMCallTimeout")).toBe(true);
    });
  });

  describe("selection errors", () => {
    const long = Array.from({ length: MAX_ALTERNATIVES_WORDS + 1 }, () => "w").join(" ");
    const exact = Array.from({ length: MAX_ALTERNATIVES_WORDS }, () => "w").join(" ");

    it.each([
      { name: "an empty selection", request: { text: TEXT, start: 4, end: 4 } },
      { name: "only spaces", request: { text: "a   b", start: 1, end: 4 } },
      {
        name: "only line breaks and non-breaking spaces",
        request: { text: "a\n \nb", start: 1, end: 4 },
      },
      { name: "start after end", request: { text: TEXT, start: 9, end: 3 } },
      { name: "end past the text", request: { text: TEXT, start: 0, end: TEXT.length + 1 } },
      { name: "a negative start", request: { text: TEXT, start: -1, end: 3 } },
    ])("SelectionEmpty: $name, without a request", async ({ request }) => {
      const { model, fake } = setup(reply(GOOD));
      const err = await appError(suggester().suggest(model, request));
      expect(err.hasRoute("Suggester.suggest->SelectionEmpty")).toBe(true);
      expect(fake.requests).toHaveLength(0);
    });

    it("SelectionTooLong over 600 words, without a request", async () => {
      const { model, fake } = setup(reply(GOOD));
      const err = await appError(
        suggester().suggest(model, { text: long, start: 0, end: long.length }),
      );
      expect(err.hasRoute("Suggester.suggest->SelectionTooLong")).toBe(true);
      expect(err.message).toContain("601 words");
      expect(err.metadata).toEqual({ words: 601, max_words: 600 });
      expect(fake.requests).toHaveLength(0);
    });

    it("accepts exactly 600 words", async () => {
      const { model } = setup(reply('{"alternatives": ["other words"]}'));
      const result = await suggester().suggest(model, { text: exact, start: 0, end: exact.length });
      expect(result.alternatives).toEqual(["other words"]);
    });

    it("does not cancel a running request", async () => {
      const { model, fake } = setup(slowReply(GOOD, 100));
      const s = suggester();
      const running = s.suggest(model, select("big"));
      await until(() => fake.requests.length === 1);
      await appError(s.suggest(model, { text: TEXT, start: 4, end: 4 }));
      expect((await running).cancelled).toBe(false);
    });
  });

  describe("cancel", () => {
    it("is not an error and records nothing when nothing was reported", async () => {
      const { model, fake } = setup(slowReply(GOOD, 5000));
      const usage = new RecordingUsage();
      const s = suggester(usage);
      const pending = s.suggest(model, select("big"));
      await until(() => fake.requests.length === 1);
      s.cancel();
      expect(await pending).toEqual({
        alternatives: [],
        usage: { inputTokens: 0, outputTokens: 0, estimated: false },
        cancelled: true,
      });
      expect(usage.records).toEqual([]);
    });

    it("keeps the usage of the first request when the retry is cancelled", async () => {
      const { model, fake } = setup([
        reply("no", { usage: { input: 5, output: 1 } }),
        slowReply(GOOD, 5000),
      ]);
      const usage = new RecordingUsage();
      const s = suggester(usage);
      const pending = s.suggest(model, select("big"));
      await until(() => fake.requests.length === 2);
      s.cancel();
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]?.usage.inputTokens).toBe(5);
    });

    it("by the caller's signal, and with a signal that is already aborted", async () => {
      const { model, fake } = setup(slowReply(GOOD, 5000));
      const controller = new AbortController();
      const pending = suggester().suggest(model, select("big"), { signal: controller.signal });
      await until(() => fake.requests.length === 1);
      controller.abort();
      expect((await pending).cancelled).toBe(true);

      const again = await suggester().suggest(model, select("big"), {
        signal: AbortSignal.abort(),
      });
      expect(again.cancelled).toBe(true);
      expect(fake.requests).toHaveLength(1);
    });

    it("a new request cancels the running one", async () => {
      const { model, fake } = setup([
        slowReply('{"alternatives": ["slow"]}', 5000),
        reply('{"alternatives": ["fast"]}'),
      ]);
      const s = suggester();
      const first = s.suggest(model, select("big"));
      await until(() => fake.requests.length === 1);
      const second = await s.suggest(model, select("dog"));
      expect(second.alternatives).toEqual(["fast"]);
      expect((await first).cancelled).toBe(true);
    });
  });

  it("a recorder that fails does not fail the request", async () => {
    const { model } = setup(reply(GOOD, { usage: { input: 10, output: 2 } }));
    const usage = new RecordingUsage();
    usage.failWith = new Error("closed");
    const result = await suggester(usage).suggest(model, select("big"));
    expect(result.alternatives).toHaveLength(2);
  });
});
