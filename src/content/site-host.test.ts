import { describe, expect, it } from "vitest";
import { siteHostOf } from "./site-host";

/** A window with only what `siteHostOf` reads. */
const win = (hostname: string, origin: string) =>
  ({ location: { hostname }, origin }) as unknown as Window;

describe("siteHostOf: the site a frame belongs to", () => {
  it.each([
    {
      name: "a page",
      hostname: "Mail.Example.com",
      origin: "https://mail.example.com",
      host: "mail.example.com",
    },
    {
      name: "an about:srcdoc frame, by its origin (TinyMCE, CKEditor 4)",
      hostname: "",
      origin: "https://docs.example.com",
      host: "docs.example.com",
    },
    {
      name: "an about:blank frame of a page with a port",
      hostname: "",
      origin: "http://127.0.0.1:47811",
      host: "127.0.0.1",
    },
    {
      name: "a blob: frame",
      hostname: "",
      origin: "https://app.example.com",
      host: "app.example.com",
    },
    { name: "a sandboxed frame (opaque origin)", hostname: "", origin: "null", host: "" },
    {
      name: "an origin that is not a web page",
      hostname: "",
      origin: "moz-extension://abc",
      host: "",
    },
    { name: "an origin that is not an address", hostname: "", origin: "", host: "" },
  ])("is $host for $name", ({ hostname, origin, host }) => {
    expect(siteHostOf(win(hostname, origin))).toBe(host);
  });
});
