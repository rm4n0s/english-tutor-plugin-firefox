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

/**
 * The note under the "Offer to check text boxes on websites" box of the options page (SPEC
 * sections 4.7 and 4.11): that the extension asks on each site, and where what the user types on
 * a site they turn on goes. A server on this computer keeps it there. Without an LLM it says that
 * an LLM has to be added first.
 */
export function pageModeNote(llm: { provider: Provider; base_url: string } | undefined): string {
  const asks = "English Tutor asks on each site before it reads anything there.";
  const subject = `${asks} What you type on a site you turn on`;
  if (llm === undefined) {
    return `${subject} is sent to the server of the selected LLM to be checked. Add an LLM first.`;
  }
  const url = parseHttpUrl(effectiveBaseUrl(llm.provider, llm.base_url));
  if (url === undefined) {
    return `${subject} is sent to the server of the selected LLM to be checked.`;
  }
  if (isLocalHost(url.hostname)) return `${subject} is checked by ${url.host}, on this computer.`;
  const server =
    llm.provider === "anthropic" && llm.base_url.trim() === ""
      ? `${PROVIDER_LABELS.anthropic}'s server (${url.host})`
      : url.host;
  return `${subject} is sent to ${server} to be checked.`;
}

/**
 * The server of an LLM as the page-mode prompt names it (SPEC section 4.11): the host and port
 * only, and whether it is on this computer. Undefined for an address that is not a valid one.
 */
export function promptServer(llm: {
  provider: Provider;
  base_url: string;
}): { server: string; local: boolean } | undefined {
  const url = parseHttpUrl(effectiveBaseUrl(llm.provider, llm.base_url));
  if (url === undefined) return undefined;
  return { server: url.host, local: isLocalHost(url.hostname) };
}
