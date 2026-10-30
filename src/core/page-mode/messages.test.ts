import { describe, expect, it } from "vitest";
import {
  MAX_HANDOFF_CHARS,
  messageType,
  parseBroadcast,
  parseConfigRequest,
  parseOpenTutorRequest,
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
