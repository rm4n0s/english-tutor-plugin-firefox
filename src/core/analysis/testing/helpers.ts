import { AppError } from "../../errors";
import { createClient, type ClientConfig, type LLMClient } from "../../llm";
import { openai, type CannedReply } from "../../llm/testing/canned";
import { FakeFetch, type FakeResponse, type FakeScript } from "../../llm/testing/fake-fetch";
import type { Random } from "../../random";
import type { AnalysisModel } from "../model";
import type { UsageRecord, UsageRecorder } from "../usage";

/** A `Random` that counts up, so that every token differs and a test can predict them. */
export class CountingRandom implements Random {
  private n = 0;

  int(maxExclusive: number): number {
    return this.n++ % maxExclusive;
  }

  hex(byteCount: number): string {
    return "00".repeat(byteCount);
  }
}

/** Collects the usage records, and can be told to fail. */
export class RecordingUsage implements UsageRecorder {
  readonly records: UsageRecord[] = [];
  failWith: Error | undefined;

  record(record: UsageRecord): void {
    this.records.push(record);
    if (this.failWith !== undefined) throw this.failWith;
  }
}

/** A reply of the OpenAI-compatible wire format, as the fake server sends it. */
export function reply(content: string, extra: Partial<CannedReply> = {}): FakeResponse {
  return { kind: "json", body: openai.json({ content, ...extra }) };
}

/** `reply` after a delay, for requests that must still be running when a test cancels them. */
export function slowReply(
  content: string,
  delayMs: number,
  extra: Partial<CannedReply> = {},
): FakeResponse {
  return { kind: "json", body: openai.json({ content, ...extra }), delayMs };
}

/** A streamed reply of the OpenAI-compatible wire format, in the given pieces. */
export function streamReply(
  pieces: readonly string[],
  extra: Partial<CannedReply> = {},
): FakeResponse {
  return {
    kind: "stream",
    chunks: [openai.sse({ content: pieces.join(""), pieces, ...extra })],
  };
}

const CONFIG: ClientConfig = {
  provider: "openai-compatible",
  model: "test-model",
  base_url: "https://api.example.com/v1",
  api_key: "",
  temperature: null,
  no_thinking: false,
};

/** A real client over a `fetch`: the analysis code is tested through the whole llm layer. */
export function clientOver(fetchFn: typeof fetch, granted = true): LLMClient {
  return createClient(
    CONFIG,
    { fetch: fetchFn, permissions: { contains: () => Promise.resolve(granted) } },
    { name: "local" },
  );
}

/** A model over a fake server that answers from `script`. */
export function setup(
  script: FakeScript,
  overrides: Partial<Omit<AnalysisModel, "client">> = {},
): { model: AnalysisModel; fake: FakeFetch } {
  const fake = new FakeFetch(script);
  return { model: { client: clientOver(fake.fetch), name: "local", ...overrides }, fake };
}

/** The user message of the n-th request the fake received. */
export function userPrompt(fake: FakeFetch, n: number): string {
  const messages = fake.requests[n]?.body.messages as
    { role: string; content: string }[] | undefined;
  return messages?.find((m) => m.role === "user")?.content ?? "";
}

/** The rejection of a promise, which must be an `AppError`. */
export async function appError(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof AppError)) throw new Error(`expected an AppError, got ${String(err)}`);
  return err;
}

/** Waits until `condition` holds, for tests that cancel a request once the server has it. */
export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition not reached");
}

/** The JSON of a check reply with one issue per text (`verb_form`, message `m`). */
export function issuesJson(...texts: string[]): string {
  return JSON.stringify({
    issues: texts.map((text) => ({ text, error_type: "verb_form", message: "m" })),
  });
}
