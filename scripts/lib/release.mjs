// The pure parts of a release (docs/RELEASING.md): version checks, the arguments of `web-ext
// sign`, finding the signed file, and `updates.json` (SPEC section 3.2).

import { createHash } from "node:crypto";

export const RELEASES_REPO = "rm4n0s/english-tutor-releases";
// A committed file in the public releases repo, so there is no redirect to follow (SPEC 3.2).
export const UPDATE_URL = `https://raw.githubusercontent.com/${RELEASES_REPO}/main/updates.json`;

export function tagFor(version) {
  return `v${version}`;
}

export function xpiName(version) {
  return `english-tutor-${version}.xpi`;
}

export function xpiUrl(version) {
  return `https://github.com/${RELEASES_REPO}/releases/download/${tagFor(version)}/${xpiName(version)}`;
}

/** Firefox version strings used here: two to four dot-separated numbers, no leading zeros. */
export function isValidVersion(version) {
  return typeof version === "string" && /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){1,3}$/.test(version);
}

/** Numeric comparison of two version strings: negative, zero or positive. */
export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Checks that the manifest, package.json and package-lock.json (its own version, twice) agree on
 * one valid version. Returns it, or throws an Error listing the differences.
 */
export function checkVersions({ manifest, pkg, lock }) {
  const found = {
    "src/manifest.json": manifest?.version,
    "package.json": pkg?.version,
    "package-lock.json": lock?.version,
    'package-lock.json packages[""]': lock?.packages?.[""]?.version,
  };
  const version = found["src/manifest.json"];
  if (!isValidVersion(version)) {
    throw new Error(`src/manifest.json has no valid version (found ${JSON.stringify(version)}).`);
  }
  const differing = Object.entries(found).filter(([, value]) => value !== version);
  if (differing.length > 0) {
    const list = differing.map(([file, value]) => `${file}: ${JSON.stringify(value)}`).join(", ");
    throw new Error(`The versions differ from the manifest's ${version}: ${list}.`);
  }
  return version;
}

/** `git status --porcelain` output: empty means a clean tree (untracked files count as dirty). */
export function checkClean(porcelain) {
  if (porcelain.trim() !== "") {
    throw new Error(
      "The git tree is not clean. Commit or stash the changes (and remove untracked files) first: " +
        "the source uploaded to AMO is `git archive HEAD`.",
    );
  }
}

/** The arguments of `web-ext sign`. The AMO key is not among them: it goes in the environment. */
export function buildSignArgs({ sourceDir, sourceZip, artifactsDir }) {
  return [
    "web-ext",
    "sign",
    "-s",
    sourceDir,
    "--channel=unlisted",
    "--upload-source-code",
    sourceZip,
    "--artifacts-dir",
    artifactsDir,
  ];
}

/**
 * Finds the file `web-ext sign` wrote: `files` is `[{ name, mtimeMs }]` of the artifacts folder.
 * Only a `.xpi` for this version written at or after `since` counts; the newest wins.
 */
export function findSignedXpi(files, version, since) {
  const suffix = `-${version}.xpi`;
  const found = files
    .filter((file) => file.name.endsWith(suffix) && file.mtimeMs >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (found.length === 0) {
    throw new Error(
      `web-ext finished, but no signed ${version} .xpi is in the artifacts folder. ` +
        'See docs/RELEASING.md, "When signing is refused or times out".',
    );
  }
  return found[0].name;
}

/** The version in a signed file's name (`<id>-<version>.xpi`), or null. */
export function versionFromXpiName(name) {
  const match = /-((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,3})\.xpi$/.exec(name);
  return match === null ? null : match[1];
}

export function sha256Hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Reads the text of an existing `updates.json`; throws on anything that is not the right shape. */
export function parseUpdates(text, id) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The previous updates.json is not valid JSON.");
  }
  const addons = data?.addons;
  if (typeof addons !== "object" || addons === null || Array.isArray(addons)) {
    throw new Error('The previous updates.json has no "addons" object.');
  }
  const entry = addons[id];
  if (entry !== undefined && !Array.isArray(entry?.updates)) {
    throw new Error(`The previous updates.json has no "updates" list for ${id}.`);
  }
  return data;
}

/**
 * Adds one version to an update manifest and keeps every earlier one (the entry of the same
 * version is replaced). `previous` is a parsed update manifest or null. Entries are sorted from
 * the oldest to the newest version, and other add-ons in the file are left alone.
 */
export function mergeUpdates({ previous, id, version, updateLink, updateHash, minFirefox }) {
  const base = previous ?? { addons: {} };
  const old = base.addons[id]?.updates ?? [];
  const entry = {
    version,
    update_link: updateLink,
    update_hash: updateHash,
    ...(minFirefox === undefined
      ? {}
      : { applications: { gecko: { strict_min_version: minFirefox } } }),
  };
  const updates = [...old.filter((item) => item.version !== version), entry].sort((a, b) =>
    compareVersions(a.version, b.version),
  );
  return { ...base, addons: { ...base.addons, [id]: { updates } } };
}

function quote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The commands the maintainer runs after `npm run release-files` (nothing runs them here).
 * Paths are relative to the repo root.
 */
export function releaseCommands({ version, outDir, cloneDir }) {
  const tag = tagFor(version);
  const notes = `English Tutor ${version}`;
  return [
    `gh release create ${tag} ${quote(`${outDir}/${xpiName(version)}`)} --repo ${RELEASES_REPO} --title ${quote(notes)} --notes ${quote(notes)}`,
    `gh repo clone ${RELEASES_REPO} ${quote(cloneDir)}   # or, if it is there already: git -C ${quote(cloneDir)} pull --ff-only`,
    `cp ${quote(`${outDir}/updates.json`)} ${quote(`${outDir}/README.md`)} ${quote(cloneDir)}/`,
    `git -C ${quote(cloneDir)} add updates.json README.md`,
    `git -C ${quote(cloneDir)} commit -m ${quote(`Release ${version}`)}`,
    `git -C ${quote(cloneDir)} push origin main`,
  ];
}
