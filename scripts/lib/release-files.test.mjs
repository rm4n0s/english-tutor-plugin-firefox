import { describe, expect, it } from "vitest";
import { releaseFiles } from "./release-files.mjs";
import { UPDATE_URL, sha256Hash, xpiUrl } from "./release.mjs";

const ROOT = "/repo/";
const ID = "english-tutor@rm4n0s.dev";
const manifest = (extra = {}) =>
  JSON.stringify({
    version: "0.2.0",
    browser_specific_settings: {
      gecko: { id: ID, strict_min_version: "140.0", update_url: UPDATE_URL, ...extra },
    },
  });
const FILES = {
  "/repo/src/manifest.json": manifest(),
  "/repo/package.json": JSON.stringify({ version: "0.2.0" }),
  "/repo/package-lock.json": JSON.stringify({
    version: "0.2.0",
    packages: { "": { version: "0.2.0" } },
  }),
  "/repo/docs/INSTALL.md": "# Install\n",
  "/repo/web-ext-artifacts/id-0.2.0.xpi": Buffer.from("signed bytes"),
  "/prev/updates.json": JSON.stringify({
    addons: {
      [ID]: {
        updates: [{ version: "0.1.0", update_link: xpiUrl("0.1.0"), update_hash: "sha256:00" }],
      },
    },
  }),
};

function setup(files = FILES, remote = null) {
  const written = {};
  const logs = [];
  const fetched = [];
  const deps = {
    root: ROOT,
    readBytes: (path) =>
      files[path] === undefined
        ? Promise.reject(new Error("missing"))
        : Promise.resolve(Buffer.from(files[path])),
    readText: (path) => Promise.resolve(typeof files[path] === "string" ? files[path] : null),
    writeFile: (path, data) => {
      written[path] = data;
      return Promise.resolve();
    },
    makeDir: () => Promise.resolve(),
    fetchText: (url) => {
      fetched.push(url);
      return Promise.resolve(remote);
    },
    log: (message) => logs.push(message),
  };
  return { deps, written, logs, fetched };
}

const XPI = "/repo/web-ext-artifacts/id-0.2.0.xpi";

describe("releaseFiles", () => {
  it("writes the xpi, updates.json and the README into release-out/<version>/", async () => {
    const { deps, written, logs, fetched } = setup();
    await releaseFiles([XPI, "--offline"], deps);
    expect(Object.keys(written).sort()).toEqual([
      "/repo/release-out/0.2.0/README.md",
      "/repo/release-out/0.2.0/english-tutor-0.2.0.xpi",
      "/repo/release-out/0.2.0/updates.json",
    ]);
    expect(written["/repo/release-out/0.2.0/README.md"]).toBe("# Install\n");
    expect(written["/repo/release-out/0.2.0/english-tutor-0.2.0.xpi"].toString()).toBe(
      "signed bytes",
    );
    const updates = JSON.parse(written["/repo/release-out/0.2.0/updates.json"]);
    expect(updates.addons[ID].updates).toEqual([
      {
        version: "0.2.0",
        update_link: xpiUrl("0.2.0"),
        update_hash: sha256Hash(Buffer.from("signed bytes")),
        applications: { gecko: { strict_min_version: "140.0" } },
      },
    ]);
    expect(fetched).toEqual([]);
    const text = logs.join("\n");
    expect(text).toContain(
      "gh release create v0.2.0 release-out/0.2.0/english-tutor-0.2.0.xpi --repo rm4n0s/english-tutor-releases",
    );
    expect(text).toContain("push origin main");
  });

  it("merges the entries of a previous updates.json given as a path", async () => {
    const { deps, written } = setup();
    await releaseFiles([XPI, "--previous", "/prev/updates.json"], deps);
    const updates = JSON.parse(written["/repo/release-out/0.2.0/updates.json"]);
    expect(updates.addons[ID].updates.map((u) => u.version)).toEqual(["0.1.0", "0.2.0"]);
    expect(updates.addons[ID].updates[0].update_hash).toBe("sha256:00");
  });

  it.each([
    [
      "the file is there",
      JSON.stringify({ addons: { [ID]: { updates: [{ version: "0.1.5" }] } } }),
      ["0.1.5", "0.2.0"],
    ],
    ["the file is not there yet", null, ["0.2.0"]],
  ])(
    "reads the releases repo's raw address when it is not offline and has no path (%s)",
    async (_name, remote, versions) => {
      const { deps, written, fetched } = setup(FILES, remote);
      await releaseFiles([XPI], deps);
      expect(fetched).toEqual([UPDATE_URL]);
      const updates = JSON.parse(written["/repo/release-out/0.2.0/updates.json"]);
      expect(updates.addons[ID].updates.map((u) => u.version)).toEqual(versions);
    },
  );

  it.each([
    ["no argument", [], FILES, "Usage"],
    ["two files", [XPI, XPI], FILES, "Only one"],
    ["an unknown option", [XPI, "--force"], FILES, "Unknown option"],
    ["--previous without a path", [XPI, "--previous"], FILES, "needs a path"],
    ["a previous file that is missing", [XPI, "--previous", "/nope.json"], FILES, "does not exist"],
    [
      "a previous file that is not JSON",
      [XPI, "--previous", "/prev/bad.json"],
      { ...FILES, "/prev/bad.json": "{" },
      "not valid JSON",
    ],
    [
      "a file for another version",
      ["/repo/web-ext-artifacts/id-0.1.0.xpi", "--offline"],
      FILES,
      "version 0.1.0",
    ],
    ["a file without a version in its name", ["/repo/x.xpi", "--offline"], FILES, "(unknown)"],
    [
      "versions that differ",
      [XPI, "--offline"],
      { ...FILES, "/repo/package.json": JSON.stringify({ version: "0.3.0" }) },
      "differ",
    ],
    [
      "a manifest with another update_url",
      [XPI, "--offline"],
      {
        ...FILES,
        "/repo/src/manifest.json": manifest({ update_url: "https://example.com/u.json" }),
      },
      "update_url",
    ],
    [
      "no INSTALL.md",
      [XPI, "--offline"],
      { ...FILES, "/repo/docs/INSTALL.md": undefined },
      "INSTALL.md is missing",
    ],
  ])("fails on %s and writes nothing", async (_name, args, files, message) => {
    const { deps, written } = setup(files);
    const err = await releaseFiles(args, deps).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(message);
    expect(written).toEqual({});
  });
});
