import { DEFAULT_ANTHROPIC_URL, PROVIDER_LABELS, type Provider } from "./provider";

/**
 * The base URL a request goes to: the typed one without white space and trailing slashes, or the
 * default of Anthropic when an `anthropic` LLM has none (SPEC sections 6.1 and 4.7).
 */
export function effectiveBaseUrl(provider: Provider, baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed === "" && provider === "anthropic" ? DEFAULT_ANTHROPIC_URL : trimmed;
}

/** The parsed address when it is `http://` or `https://` with a host, otherwise undefined. */
export function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** True for `localhost`, `127.x.x.x` and `[::1]`: the text does not leave the computer. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The privacy note of the LLM form (SPEC section 4.7), or null when the server is local or the
 * address is not (yet) a valid one.
 */
export function privacyNote(provider: Provider, baseUrl: string): string | null {
  const url = parseHttpUrl(effectiveBaseUrl(provider, baseUrl));
  if (url === undefined || isLocalHost(url.hostname)) return null;
  const server =
    provider === "anthropic" && baseUrl.trim() === ""
      ? `${PROVIDER_LABELS.anthropic}'s server (${url.host})`
      : url.host;
  return `The text you write is sent to ${server} when you check it, ask for an explanation or ask for alternatives.`;
}
