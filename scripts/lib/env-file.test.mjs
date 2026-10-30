import { describe, expect, it } from "vitest";
import { AMO_KEYS_URL, loadAmoKeys, parseEnv } from "./env-file.mjs";

describe.each([
  ["plain", "A=1\nB=two", { A: "1", B: "two" }],
  ["spaces around =", "A = 1", { A: "1" }],
  ["double quotes", 'A="x y"', { A: "x y" }],
  ["single quotes keep backslashes", "A='x\\ny'", { A: "x\\ny" }],
  ["escapes in double quotes", 'A="x\\ny\\"z\\\\"', { A: 'x\ny"z\\' }],
  ["export prefix", "export A=1", { A: "1" }],
  ["comments and blank lines", "# note\n\nA=1\n  # more\n", { A: "1" }],
  ["comment after an unquoted value", "A=1 # why", { A: "1" }],
  ["hash inside a value", "A=a#b", { A: "a#b" }],
  ["hash inside quotes", 'A="a # b" # c', { A: "a # b" }],
  ["empty value", "A=\nB=''", { A: "", B: "" }],
  ["CRLF", "A=1\r\nB=2\r\n", { A: "1", B: "2" }],
  ["value with =", "A=b=c", { A: "b=c" }],
  ["unterminated quote is kept as text", 'A="abc', { A: '"abc' }],
  ["lines that are not KEY=value", "hello\n=x\n1A=2\nA=1", { A: "1" }],
  ["last duplicate wins", "A=1\nA=2", { A: "2" }],
])("parseEnv: %s", (_name, text, expected) => {
  it("parses", () => {
    expect(parseEnv(text)).toEqual(expected);
  });
});

describe.each([
  ["both in the environment", { WEB_EXT_API_KEY: "k", WEB_EXT_API_SECRET: "s" }, null, "k", "s"],
  [
    "the environment wins over the file",
    { WEB_EXT_API_KEY: "k", WEB_EXT_API_SECRET: "s" },
    "WEB_EXT_API_KEY=f1\nWEB_EXT_API_SECRET=f2",
    "k",
    "s",
  ],
  [
    "both from the file",
    {},
    'WEB_EXT_API_KEY="user:1:2"\nWEB_EXT_API_SECRET=abc',
    "user:1:2",
    "abc",
  ],
  ["one from each", { WEB_EXT_API_SECRET: "s" }, "WEB_EXT_API_KEY=fromfile", "fromfile", "s"],
  [
    "an empty variable falls back to the file",
    { WEB_EXT_API_KEY: "", WEB_EXT_API_SECRET: "s" },
    "WEB_EXT_API_KEY=fromfile",
    "fromfile",
    "s",
  ],
])("loadAmoKeys: %s", (_name, env, file, key, secret) => {
  it("finds the key", async () => {
    expect(await loadAmoKeys(env, () => Promise.resolve(file))).toEqual({ key, secret });
  });
});

describe("loadAmoKeys without a complete key", () => {
  it.each([
    ["no file, nothing in the environment", {}, null],
    ["a file without the keys", {}, "OTHER=1"],
    ["only the key", { WEB_EXT_API_KEY: "k" }, null],
    ["only the secret in the file", {}, "WEB_EXT_API_SECRET=s"],
  ])("%s", async (_name, env, file) => {
    const err = await loadAmoKeys(env, () => Promise.resolve(file)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(AMO_KEYS_URL);
  });

  it("never puts a value in the message", async () => {
    const err = await loadAmoKeys({ WEB_EXT_API_KEY: "sekrit-key" }, () =>
      Promise.resolve(null),
    ).catch((e) => e);
    expect(err.message).not.toContain("sekrit-key");
  });
});
