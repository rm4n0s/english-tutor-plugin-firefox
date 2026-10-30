/** The longest address a link may have. A longer one is shown as plain text. */
export const MAX_LINK_LENGTH = 2048;

/**
 * The address a markdown link may open, or undefined when the target is not a link (SPEC section
 * 5.9). Only `http:` and `https:` addresses with a host are links: relative addresses, `//host`,
 * `javascript:`, `data:`, `file:`, `mailto:` and every other scheme are not. An address with a user
 * name or a password is refused, because the host that people read in it is not the one it opens.
 * The result is the normalised address (`URL.href`), which is also the one the confirmation shows.
 */
export function parseLinkTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (trimmed === "" || trimmed.length > MAX_LINK_LENGTH) return undefined;
  if (!/^https?:\/\/[^/\\?#@]/i.test(trimmed)) return undefined;
  // Control characters and spaces never belong in an address that a person is going to read.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(trimmed)) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "" || url.username !== "" || url.password !== "") return undefined;
  return url.href;
}
