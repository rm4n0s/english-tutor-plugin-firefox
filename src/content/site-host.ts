/** The site a frame belongs to, as the host name page mode asks the background script about. */
export function siteHostOf(win: Window): string {
  const direct = win.location.hostname;
  if (direct !== "") return direct.toLowerCase();
  // A frame with no address of its own (`about:blank`, `about:srcdoc`, `blob:`) has the origin of
  // the page that made it. A sandboxed frame has an opaque origin ("null"): it has no site.
  try {
    const origin = new URL(win.origin);
    if (origin.protocol === "http:" || origin.protocol === "https:") {
      return origin.hostname.toLowerCase();
    }
  } catch {
    // "null" is not an address.
  }
  return "";
}
