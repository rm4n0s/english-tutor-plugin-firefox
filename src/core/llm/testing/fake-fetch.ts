/**
 * A fake `fetch` for the tests of the `llm` package (and of the pages that use it). No test calls
 * a real provider. It records every request and answers from a script of canned responses.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** The parsed JSON body. */
  body: Record<string, unknown>;
}

export type FakeResponse =
  /** A JSON body with a status (default 200), after `delayMs`. */
  | { kind: "json"; body: unknown; status?: number; delayMs?: number }
  /** A text body that is not JSON, for example the page of a proxy. */
  | { kind: "text"; body: string; status?: number }
  /**
   * A streamed body: each chunk (text or bytes) is one read, `chunkDelayMs` apart. With
   * `hold: true` the body stays open after the last chunk until the request is aborted.
   */
  | {
      kind: "stream";
      chunks: readonly (string | Uint8Array)[];
      status?: number;
      delayMs?: number;
      chunkDelayMs?: number;
      hold?: boolean;
      /** Ends the body with an error after the chunks, as a dropped connection does. */
      breakAfter?: boolean;
    }
  /** `fetch` rejects with a `TypeError`, as when the server cannot be reached. */
  | { kind: "network-error"; message?: string }
  /** Never answers, until the request is aborted. */
  | { kind: "hang" };

export type FakeScript =
  FakeResponse | readonly FakeResponse[] | ((request: RecordedRequest, n: number) => FakeResponse);

function headerEntries(init: HeadersInit | undefined): [string, string][] {
  if (init === undefined) return [];
  if (init instanceof Headers) return [...init.entries()];
  if (Array.isArray(init)) return init.map(([name, value]) => [name, value]);
  return Object.entries(init);
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Never resolves; rejects when the signal is aborted. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function streamBody(
  response: Extract<FakeResponse, { kind: "stream" }>,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = [...response.chunks];
  let aborted: ((reason: unknown) => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Like a real response body, a stream whose request is aborted errors.
      aborted = (reason) => {
        try {
          controller.error(reason);
        } catch {
          // already closed
        }
      };
      signal?.addEventListener(
        "abort",
        () => {
          aborted?.(abortReason(signal));
        },
        { once: true },
      );
    },
    async pull(controller) {
      if (response.chunkDelayMs) await wait(response.chunkDelayMs, signal);
      const chunk = chunks.shift();
      if (chunk !== undefined) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        return;
      }
      if (response.breakAfter === true) {
        controller.error(new TypeError("network error"));
        return;
      }
      if (response.hold === true) {
        await untilAborted(signal);
        return;
      }
      controller.close();
    },
  });
}

export class FakeFetch {
  readonly requests: RecordedRequest[] = [];
  private readonly script: FakeScript;
  private served = 0;

  constructor(script: FakeScript) {
    this.script = script;
  }

  /** Pass this as the `fetch` of a client. */
  readonly fetch: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) throw abortReason(signal);
    const headers: Record<string, string> = {};
    for (const [name, value] of headerEntries(init?.headers)) headers[name.toLowerCase()] = value;
    const request: RecordedRequest = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    this.requests.push(request);

    const n = this.served++;
    return this.respond(this.responseFor(request, n), signal);
  };

  /** The scripted response for the n-th request; a list repeats its last response. */
  private responseFor(request: RecordedRequest, n: number): FakeResponse {
    const script = this.script;
    if (typeof script === "function") return script(request, n);
    if ("kind" in script) return script;
    const response = script[Math.min(n, script.length - 1)];
    if (response === undefined) throw new Error("the fake fetch has no responses");
    return response;
  }

  private async respond(
    response: FakeResponse,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    switch (response.kind) {
      case "network-error":
        throw new TypeError(response.message ?? "NetworkError when attempting to fetch resource.");
      case "hang":
        return untilAborted(signal);
      case "text":
        return new Response(response.body, { status: response.status ?? 200 });
      case "json":
        if (response.delayMs) await wait(response.delayMs, signal);
        return new Response(JSON.stringify(response.body), {
          status: response.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      case "stream":
        if (response.delayMs) await wait(response.delayMs, signal);
        return new Response(streamBody(response, signal), { status: response.status ?? 200 });
    }
  }
}
