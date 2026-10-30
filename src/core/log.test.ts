import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { Logger, type LogFields, type LogLevel } from "./log";

interface Line {
  level: LogLevel;
  message: string;
  fields: LogFields | undefined;
}

function fakeSink(): { lines: Line[]; logger: Logger } {
  const lines: Line[] = [];
  const entry = (level: LogLevel) => (message: string, fields?: LogFields) => {
    lines.push({ level, message, fields });
  };
  const logger = new Logger({
    debug: entry("debug"),
    info: entry("info"),
    warn: entry("warn"),
    error: entry("error"),
  });
  return { lines, logger };
}

describe("Logger", () => {
  it.each<LogLevel>(["debug", "info", "warn", "error"])(
    "%s goes to the matching sink method",
    (level) => {
      const { lines, logger } = fakeSink();
      logger[level]("check finished", { ms: 812, inputTokens: 120 });
      expect(lines).toEqual([
        {
          level,
          message: "[english-tutor] check finished",
          fields: { ms: 812, inputTokens: 120 },
        },
      ]);
    },
  );

  it("passes no fields when there are none", () => {
    const { lines, logger } = fakeSink();
    logger.info("started");
    expect(lines[0]?.fields).toBeUndefined();
  });

  describe("err field", () => {
    it("expands an AppError into tag, route, metadata and the cause", () => {
      const { lines, logger } = fakeSink();
      const cause = new TypeError("NetworkError");
      const err = AppError.wrap("LLMCallFailed", cause, { status: 502 }).via("OpenAIClient.chat");
      logger.error("check failed", { err, chunk: 2 });
      expect(lines[0]?.fields).toEqual({
        chunk: 2,
        err: {
          tag: "LLMCallFailed",
          route: "OpenAIClient.chat->LLMCallFailed",
          metadata: { status: 502 },
          cause: { name: "TypeError", message: "NetworkError" },
        },
      });
    });

    it("leaves out the cause of an AppError that has none", () => {
      const { lines, logger } = fakeSink();
      logger.error("not found", {
        err: new AppError("DocumentNotFound", "no such document", { id: 1 }),
      });
      expect(lines[0]?.fields).toEqual({
        err: { tag: "DocumentNotFound", route: "DocumentNotFound", metadata: { id: 1 } },
      });
    });

    it.each([
      {
        name: "an Error",
        err: new RangeError("bad"),
        expected: { name: "RangeError", message: "bad" },
      },
      { name: "a string", err: "boom", expected: { name: "string", message: "" } },
      { name: "undefined", err: undefined, expected: { name: "undefined", message: "" } },
    ])("reduces $name to its name and message", ({ err, expected }) => {
      const { lines, logger } = fakeSink();
      logger.warn("odd", { err });
      expect(lines[0]?.fields).toEqual({ err: expected });
    });

    it("does not copy the stack or the AppError message into the line", () => {
      const { lines, logger } = fakeSink();
      logger.error("failed", { err: new AppError("X", "secret message", {}) });
      expect(JSON.stringify(lines[0])).not.toContain("secret message");
      expect(JSON.stringify(lines[0])).not.toContain("stack");
    });
  });
});
