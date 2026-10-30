import { describe, expect, it } from "vitest";
import {
  effectiveBaseUrl,
  isLocalHost,
  pageModeNote,
  parseHttpUrl,
  privacyNote,
  promptServer,
} from "./endpoint";
import type { Provider } from "./provider";

describe("effectiveBaseUrl", () => {
  it.each([
    {
      provider: "openai-compatible",
      base: "https://api.example.com/v1/",
      expected: "https://api.example.com/v1",
    },
    {
      provider: "openai-compatible",
      base: "  http://localhost:8080/v1// ",
      expected: "http://localhost:8080/v1",
    },
    { provider: "ollama", base: "http://localhost:11434", expected: "http://localhost:11434" },
    { provider: "anthropic", base: "", expected: "https://api.anthropic.com" },
    { provider: "anthropic", base: "  ", expected: "https://api.anthropic.com" },
    {
      provider: "anthropic",
      base: "https://proxy.example.com/",
      expected: "https://proxy.example.com",
    },
    { provider: "openai-compatible", base: "", expected: "" },
  ] as const)("$provider $base gives $expected", ({ provider, base, expected }) => {
    expect(effectiveBaseUrl(provider, base)).toBe(expected);
  });
});

describe("parseHttpUrl", () => {
  it.each([
    { value: "http://localhost:11434", ok: true },
    { value: "https://api.openai.com/v1", ok: true },
    { value: " http://[::1]:8080 ", ok: true },
    { value: "ftp://example.com", ok: false },
    { value: "localhost:11434", ok: false },
    { value: "http://", ok: false },
    { value: "", ok: false },
    { value: "javascript:alert(1)", ok: false },
  ])("$value is $ok", ({ value, ok }) => {
    expect(parseHttpUrl(value) !== undefined).toBe(ok);
  });
});

describe("isLocalHost", () => {
  it.each([
    { host: "localhost", local: true },
    { host: "LOCALHOST", local: true },
    { host: "127.0.0.1", local: true },
    { host: "127.1.2.3", local: true },
    { host: "[::1]", local: true },
    { host: "127.0.0.1.example.com", local: false },
    { host: "192.168.1.5", local: false },
    { host: "example.com", local: false },
    { host: "localhost.example.com", local: false },
  ])("$host: $local", ({ host, local }) => {
    expect(isLocalHost(host)).toBe(local);
  });
});

describe("privacyNote", () => {
  it.each([
    {
      name: "a remote server",
      provider: "openai-compatible",
      base: "https://api.example.com/v1",
      expected:
        "The text you write is sent to api.example.com when you check it, ask for an explanation or ask for alternatives.",
    },
    {
      name: "a remote server with a port",
      provider: "ollama",
      base: "http://gpu-box:11434",
      expected:
        "The text you write is sent to gpu-box:11434 when you check it, ask for an explanation or ask for alternatives.",
    },
    {
      name: "Anthropic without a base URL",
      provider: "anthropic",
      base: "",
      expected:
        "The text you write is sent to Anthropic's server (api.anthropic.com) when you check it, ask for an explanation or ask for alternatives.",
    },
    { name: "localhost", provider: "ollama", base: "http://localhost:11434", expected: null },
    {
      name: "127.0.0.1",
      provider: "openai-compatible",
      base: "http://127.0.0.1:1234/v1",
      expected: null,
    },
    { name: "[::1]", provider: "openai-compatible", base: "http://[::1]:1234/v1", expected: null },
    { name: "no address yet", provider: "openai-compatible", base: "", expected: null },
    { name: "a malformed address", provider: "openai-compatible", base: "api.exa", expected: null },
  ] as { name: string; provider: Provider; base: string; expected: string | null }[])(
    "$name",
    ({ provider, base, expected }) => {
      expect(privacyNote(provider, base)).toBe(expected);
    },
  );
});

describe("pageModeNote", () => {
  const subject =
    "English Tutor asks on each site before it reads anything there. What you type on a site you turn on";
  it.each([
    {
      name: "a remote server",
      llm: { provider: "openai-compatible", base_url: "https://api.example.com/v1" },
      expected: `${subject} is sent to api.example.com to be checked.`,
    },
    {
      name: "Anthropic without a base URL",
      llm: { provider: "anthropic", base_url: "" },
      expected: `${subject} is sent to Anthropic's server (api.anthropic.com) to be checked.`,
    },
    {
      name: "a server on this computer",
      llm: { provider: "ollama", base_url: "http://localhost:11434" },
      expected: `${subject} is checked by localhost:11434, on this computer.`,
    },
    {
      name: "a malformed address",
      llm: { provider: "openai-compatible", base_url: "nope" },
      expected: `${subject} is sent to the server of the selected LLM to be checked.`,
    },
    {
      name: "no LLM",
      llm: undefined,
      expected: `${subject} is sent to the server of the selected LLM to be checked. Add an LLM first.`,
    },
  ] as {
    name: string;
    llm: { provider: Provider; base_url: string } | undefined;
    expected: string;
  }[])("$name", ({ llm, expected }) => {
    expect(pageModeNote(llm)).toBe(expected);
  });
});

describe("promptServer", () => {
  it.each([
    {
      name: "a remote server",
      llm: { provider: "openai-compatible", base_url: "https://api.example.com/v1" },
      expected: { server: "api.example.com", local: false },
    },
    {
      name: "a remote server with a port",
      llm: { provider: "openai-compatible", base_url: "http://llm.example.com:8080/v1" },
      expected: { server: "llm.example.com:8080", local: false },
    },
    {
      name: "Anthropic without a base URL",
      llm: { provider: "anthropic", base_url: "" },
      expected: { server: "api.anthropic.com", local: false },
    },
    {
      name: "Ollama on this computer",
      llm: { provider: "ollama", base_url: "http://localhost:11434" },
      expected: { server: "localhost:11434", local: true },
    },
    {
      name: "a server on 127.0.0.1",
      llm: { provider: "openai-compatible", base_url: "http://127.0.0.1:47811/v1" },
      expected: { server: "127.0.0.1:47811", local: true },
    },
    {
      name: "a path and credentials never show",
      llm: {
        provider: "openai-compatible",
        base_url: "https://user:secret@api.example.com/v1/key",
      },
      expected: { server: "api.example.com", local: false },
    },
    {
      name: "a malformed address",
      llm: { provider: "openai-compatible", base_url: "nope" },
      expected: undefined,
    },
  ] as {
    name: string;
    llm: { provider: Provider; base_url: string };
    expected: { server: string; local: boolean } | undefined;
  }[])("$name", ({ llm, expected }) => {
    expect(promptServer(llm)).toEqual(expected);
  });
});
