import { describe, expect, it } from "vitest";
import {
  MAX_HANDOFF_CHARS,
  messageType,
  parseBroadcast,
  parseConfigRequest,
  parseFrameIdRequest,
  parseOpenTutorRequest,
  parseSiteConfig,
  parseSiteRequest,
} from "./messages";

describe("runtime messages of page mode", () => {
  it.each([
    { message: { type: "x" }, expected: "x" },
    { message: { type: 5 }, expected: undefined },
    { message: null, expected: undefined },
    { message: "page-mode-off", expected: undefined },
    { message: {}, expected: undefined },
  ])("messageType of $message", ({ message, expected }) => {
    expect(messageType(message)).toBe(expected);
  });

  it.each([
    { name: "a host", message: { type: "page-mode-config", host: "example.com" }, ok: true },
    { name: "an empty host", message: { type: "page-mode-config", host: "" }, ok: true },
    {
      name: "a host of 253 characters",
      message: { type: "page-mode-config", host: "a".repeat(253) },
      ok: true,
    },
    {
      name: "a host of 254 characters",
      message: { type: "page-mode-config", host: "a".repeat(254) },
      ok: false,
    },
    { name: "no host", message: { type: "page-mode-config" }, ok: false },
    { name: "a number as host", message: { type: "page-mode-config", host: 1 }, ok: false },
    { name: "another type", message: { type: "tutor-ping", host: "x" }, ok: false },
  ])("parseConfigRequest reads $name", ({ message, ok }) => {
    expect(parseConfigRequest(message) !== undefined).toBe(ok);
  });

  it.each([
    { name: "some text", text: "Some text.", ok: true },
    { name: "the longest text", text: "x".repeat(MAX_HANDOFF_CHARS), ok: true },
    { name: "a text one character too long", text: "x".repeat(MAX_HANDOFF_CHARS + 1), ok: false },
    { name: "an empty text", text: "", ok: false },
    { name: "white space", text: " \n\t ", ok: false },
    { name: "a number", text: 5, ok: false },
  ])("parseOpenTutorRequest reads $name", ({ text, ok }) => {
    expect(parseOpenTutorRequest({ type: "page-mode-open-tutor", text }) !== undefined).toBe(ok);
    expect(parseOpenTutorRequest({ type: "other", text: "x" })).toBeUndefined();
  });

  it.each([
    { message: { type: "page-mode-off" }, expected: "page-mode-off" },
    { message: { type: "settings-changed" }, expected: "settings-changed" },
    { message: { type: "tutor-ping" }, expected: undefined },
    { message: { type: "page-mode-apply" }, expected: undefined },
    { message: "settings-changed", expected: undefined },
    { message: undefined, expected: undefined },
  ])("parseBroadcast of $message", ({ message, expected }) => {
    expect(parseBroadcast(message)).toBe(expected);
  });
});

describe("the site messages", () => {
  it.each([
    { name: "on", answer: { state: "on" }, expected: { state: "on" } },
    { name: "off", answer: { state: "off" }, expected: { state: "off" } },
    { name: "later", answer: { state: "later" }, expected: { state: "later" } },
    {
      name: "on with a server it does not need",
      answer: { state: "on", llm: { server: "a.com", local: false } },
      expected: { state: "on" },
    },
    {
      name: "ask without an LLM",
      answer: { state: "ask", llm: null },
      expected: { state: "ask", llm: null },
    },
    {
      name: "ask with no llm field",
      answer: { state: "ask" },
      expected: { state: "ask", llm: null },
    },
    {
      name: "ask with a remote server",
      answer: { state: "ask", llm: { server: "api.example.com", local: false } },
      expected: { state: "ask", llm: { server: "api.example.com", local: false } },
    },
    {
      name: "ask with a local server",
      answer: { state: "ask", llm: { server: "localhost:11434", local: true, key: "x" } },
      expected: { state: "ask", llm: { server: "localhost:11434", local: true } },
    },
    {
      name: "ask with an empty server",
      answer: { state: "ask", llm: { server: "", local: false } },
      expected: undefined,
    },
    {
      name: "ask with a number as server",
      answer: { state: "ask", llm: { server: 5, local: false } },
      expected: undefined,
    },
    {
      name: "ask with no local flag",
      answer: { state: "ask", llm: { server: "a.com" } },
      expected: undefined,
    },
    { name: "ask with a text as llm", answer: { state: "ask", llm: "a.com" }, expected: undefined },
    { name: "an unknown state", answer: { state: "maybe" }, expected: undefined },
    { name: "the old answer of step 13", answer: { enabled: true }, expected: undefined },
    { name: "nothing", answer: undefined, expected: undefined },
    { name: "null", answer: null, expected: undefined },
    { name: "text", answer: "on", expected: undefined },
  ])("parseSiteConfig reads $name", ({ answer, expected }) => {
    expect(parseSiteConfig(answer)).toEqual(expected);
  });

  it.each([
    {
      name: "on",
      message: { type: "page-mode-site", host: "example.com", choice: "on" },
      ok: true,
    },
    {
      name: "off",
      message: { type: "page-mode-site", host: "example.com", choice: "off" },
      ok: true,
    },
    {
      name: "later",
      message: { type: "page-mode-site", host: "example.com", choice: "later" },
      ok: true,
    },
    {
      name: "ask",
      message: { type: "page-mode-site", host: "example.com", choice: "ask" },
      ok: false,
    },
    { name: "no choice", message: { type: "page-mode-site", host: "example.com" }, ok: false },
    {
      name: "an empty host",
      message: { type: "page-mode-site", host: "", choice: "on" },
      ok: false,
    },
    {
      name: "an upper-case host",
      message: { type: "page-mode-site", host: "Example.com", choice: "on" },
      ok: false,
    },
    {
      name: "a host of 254 characters",
      message: { type: "page-mode-site", host: "a".repeat(254), choice: "on" },
      ok: false,
    },
    {
      name: "a number as host",
      message: { type: "page-mode-site", host: 5, choice: "on" },
      ok: false,
    },
    {
      name: "another type",
      message: { type: "page-mode-config", host: "x.com", choice: "on" },
      ok: false,
    },
  ])("parseSiteRequest reads $name", ({ message, ok }) => {
    expect(parseSiteRequest(message) !== undefined).toBe(ok);
  });
});

describe("the frame id messages", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it.each([
    { name: "a register", message: { type: "page-frame-register", id: ID }, ok: true },
    {
      name: "a register with extra fields",
      message: { type: "page-frame-register", id: ID, x: 1 },
      ok: true,
    },
    { name: "a register without an id", message: { type: "page-frame-register" }, ok: false },
    {
      name: "a register with a number as id",
      message: { type: "page-frame-register", id: 5 },
      ok: false,
    },
    {
      name: "a register with a made-up id",
      message: { type: "page-frame-register", id: "abc" },
      ok: false,
    },
    {
      name: "a register with an upper-case id",
      message: { type: "page-frame-register", id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      ok: false,
    },
    { name: "a claim (another type)", message: { type: "page-frame-claim", id: ID }, ok: false },
    { name: "text", message: "page-frame-register", ok: false },
    { name: "null", message: null, ok: false },
  ])("reads $name as a register message: $ok", ({ message, ok }) => {
    expect(parseFrameIdRequest(message, "page-frame-register")).toEqual(
      ok ? { type: "page-frame-register", id: ID } : undefined,
    );
  });

  it.each([
    { name: "a claim", message: { type: "page-frame-claim", id: ID }, ok: true },
    {
      name: "a claim with a made-up id",
      message: { type: "page-frame-claim", id: "../x" },
      ok: false,
    },
    {
      name: "a register (another type)",
      message: { type: "page-frame-register", id: ID },
      ok: false,
    },
  ])("reads $name as a claim message: $ok", ({ message, ok }) => {
    expect(parseFrameIdRequest(message, "page-frame-claim")).toEqual(
      ok ? { type: "page-frame-claim", id: ID } : undefined,
    );
  });
});
