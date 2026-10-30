import { describe, expect, it } from "vitest";
import { BrowserLifecycle } from "./lifecycle";

describe("BrowserLifecycle", () => {
  it.each(["install", "update", "browser_update", "shared_module_update"])(
    "passes the reason %s of runtime.onInstalled to the handler",
    (reason) => {
      let listener: ((details: { reason: string }) => void) | undefined;
      const api = {
        runtime: {
          onInstalled: {
            addListener: (l: (details: { reason: string }) => void) => {
              listener = l;
            },
          },
        },
      } as unknown as typeof browser;
      const seen: string[] = [];
      new BrowserLifecycle(api).onInstalled((r) => {
        seen.push(r);
      });
      listener?.({ reason });
      expect(seen).toEqual([reason]);
    },
  );
});
