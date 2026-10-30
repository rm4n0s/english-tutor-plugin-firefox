import { AppError } from "./errors";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Flat fields of a log line. The field `err` may hold an error, which is expanded. */
export type LogFields = Readonly<Record<string, unknown>>;

/** Where lines go: the `console` of the page or background script, or a fake in tests. */
export type LogSink = Readonly<Record<LogLevel, (message: string, fields?: LogFields) => void>>;

const PREFIX = "[english-tutor]";

/**
 * Writes to the console (SPEC section 9.1). It logs timings, token counts, sizes and status
 * codes. Callers never pass the user's text, LLM replies, API keys or hand-off contents.
 * No log is stored.
 */
export class Logger {
  private readonly sink: LogSink;

  constructor(sink: LogSink) {
    this.sink = sink;
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields | undefined): void {
    this.sink[level](
      `${PREFIX} ${message}`,
      fields === undefined ? undefined : expandFields(fields),
    );
  }
}

function expandFields(fields: LogFields): LogFields {
  if (!("err" in fields)) return fields;
  return { ...fields, err: describeError(fields.err) };
}

/** An AppError becomes its tag, route, metadata and the cause's name and message. */
export function describeError(err: unknown): unknown {
  if (err instanceof AppError) {
    return {
      tag: err.tag,
      route: err.route(),
      metadata: err.metadata,
      ...(err.cause === undefined ? {} : { cause: describeCause(err.cause) }),
    };
  }
  return describeCause(err);
}

function describeCause(cause: unknown): { name: string; message: string } {
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return { name: typeof cause, message: "" };
}
