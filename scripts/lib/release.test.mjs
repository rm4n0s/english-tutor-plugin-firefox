import { describe, expect, it } from "vitest";
import {
  UPDATE_URL,
  buildSignArgs,
  checkClean,
  checkVersions,
  compareVersions,
  findSignedXpi,
  isValidVersion,
  mergeUpdates,
  parseUpdates,
  releaseCommands,
  sha256Hash,
  versionFromXpiName,
  xpiUrl,
} from "./release.mjs";

const ID = "english-tutor@rm4n0s.dev";
const lock = (top, inner) => ({ version: top, packages: { "": { version: inner } } });

describe.each([
  ["0.2.0", true],
  ["1.10", true],
  ["1.2.3.4", true],
  ["1", false],
  ["01.2", false],
  ["1.2.3.4.5", false],
  ["1.2-beta", false],
  ["", false],
  [undefined, false],
])("isValidVersion(%j)", (version, valid) => {
  it(`is ${valid}`, () => {
    expect(isValidVersion(version)).toBe(valid);
  });
});

describe.each([
  ["0.1.0", "0.2.0", -1],
  ["0.10.0", "0.9.0", 1],
  ["1.0", "1.0.0", 0],
  ["2.0.0", "10.0.0", -1],
])("compareVersions(%s, %s)", (a, b, sign) => {
  it("orders numerically", () => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe("checkVersions", () => {
  it.each([
    [
      "all equal",
      { manifest: { version: "0.2.0" }, pkg: { version: "0.2.0" }, lock: lock("0.2.0", "0.2.0") },
    ],
  ])("%s", (_name, files) => {
    expect(checkVersions(files)).toBe("0.2.0");
  });

  it.each([
    [
      "package.json differs",
      { manifest: { version: "0.2.0" }, pkg: { version: "0.1.0" }, lock: lock("0.2.0", "0.2.0") },
      "package.json",
    ],
    [
      "the lock file's own version differs",
      { manifest: { version: "0.2.0" }, pkg: { version: "0.2.0" }, lock: lock("0.1.0", "0.2.0") },
      "package-lock.json:",
    ],
    [
      "the lock file's root package differs",
      { manifest: { version: "0.2.0" }, pkg: { version: "0.2.0" }, lock: lock("0.2.0", "0.1.0") },
      'packages[""]',
    ],
    [
      "the manifest has a bad version",
      { manifest: { version: "v1" }, pkg: { version: "v1" }, lock: lock("v1", "v1") },
      "no valid version",
    ],
    [
      "the manifest has no version",
      { manifest: {}, pkg: { version: "0.2.0" }, lock: lock("0.2.0", "0.2.0") },
      "no valid version",
    ],
  ])("%s", (_name, files, text) => {
    expect(() => checkVersions(files)).toThrow(text);
  });
});

describe("checkClean", () => {
  it.each([
    ["", true],
    ["\n", true],
    [" M src/manifest.json\n", false],
    ["?? new.txt\n", false],
  ])("porcelain %j", (porcelain, clean) => {
    if (clean) expect(() => checkClean(porcelain)).not.toThrow();
    else expect(() => checkClean(porcelain)).toThrow("not clean");
  });
});

describe("buildSignArgs", () => {
  it("builds the unlisted signing command and holds no key", () => {
    const args = buildSignArgs({
      sourceDir: "/r/dist",
      sourceZip: "/r/web-ext-artifacts/s.zip",
      artifactsDir: "/r/web-ext-artifacts",
    });
    expect(args).toEqual([
      "web-ext",
      "sign",
      "-s",
      "/r/dist",
      "--channel=unlisted",
      "--upload-source-code",
      "/r/web-ext-artifacts/s.zip",
      "--artifacts-dir",
      "/r/web-ext-artifacts",
    ]);
    expect(args.join(" ")).not.toMatch(/api-key|api-secret/i);
  });
});

describe("findSignedXpi", () => {
  const files = [
    { name: "abc-0.1.0.xpi", mtimeMs: 5000 },
    { name: "abc-0.2.0.xpi", mtimeMs: 1000 },
    { name: "def-0.2.0.xpi", mtimeMs: 3000 },
    { name: "english-tutor-0.2.0-source.zip", mtimeMs: 4000 },
    { name: "notes.txt", mtimeMs: 6000 },
  ];
  it.each([
    ["the new file for the version", "0.2.0", 2000, "def-0.2.0.xpi"],
    ["an old file does not count", "0.2.0", 500, "def-0.2.0.xpi"],
    ["another version", "0.1.0", 0, "abc-0.1.0.xpi"],
  ])("%s", (_name, version, since, expected) => {
    expect(findSignedXpi(files, version, since)).toBe(expected);
  });

  it.each([
    ["only older files", "0.2.0", 3500],
    ["no file of that version", "0.3.0", 0],
  ])("fails with %s", (_name, version, since) => {
    expect(() => findSignedXpi(files, version, since)).toThrow("no signed");
  });
});

describe.each([
  ["abc-0.2.0.xpi", "0.2.0"],
  ["{1234-abcd}-1.10.3.xpi", "1.10.3"],
  ["english-tutor-0.2.0.xpi", "0.2.0"],
  ["english-tutor.xpi", null],
  ["abc-0.2.0.zip", null],
])("versionFromXpiName(%s)", (name, version) => {
  it(`is ${version}`, () => {
    expect(versionFromXpiName(name)).toBe(version);
  });
});

describe("sha256Hash", () => {
  it.each([
    ["", "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("hashes %j", (text, hash) => {
    expect(sha256Hash(Buffer.from(text))).toBe(hash);
  });
});

describe("update address", () => {
  it("is a committed file on raw.githubusercontent.com and the xpi is a release asset", () => {
    expect(UPDATE_URL).toBe(
      "https://raw.githubusercontent.com/rm4n0s/english-tutor-releases/main/updates.json",
    );
    expect(xpiUrl("0.2.0")).toBe(
      "https://github.com/rm4n0s/english-tutor-releases/releases/download/v0.2.0/english-tutor-0.2.0.xpi",
    );
  });
});

const entry = (version, hash = "sha256:aa") => ({
  version,
  update_link: xpiUrl(version),
  update_hash: hash,
  applications: { gecko: { strict_min_version: "140.0" } },
});

describe("mergeUpdates", () => {
  const add = (previous, version, hash = "sha256:aa") =>
    mergeUpdates({
      previous,
      id: ID,
      version,
      updateLink: xpiUrl(version),
      updateHash: hash,
      minFirefox: "140.0",
    });

  it.each([
    ["a first release", null, "0.2.0", [entry("0.2.0")]],
    [
      "keeps earlier versions",
      { addons: { [ID]: { updates: [entry("0.2.0")] } } },
      "0.3.0",
      [entry("0.2.0"), entry("0.3.0")],
    ],
    [
      "sorts numerically, not as text",
      { addons: { [ID]: { updates: [entry("0.10.0"), entry("0.2.0")] } } },
      "0.9.0",
      [entry("0.2.0"), entry("0.9.0"), entry("0.10.0")],
    ],
    [
      "replaces the same version",
      { addons: { [ID]: { updates: [entry("0.2.0", "sha256:old")] } } },
      "0.2.0",
      [entry("0.2.0")],
    ],
    ["an empty addons object", { addons: {} }, "0.2.0", [entry("0.2.0")]],
  ])("%s", (_name, previous, version, updates) => {
    expect(add(previous, version).addons[ID].updates).toEqual(updates);
  });

  it("leaves other add-ons and top-level keys alone and does not change its input", () => {
    const previous = {
      addons: { other: { updates: [{ version: "1.0" }] }, [ID]: { updates: [entry("0.2.0")] } },
    };
    const copy = JSON.parse(JSON.stringify(previous));
    const merged = add(previous, "0.3.0");
    expect(merged.addons.other).toEqual(copy.addons.other);
    expect(previous).toEqual(copy);
  });

  it("has the shape Firefox reads", () => {
    expect(add(null, "0.2.0")).toEqual({
      addons: {
        [ID]: {
          updates: [
            {
              version: "0.2.0",
              update_link:
                "https://github.com/rm4n0s/english-tutor-releases/releases/download/v0.2.0/english-tutor-0.2.0.xpi",
              update_hash: "sha256:aa",
              applications: { gecko: { strict_min_version: "140.0" } },
            },
          ],
        },
      },
    });
  });

  it("leaves out applications without a minimum version", () => {
    const merged = mergeUpdates({
      previous: null,
      id: ID,
      version: "0.2.0",
      updateLink: "https://x/y.xpi",
      updateHash: "sha256:aa",
    });
    expect(merged.addons[ID].updates[0]).not.toHaveProperty("applications");
  });
});

describe("parseUpdates", () => {
  it.each([
    ["valid", JSON.stringify({ addons: { [ID]: { updates: [] } } }), null],
    ["valid without this add-on", JSON.stringify({ addons: {} }), null],
    ["not JSON", "{", "not valid JSON"],
    ["no addons", "{}", 'no "addons"'],
    ["addons is a list", '{"addons":[]}', 'no "addons"'],
    ["no updates list", JSON.stringify({ addons: { [ID]: {} } }), 'no "updates"'],
  ])("%s", (_name, text, error) => {
    if (error === null) expect(parseUpdates(text, ID)).toHaveProperty("addons");
    else expect(() => parseUpdates(text, ID)).toThrow(error);
  });
});

describe("releaseCommands", () => {
  it("prints the release and the commit of updates.json and the README", () => {
    expect(
      releaseCommands({
        version: "0.2.0",
        outDir: "release-out/0.2.0",
        cloneDir: "release-out/repo",
      }),
    ).toEqual([
      "gh release create v0.2.0 release-out/0.2.0/english-tutor-0.2.0.xpi --repo rm4n0s/english-tutor-releases --title 'English Tutor 0.2.0' --notes 'English Tutor 0.2.0'",
      "gh repo clone rm4n0s/english-tutor-releases release-out/repo   # or, if it is there already: git -C release-out/repo pull --ff-only",
      "cp release-out/0.2.0/updates.json release-out/0.2.0/README.md release-out/repo/",
      "git -C release-out/repo add updates.json README.md",
      "git -C release-out/repo commit -m 'Release 0.2.0'",
      "git -C release-out/repo push origin main",
    ]);
  });
});
