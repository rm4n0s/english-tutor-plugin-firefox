import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import type { LLMClient } from "../llm";
import { FakeFetch, type FakeResponse } from "../llm/testing/fake-fetch";
import { Logger, type LogLevel } from "../log";
import { Analyzer } from "./analyzer";
import { fingerprint } from "./fingerprint";
import {
  appError,
  clientOver,
  CountingRandom,
  issuesJson,
  RecordingUsage,
  reply,
  setup,
  slowReply,
  until,
  userPrompt,
} from "./testing/helpers";
import type { AnalysisModel } from "./model";

const ONE_ISSUE = JSON.stringify({
  issues: [{ text: "He go", error_type: "subject_verb_agreement", message: "Use goes." }],
});

const USAGE = { input: 50, output: 10 };

function analyzer(
  extra: { usage?: RecordingUsage; logger?: Logger; chunkWords?: number } = {},
): Analyzer {
  return new Analyzer({ random: new CountingRandom(), ...extra });
}

class Logs {
  readonly lines: { level: LogLevel; message: string; fields: unknown }[] = [];
  readonly logger = new Logger({
    debug: (message, fields) => this.lines.push({ level: "debug", message, fields }),
    info: (message, fields) => this.lines.push({ level: "info", message, fields }),
    warn: (message, fields) => this.lines.push({ level: "warn", message, fields }),
    error: (message, fields) => this.lines.push({ level: "error", message, fields }),
  });
}

/** The text of the user prompt of a request, to answer by what it holds. */
function promptOf(body: Record<string, unknown>): string {
  const messages = body.messages as { content: string }[];
  return messages.map((m) => m.content).join("\n");
}

const FOUR =
  "Quokka go home today.\n\nWombat have a cat.\n\nDingo is happy now.\n\nNumbat was late again.";
const BAD = ["Quokka go", "Wombat have", "Dingo is", "Numbat was"];

/** A fake server that answers each paragraph with its issue, and counts the requests in flight. */
function probe(delayMs: (index: number) => number = () => 20) {
  const fake = new FakeFetch((request): FakeResponse => {
    const prompt = promptOf(request.body);
    const index = BAD.findIndex((bad) => prompt.includes(bad));
    return {
      kind: "json",
      body: JSON.parse(
        JSON.stringify({
          choices: [
            {
              message: { content: issuesJson(...(index < 0 ? [] : [BAD[index] ?? ""])) },
              finish_reason: "stop",
            },
          ],
        }),
      ),
      delayMs: delayMs(index),
    };
  });
  const state = { running: 0, peak: 0 };
  const counting: typeof fetch = async (input, init) => {
    state.running++;
    state.peak = Math.max(state.peak, state.running);
    try {
      return await fake.fetch(input, init);
    } finally {
      state.running--;
    }
  };
  const client: LLMClient = clientOver(counting);
  return {
    fake,
    state,
    model: (overrides: Partial<AnalysisModel> = {}): AnalysisModel => ({
      client,
      name: "local",
      ...overrides,
    }),
  };
}

describe("Analyzer.check", () => {
  it("finds and places issues, and records the usage", async () => {
    const text = "He go home. She have a cat.";
    const { model, fake } = setup(reply(issuesJson("He go", "She have"), { usage: USAGE }));
    const usage = new RecordingUsage();

    const result = await analyzer({ usage }).check(model, text);

    expect(result.cancelled).toBe(false);
    expect(result.chunks).toBe(1);
    expect(result.placed.map((p) => text.slice(p.start, p.end))).toEqual(["He go", "She have"]);
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 10, estimated: false });
    expect(usage.records).toEqual([
      {
        llm: "local",
        kind: "check",
        usage: { inputTokens: 50, outputTokens: 10, estimated: false },
      },
    ]);
    expect(fake.requests).toHaveLength(1);
  });

  it("gives each placed issue its fingerprint", async () => {
    const text = "He go home. He go out.";
    const { model } = setup(reply(ONE_ISSUE_TWICE()));
    const result = await analyzer().check(model, text);
    expect(result.placed).toHaveLength(2);
    expect(result.placed[0]?.fingerprint).toBe(await fingerprint(text, 0, 5));
    expect(result.placed[1]?.fingerprint).toBe(await fingerprint(text, 12, 17));
    expect(result.placed[0]?.fingerprint).not.toBe(result.placed[1]?.fingerprint);
  });

  it("sends each chunk separately and shifts the offsets back into the text", async () => {
    const text = "He go home today.\n\nShe have a cat.\n\nThey is happy.";
    const { model, fake } = setup([
      reply(issuesJson("He go"), { usage: { input: 10, output: 2 } }),
      reply(issuesJson("She have"), { usage: { input: 11, output: 3 } }),
      reply(issuesJson("They is"), { usage: { input: 12, output: 4 } }),
    ]);
    const usage = new RecordingUsage();

    const result = await analyzer({ usage, chunkWords: 4 }).check(model, text);

    expect(result.chunks).toBe(3);
    expect(result.placed.map((p) => text.slice(p.start, p.end))).toEqual([
      "He go",
      "She have",
      "They is",
    ]);
    expect(result.usage).toEqual({ inputTokens: 33, outputTokens: 9, estimated: false });
    expect(usage.records).toHaveLength(3);
    expect(userPrompt(fake, 0)).not.toContain("They is");
    expect(userPrompt(fake, 2)).toContain("They is");
    expect(userPrompt(fake, 2)).not.toContain("He go");
  });

  it("counts issues that are not in the text, and entries without text", async () => {
    const text = "He go home.";
    const body = JSON.stringify({
      issues: [
        { text: "He go", error_type: "verb_form" },
        { text: "not in the text", error_type: "article" },
        { text: "", error_type: "article" },
      ],
    });
    const result = await analyzer().check(setup(reply(body)).model, text);
    expect(result.placed).toHaveLength(1);
    expect(result.unplaced).toBe(2);
  });

  it("makes no request for a text without words", async () => {
    const { model, fake } = setup(reply(issuesJson()));
    const result = await analyzer().check(model, " \n ");
    expect(result).toMatchObject({ chunks: 0, placed: [], cancelled: false });
    expect(fake.requests).toHaveLength(0);
  });

  describe("retry", () => {
    it("asks again once with the reminder, and sums the usage", async () => {
      const { model, fake } = setup([
        reply("Sorry, I cannot.", { usage: USAGE }),
        reply(ONE_ISSUE, { usage: USAGE }),
      ]);
      const usage = new RecordingUsage();
      const result = await analyzer({ usage }).check(model, "He go home.");
      expect(result.placed).toHaveLength(1);
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, estimated: false });
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]?.usage.inputTokens).toBe(100);
      expect(userPrompt(fake, 0)).not.toContain("not valid JSON");
      expect(userPrompt(fake, 1)).toContain("not valid JSON");
      // The retry is the same request plus the reminder, with the same token.
      expect(userPrompt(fake, 1).startsWith(userPrompt(fake, 0))).toBe(true);
    });

    it("fails with LLMResponseInvalid after the second invalid reply, with both requests in one record", async () => {
      const { model, fake } = setup([
        reply("nope", { usage: { input: 5, output: 5 } }),
        reply("still nope", { usage: { input: 5, output: 5 } }),
      ]);
      const usage = new RecordingUsage();
      const err = await appError(analyzer({ usage }).check(model, "He go home."));
      expect(err.hasRoute("Analyzer.check->parseResponse->LLMResponseInvalid")).toBe(true);
      expect(fake.requests).toHaveLength(2);
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]?.usage).toEqual({
        inputTokens: 10,
        outputTokens: 10,
        estimated: false,
      });
    });

    it("does not retry an error of the request", async () => {
      const { model, fake } = setup({ kind: "network-error" });
      const err = await appError(analyzer().check(model, "He go home."));
      expect(err.hasRoute("Analyzer.check->OpenAIClient.generate->LLMCallFailed")).toBe(true);
      expect(fake.requests).toHaveLength(1);
    });

    it("records the first request's usage when the retry fails", async () => {
      const { model } = setup([reply("nope", { usage: USAGE }), { kind: "network-error" }]);
      const usage = new RecordingUsage();
      const err = await appError(analyzer({ usage }).check(model, "He go home."));
      expect(err.hasRoute("Analyzer.check->OpenAIClient.generate->LLMCallFailed")).toBe(true);
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]?.usage.inputTokens).toBe(50);
    });
  });

  describe("failures", () => {
    it("LLMCallFailed from the llm layer, with the route of the analyzer in front", async () => {
      const err = await appError(
        analyzer().check(setup({ kind: "network-error" }).model, "He go home."),
      );
      expect(err.hasRoute("Analyzer.check->OpenAIClient.generate->LLMCallFailed")).toBe(true);
      expect(err.message).toContain("local");
    });

    it("LLMCallFailed for an HTTP error", async () => {
      const { model } = setup({ kind: "json", status: 500, body: { error: { message: "boom" } } });
      const err = await appError(analyzer().check(model, "He go home."));
      expect(err.hasRoute("Analyzer.check->OpenAIClient.generate->LLMCallFailed")).toBe(true);
      expect(err.metadata).toMatchObject({ status: 500 });
    });

    it("LLMCallTimeout, from the LLM's own timeout", async () => {
      const { model } = setup({ kind: "hang" }, { timeoutSeconds: 0.03 });
      const usage = new RecordingUsage();
      const err = await appError(analyzer({ usage }).check(model, "He go home."));
      expect(err.hasRoute("Analyzer.check->OpenAIClient.generate->LLMCallTimeout")).toBe(true);
      expect(err.message).toContain("took longer");
      expect(usage.records).toEqual([]);
    });

    it("HostPermissionDenied is not hidden", async () => {
      const fake = new FakeFetch(reply(issuesJson()));
      const client = clientOver(fake.fetch, false);
      const err = await appError(analyzer().check({ client, name: "x" }, "He go home."));
      expect(err.hasRoute("Analyzer.check->OpenAIClient.generate->HostPermissionDenied")).toBe(
        true,
      );
      expect(fake.requests).toHaveLength(0);
    });

    it.each([
      { name: "stopped normally", stop: "stop", cutOff: false },
      { name: "the provider does not say", stop: "", cutOff: false },
      { name: "output limit of OpenAI-compatible servers", stop: "length", cutOff: true },
      { name: "output limit of Anthropic", stop: "max_tokens", cutOff: true },
    ])("an invalid reply explains itself: $name", async ({ stop, cutOff }) => {
      const truncated = '{"issues":[{"text":"He go","err';
      const { model } = setup(reply(truncated, { stopReason: stop }));
      const err = await appError(analyzer().check(model, "He go home."));
      expect(err.hasRoute("Analyzer.check->parseResponse->LLMResponseInvalid")).toBe(true);
      expect(err.metadata).toEqual({ reply_length: truncated.length, stop_reason: stop });
      expect(err.message.includes("cut off")).toBe(cutOff);
      expect(`${err.message} ${JSON.stringify(err.metadata)}`).not.toContain("He go");
    });
  });

  describe("cancel", () => {
    it("is not an error, records nothing when nothing was reported, and logs only info", async () => {
      const { model, fake } = setup(slowReply(ONE_ISSUE, 5000));
      const usage = new RecordingUsage();
      const logs = new Logs();
      const a = analyzer({ usage, logger: logs.logger });
      const pending = a.check(model, "He go home.");
      await until(() => fake.requests.length === 1);
      a.cancel();
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(result.placed).toEqual([]);
      expect(usage.records).toEqual([]);
      expect(logs.lines.filter((l) => l.level === "warn" || l.level === "error")).toEqual([]);
      a.cancel(); // nothing running: harmless
    });

    it("by the signal of the caller", async () => {
      const { model, fake } = setup(slowReply(ONE_ISSUE, 5000));
      const controller = new AbortController();
      const pending = analyzer().check(model, "He go home.", { signal: controller.signal });
      await until(() => fake.requests.length === 1);
      controller.abort();
      expect((await pending).cancelled).toBe(true);
    });

    it("with a signal that is already aborted sends nothing", async () => {
      const { model, fake } = setup(reply(ONE_ISSUE));
      const result = await analyzer().check(model, "He go home.", { signal: AbortSignal.abort() });
      expect(result.cancelled).toBe(true);
      expect(fake.requests).toHaveLength(0);
    });

    it("a new check cancels the previous one", async () => {
      const { model, fake } = setup([
        slowReply(issuesJson("He go"), 5000),
        reply(issuesJson("She have")),
      ]);
      const a = analyzer();
      const first = a.check(model, "He go home.");
      await until(() => fake.requests.length === 1);
      const second = await a.check(model, "She have a cat.");
      expect(second.cancelled).toBe(false);
      expect(second.placed).toHaveLength(1);
      expect((await first).cancelled).toBe(true);
    });

    it("a timeout is not a cancel", async () => {
      const { model } = setup({ kind: "hang" }, { timeoutSeconds: 0.02 });
      const a = analyzer();
      const err = await appError(a.check(model, "He go home."));
      expect(err.tag).toBe("LLMCallTimeout");
    });
  });

  describe("parallel requests", () => {
    it.each([
      { name: "the default is one at a time", parallel: undefined, peak: 1 },
      { name: "one", parallel: 1, peak: 1 },
      { name: "two", parallel: 2, peak: 2 },
      { name: "the limit is respected", parallel: 3, peak: 3 },
      { name: "more than chunks", parallel: 8, peak: 4 },
    ])("$name", async ({ parallel, peak }) => {
      const server = probe();
      const model = server.model(parallel === undefined ? {} : { parallel });
      const result = await analyzer({ chunkWords: 4 }).check(model, FOUR);
      expect(result.chunks).toBe(4);
      expect(result.placed.map((p) => FOUR.slice(p.start, p.end))).toEqual(BAD);
      expect(server.state.peak).toBe(peak);
    });

    it("merges in text order whatever order the requests finished in", async () => {
      // The first paragraph answers last.
      const server = probe((index) => (4 - index) * 30);
      const result = await analyzer({ chunkWords: 4 }).check(server.model({ parallel: 4 }), FOUR);
      expect(result.placed.map((p) => FOUR.slice(p.start, p.end))).toEqual(BAD);
    });

    it("spreads a short text over the parallel requests, in pieces of at least 200 words", async () => {
      const text = Array.from(
        { length: 5 },
        (_, i) => `${"word ".repeat(150)}end${String(i)}.`,
      ).join("\n\n");
      const server = probe();
      const result = await analyzer().check(server.model({ parallel: 4 }), text);
      // 755 words over 4 requests is 189, which is raised to 200: two paragraphs (302 words) do not fit.
      expect(result.chunks).toBe(5);
      const one = await analyzer().check(probe().model({ parallel: 1 }), text);
      expect(one.chunks).toBe(1);
    });

    it("the first failure cancels the others and is the error reported", async () => {
      // The second paragraph fails at once; the others would take 5 s.
      const fake = new FakeFetch((request): FakeResponse =>
        promptOf(request.body).includes("Wombat have")
          ? { kind: "network-error" }
          : slowReply(issuesJson(), 5000),
      );
      const client = clientOver(fake.fetch);
      const started = Date.now();
      const result = analyzer({ chunkWords: 4 }).check(
        { client, name: "local", parallel: 4 },
        FOUR,
      );
      const err = await appError(result);
      expect(err.hasRoute("Analyzer.check->OpenAIClient.generate->LLMCallFailed")).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("a timeout on one chunk is the error, not the cancel of the others", async () => {
      const { model } = setup({ kind: "hang" }, { parallel: 4, timeoutSeconds: 0.03 });
      const err = await appError(analyzer({ chunkWords: 4 }).check(model, FOUR));
      expect(err.hasRoute("Analyzer.check->OpenAIClient.generate->LLMCallTimeout")).toBe(true);
    });

    it("cancel ends all the requests", async () => {
      const server = probe(() => 5000);
      const a = analyzer({ chunkWords: 4 });
      const pending = a.check(server.model({ parallel: 4 }), FOUR);
      await until(() => server.state.peak === 4);
      a.cancel();
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(result.placed).toEqual([]);
    });

    it("records the usage of a chunk that finished before the check was cancelled", async () => {
      const fake = new FakeFetch((request): FakeResponse =>
        promptOf(request.body).includes("Quokka")
          ? reply(issuesJson(), { usage: USAGE })
          : slowReply(issuesJson(), 5000),
      );
      const client = clientOver(fake.fetch);
      const usage = new RecordingUsage();
      const a = analyzer({ chunkWords: 4, usage });
      const pending = a.check({ client, name: "local", parallel: 2 }, FOUR);
      await until(() => usage.records.length === 1);
      a.cancel();
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(result.usage.inputTokens).toBe(50);
      expect(usage.records).toHaveLength(1);
    });

    it("sums the usage and records one record per chunk", async () => {
      const { model } = setup(reply(issuesJson(), { usage: { input: 10, output: 2 } }), {
        parallel: 4,
      });
      const usage = new RecordingUsage();
      const result = await analyzer({ chunkWords: 4, usage }).check(model, FOUR);
      expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 8, estimated: false });
      expect(usage.records).toHaveLength(4);
    });

    it("marks the total as estimated if any request had to be estimated", async () => {
      const { model } = setup([reply(issuesJson(), { usage: USAGE }), reply(issuesJson())]);
      const result = await analyzer({ chunkWords: 4 }).check(model, "a b c d\n\ne f g h");
      expect(result.usage.estimated).toBe(true);
    });
  });

  describe("checking a selection", () => {
    const full = "He go home. She have a cat. They is here.";

    it("moves the offsets by the base and computes fingerprints in the whole text", async () => {
      const offset = full.indexOf("She have");
      const selected = "She have a cat.";
      const { model } = setup(reply(issuesJson("She have")));

      const result = await analyzer().check(model, selected, {
        selection: { offset, fullText: full },
      });

      expect(result.placed.map((p) => [p.start, p.end])).toEqual([[offset, offset + 8]]);
      expect(full.slice(result.placed[0]?.start, result.placed[0]?.end)).toBe("She have");
      const whole = await analyzer().check(setup(reply(issuesJson("She have"))).model, full);
      expect(result.placed[0]?.fingerprint).toBe(whole.placed[0]?.fingerprint);
    });

    it("counts the not placed issues of the selection only", async () => {
      const { model } = setup(reply(issuesJson("He go", "She have")));
      const result = await analyzer().check(model, "She have a cat.", {
        selection: { offset: 12, fullText: full },
      });
      expect(result.placed).toHaveLength(1);
      expect(result.unplaced).toBe(1);
    });

    it("shifts every chunk of a long selection", async () => {
      const server = probe();
      const result = await analyzer({ chunkWords: 4 }).check(server.model(), FOUR, {
        selection: { offset: 7, fullText: `xxxxxxx${FOUR}` },
      });
      expect(result.placed.map((p) => p.start)).toEqual(BAD.map((b) => FOUR.indexOf(b) + 7));
    });
  });

  describe("usage recorder", () => {
    it("a recorder that fails does not fail the check, and the failure is logged", async () => {
      const usage = new RecordingUsage();
      usage.failWith = new Error("disk full");
      const logs = new Logs();
      const { model } = setup(reply(ONE_ISSUE, { usage: USAGE }));
      const result = await analyzer({ usage, logger: logs.logger }).check(model, "He go home.");
      expect(result.placed).toHaveLength(1);
      expect(
        logs.lines.some(
          (l) => l.level === "warn" && l.message.includes("saving token usage failed"),
        ),
      ).toBe(true);
    });

    it("records estimated usage for a provider that reports none", async () => {
      const usage = new RecordingUsage();
      await analyzer({ usage }).check(setup(reply(ONE_ISSUE)).model, "He go home.");
      expect(usage.records[0]?.usage.estimated).toBe(true);
    });
  });

  it("logs counts and timings, never the text or the reply", async () => {
    const text = "My secret essay about purple elephants go home.";
    const logs = new Logs();
    const { model } = setup(reply(issuesJson("elephants go"), { usage: { input: 5, output: 5 } }));
    await analyzer({ logger: logs.logger }).check(model, text);
    const out = JSON.stringify(logs.lines);
    expect(out).toContain("check finished");
    expect(out).toContain('"input_tokens":5');
    for (const secret of ["purple", "elephants", "essay"]) expect(out).not.toContain(secret);
  });

  it("every error is an AppError", async () => {
    const err = await appError(
      analyzer().check(setup({ kind: "network-error" }).model, "He go home."),
    );
    expect(err).toBeInstanceOf(AppError);
  });
});

function ONE_ISSUE_TWICE(): string {
  return JSON.stringify({
    issues: [
      { text: "He go", error_type: "verb_form", context_before: "", context_after: " home" },
      { text: "He go", error_type: "verb_form", context_before: ". ", context_after: " out" },
    ],
  });
}
