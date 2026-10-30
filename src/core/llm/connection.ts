import type { Clock } from "../clock";
import { AppError } from "../errors";
import { createClient, type ClientConfig, type ClientDeps } from "./client";
import { TEST_TIMEOUT_MS } from "./timeouts";

/** The tiny request of Test connection, the desktop app's prompt (SPEC sections 2.1 and 4.7). */
export const TEST_PROMPT = "Reply with the single word: ok";

export interface TestConnectionDeps extends ClientDeps {
  clock: Clock;
}

export interface TestConnectionOptions {
  /** The LLM's name, used in messages. */
  name?: string;
  signal?: AbortSignal;
  /** Default: 60 seconds (SPEC section 7). The LLM's own *Timeout* does not apply. */
  timeoutMs?: number;
}

/**
 * Sends the test prompt with the given configuration and resolves with the time the LLM took.
 * The tokens are not recorded anywhere: nothing here knows about the store.
 *
 * Failures are `AppError`s with the route `testConnection->...` (`LLMConfigInvalid`,
 * `UnknownProvider`, `HostPermissionDenied`, `LLMCallFailed`, `LLMCallTimeout`). A cancel rejects
 * with the signal's reason, which is not an `AppError` (see `isCancelled`).
 */
export async function testConnection(
  config: ClientConfig,
  deps: TestConnectionDeps,
  options: TestConnectionOptions = {},
): Promise<{ elapsedMs: number }> {
  const { name, signal, timeoutMs = TEST_TIMEOUT_MS } = options;
  try {
    const client = createClient(config, deps, name === undefined ? {} : { name });
    const started = deps.clock.now();
    await client.generate({
      prompt: TEST_PROMPT,
      maxTokens: 4096,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    return { elapsedMs: deps.clock.now() - started };
  } catch (err) {
    throw err instanceof AppError ? err.via("testConnection") : err;
  }
}
