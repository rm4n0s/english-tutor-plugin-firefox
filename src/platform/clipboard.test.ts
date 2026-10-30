import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import { BrowserClipboard } from "./clipboard";

describe("BrowserClipboard", () => {
  it("writes the text to the clipboard", async () => {
    const written: string[] = [];
    const nav = {
      clipboard: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    } as unknown as Navigator;
    await new BrowserClipboard(nav).writeText("take a photo");
    expect(written).toEqual(["take a photo"]);
  });

  it.each([
    { name: "a rejected promise", fail: () => Promise.reject(new DOMException("denied")) },
    {
      name: "a throw",
      fail: () => {
        throw new TypeError("no clipboard");
      },
    },
  ])("fails with ClipboardWriteFailed after $name, without the text", async ({ fail }) => {
    const nav = { clipboard: { writeText: fail } } as unknown as Navigator;
    const err = await new BrowserClipboard(nav).writeText("secret words").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("BrowserClipboard.writeText->ClipboardWriteFailed")).toBe(
      true,
    );
    expect(JSON.stringify((err as AppError).metadata)).not.toContain("secret");
    expect((err as AppError).message).not.toContain("secret");
  });
});
