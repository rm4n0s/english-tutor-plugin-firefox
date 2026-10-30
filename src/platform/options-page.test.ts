import { describe, expect, it } from "vitest";
import { BrowserOptionsOpener } from "./options-page";

describe("BrowserOptionsOpener", () => {
  function setup(failWith?: Error) {
    const calls: unknown[] = [];
    const api = {
      runtime: {
        getURL: (path: string) => `moz-extension://uuid/${path}`,
        openOptionsPage: () => {
          calls.push("openOptionsPage");
          return Promise.resolve();
        },
      },
      tabs: {
        create: (options: unknown) => {
          calls.push(options);
          return failWith === undefined ? Promise.resolve({}) : Promise.reject(failWith);
        },
      },
    } as unknown as typeof browser;
    return { opener: new BrowserOptionsOpener(api), calls };
  }

  it("opens the options page", async () => {
    const t = setup();
    await t.opener.open();
    expect(t.calls).toEqual(["openOptionsPage"]);
  });

  it("opens the welcome page in a new tab, with the fragment that makes the options page show it", async () => {
    const t = setup();
    await t.opener.openWelcome();
    expect(t.calls).toEqual([{ url: "moz-extension://uuid/options.html#welcome" }]);
  });

  it("fails when the tab cannot be made", async () => {
    await expect(setup(new Error("no window")).opener.openWelcome()).rejects.toThrow("no window");
  });
});
