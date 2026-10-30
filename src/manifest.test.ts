import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "src", "manifest.json"), "utf8")) as {
  version: string;
  content_scripts: unknown;
  host_permissions: unknown;
  optional_host_permissions: unknown;
  permissions: unknown;
};
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

describe("the manifest (SPEC section 3.2: page mode follows LanguageTool's model)", () => {
  it("declares one static content script for http and https pages, in all frames, also in frames with no address of their own", () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["http://*/*", "https://*/*"],
        js: ["page.js"],
        all_frames: true,
        match_origin_as_fallback: true,
        run_at: "document_end",
      },
    ]);
  });

  it("asks for <all_urls> at installation and for nothing else on websites", () => {
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
    // The optional ones are the origins of LLM servers, asked for at run time.
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  });

  it("has the same API permissions as before: adding one is a spec change", () => {
    expect(manifest.permissions).toEqual([
      "storage",
      "menus",
      "menus.overrideContext",
      "notifications",
      "downloads",
      "scripting",
    ]);
  });

  it("is the same version as package.json", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(pkg.version).toBe("0.3.1");
  });
});
