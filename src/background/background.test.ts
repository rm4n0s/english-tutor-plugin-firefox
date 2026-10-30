import { describe, expect, it } from "vitest";
import { Logger, type LogFields } from "../core/log";
import type { TabOpener } from "../platform/tabs";
import type { ToolbarButton } from "../platform/toolbar-button";
import { startBackground, TUTOR_PAGE } from "./background";

class FakeButton implements ToolbarButton {
  private handler: (() => void) | undefined;

  onClick(handler: () => void): void {
    this.handler = handler;
  }

  click(): void {
    this.handler?.();
  }
}

function setup(open: (path: string) => Promise<void>) {
  const opened: string[] = [];
  const logged: { message: string; fields: LogFields | undefined }[] = [];
  const button = new FakeButton();
  const tabs: TabOpener = {
    open: async (path) => {
      opened.push(path);
      await open(path);
    },
  };
  const record = (message: string, fields?: LogFields) => {
    logged.push({ message, fields });
  };
  const log = new Logger({ debug: record, info: record, warn: record, error: record });
  startBackground(button, tabs, log);
  return { button, opened, logged };
}

describe("startBackground", () => {
  it("opens nothing until the button is clicked", () => {
    const { opened } = setup(() => Promise.resolve());
    expect(opened).toEqual([]);
  });

  it.each([1, 2, 3])(
    "opens the tutor page in a new tab for each of %s click(s)",
    async (clicks) => {
      const { button, opened, logged } = setup(() => Promise.resolve());
      for (let i = 0; i < clicks; i++) button.click();
      await Promise.resolve();
      expect(opened).toEqual(Array.from({ length: clicks }, () => TUTOR_PAGE));
      expect(logged).toEqual([]);
    },
  );

  it("logs a failure to open the tab instead of leaving a rejected promise", async () => {
    const failure = new Error("no window");
    const { button, logged } = setup(() => Promise.reject(failure));
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields).toEqual({ err: { name: "Error", message: "no window" } });
  });
});
