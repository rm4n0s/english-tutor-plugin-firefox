/** Tokens one request used (SPEC section 5.8). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** True when the provider reported no counts and they were derived from the text length. */
  estimated: boolean;
}

/** What a provider reported, before the fallback to an estimate. */
export interface ReportedUsage {
  inputTokens: number;
  outputTokens: number;
}

const CHARACTERS_PER_TOKEN = 4;

/** About one token per 4 characters (code points), rounded up. */
export function estimateTokens(text: string): number {
  // Code points, not UTF-16 units: an emoji is one character.
  return Math.ceil(Array.from(text).length / CHARACTERS_PER_TOKEN);
}

export function estimateUsage(input: string, output: string): Usage {
  return {
    inputTokens: estimateTokens(input),
    outputTokens: estimateTokens(output),
    estimated: true,
  };
}

/**
 * The reported counts if there are any that are not both zero (servers that do not report usage
 * send zeros), otherwise an estimate from the texts.
 */
export function resolveUsage(
  reported: ReportedUsage | undefined,
  input: string,
  output: string,
): Usage {
  if (reported !== undefined && (reported.inputTokens > 0 || reported.outputTokens > 0)) {
    return { ...reported, estimated: false };
  }
  return estimateUsage(input, output);
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    estimated: a.estimated || b.estimated,
  };
}

/** A non-negative integer count, or undefined for anything else. */
export function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}
