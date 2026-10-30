import { describe, expect, it } from "vitest";
import { BrowserHostPermissions, originPattern } from "./permissions";

describe("originPattern", () => {
  it.each([
    { url: "http://localhost:11434", expected: "http://localhost:11434/*" },
    { url: "https://api.anthropic.com", expected: "https://api.anthropic.com/*" },
    { url: "https://api.example.com/v1/", expected: "https://api.example.com/*" },
    { url: "https://api.example.com:443/v1", expected: "https://api.example.com/*" },
    {
      url: "http://127.0.0.1:1234/v1",
      expected: "http://127.0.0.1:1234/*",
    },
    { url: "http://[::1]:8080", expected: "http://[::1]:8080/*" },
    { url: "ftp://example.com", expected: undefined },
    { url: "localhost:11434", expected: undefined },
    { url: "", expected: undefined },
  ])("$url", ({ url, expected }) => {
    expect(originPattern(url)).toBe(expected);
  });
});

/** The part of `browser.permissions` the wrapper calls, recording what it was given. */
function fakeApi(answer: boolean) {
  const calls: { method: string; origins: string[] }[] = [];
  const record = (method: string) => (permissions: { origins?: string[] }) => {
    calls.push({ method, origins: permissions.origins ?? [] });
    return Promise.resolve(answer);
  };
  const api = {
    permissions: {
      contains: record("contains"),
      request: record("request"),
      remove: record("remove"),
    },
  } as unknown as typeof browser;
  return { api, calls };
}

describe("BrowserHostPermissions", () => {
  it.each([
    { method: "contains", answer: true },
    { method: "contains", answer: false },
    { method: "request", answer: true },
    { method: "request", answer: false },
    { method: "remove", answer: true },
    { method: "remove", answer: false },
  ] as const)(
    "$method passes the origin pattern and returns $answer",
    async ({ method, answer }) => {
      const { api, calls } = fakeApi(answer);
      const permissions = new BrowserHostPermissions(api);
      expect(await permissions[method]("http://localhost:11434/")).toBe(answer);
      expect(calls).toEqual([{ method, origins: ["http://localhost:11434/*"] }]);
    },
  );

  it.each(["contains", "request", "remove"] as const)(
    "%s does not call the browser for a bad address",
    async (method) => {
      const { api, calls } = fakeApi(true);
      expect(await new BrowserHostPermissions(api)[method]("nope")).toBe(false);
      expect(calls).toEqual([]);
    },
  );

  it("request calls the browser in the same turn, before any await", () => {
    const { api, calls } = fakeApi(true);
    void new BrowserHostPermissions(api).request("https://api.example.com/v1");
    expect(calls).toHaveLength(1);
  });
});
