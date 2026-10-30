import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import { BrowserLinkOpener } from "./links";

interface Created {
  url?: string;
  index?: number;
}

function fakeApi(current: { index: number } | undefined, failCreate = false) {
  const created: Created[] = [];
  const api = {
    tabs: {
      getCurrent: () => Promise.resolve(current),
      create: (properties: Created) => {
        if (failCreate) return Promise.reject(new Error("no"));
        created.push(properties);
        return Promise.resolve({});
      },
    },
  } as unknown as typeof browser;
  return { api, created };
}

describe("BrowserLinkOpener", () => {
  it.each([
    {
      name: "next to the current tab",
      current: { index: 3 },
      expected: { url: "https://a.example/", index: 4 },
    },
    {
      name: "at the start",
      current: { index: 0 },
      expected: { url: "https://a.example/", index: 1 },
    },
    {
      name: "wherever the browser puts it when there is no current tab",
      current: undefined,
      expected: { url: "https://a.example/" },
    },
  ])("opens the address $name", async ({ current, expected }) => {
    const { api, created } = fakeApi(current);
    await new BrowserLinkOpener(api).open("https://a.example/");
    expect(created).toEqual([expected]);
  });

  it("fails with LinkOpenFailed when the tab cannot be made", async () => {
    const { api } = fakeApi({ index: 0 }, true);
    const err = await new BrowserLinkOpener(api)
      .open("https://a.example/")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("BrowserLinkOpener.open->LinkOpenFailed")).toBe(true);
  });
});
