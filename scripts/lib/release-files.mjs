// `npm run release-files` (docs/RELEASING.md): the files of one release, in release-out/<version>/.
// It runs no release command: it prints them.

import {
  UPDATE_URL,
  checkVersions,
  mergeUpdates,
  parseUpdates,
  releaseCommands,
  sha256Hash,
  versionFromXpiName,
  xpiName,
  xpiUrl,
} from "./release.mjs";

/**
 * args: `[<signed .xpi>, "--previous", <path>, "--offline"]` (flags in any order).
 * deps:
 * - root: absolute path of the repo (with a trailing slash)
 * - readBytes(path): a Buffer; readText(path): text or null when missing
 * - writeFile(path, bytes), makeDir(dir)
 * - fetchText(url): the text, or null on a 404 (the file is not in the releases repo yet)
 * - log(message)
 */
export async function releaseFiles(args, deps) {
  const { root, readBytes, readText, writeFile, makeDir, fetchText, log } = deps;
  const { xpiPath, previousPath, offline } = parseArgs(args);

  const manifestText = await readText(`${root}src/manifest.json`);
  const pkgText = await readText(`${root}package.json`);
  const lockText = await readText(`${root}package-lock.json`);
  if (manifestText === null || pkgText === null || lockText === null) {
    throw new Error("src/manifest.json, package.json or package-lock.json is missing.");
  }
  const manifest = JSON.parse(manifestText);
  const version = checkVersions({
    manifest,
    pkg: JSON.parse(pkgText),
    lock: JSON.parse(lockText),
  });
  const xpiVersion = versionFromXpiName(xpiPath.split("/").pop());
  if (xpiVersion !== version) {
    throw new Error(
      `The file is for version ${xpiVersion ?? "(unknown)"}, but the manifest is ${version}. ` +
        "Release from the commit that was signed.",
    );
  }
  const gecko = manifest.browser_specific_settings?.gecko;
  const id = gecko?.id;
  if (typeof id !== "string") throw new Error("The manifest has no gecko id.");
  if (manifest.browser_specific_settings.gecko.update_url !== UPDATE_URL) {
    throw new Error(`The manifest's update_url is not ${UPDATE_URL}.`);
  }

  const previousText = await previousUpdates({ previousPath, offline, readText, fetchText, log });
  const previous = previousText === null ? null : parseUpdates(previousText, id);

  const xpiBytes = await readBytes(xpiPath);
  const merged = mergeUpdates({
    previous,
    id,
    version,
    updateLink: xpiUrl(version),
    updateHash: sha256Hash(xpiBytes),
    minFirefox: gecko.strict_min_version,
  });

  const install = await readText(`${root}docs/INSTALL.md`);
  if (install === null) throw new Error("docs/INSTALL.md is missing.");

  const outDir = `release-out/${version}`;
  await makeDir(`${root}${outDir}`);
  await writeFile(`${root}${outDir}/${xpiName(version)}`, xpiBytes);
  await writeFile(`${root}${outDir}/updates.json`, `${JSON.stringify(merged, null, 2)}\n`);
  await writeFile(`${root}${outDir}/README.md`, install);

  log(`Wrote ${outDir}/ (${xpiName(version)}, updates.json, README.md).`);
  log("Run these from the repo root, in this order (nothing has been run):");
  for (const command of releaseCommands({
    version,
    outDir,
    cloneDir: "release-out/releases-repo",
  })) {
    log(command);
  }
  return { version, outDir, updates: merged };
}

function parseArgs(args) {
  let xpiPath;
  let previousPath;
  let offline = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--offline") {
      offline = true;
    } else if (arg === "--previous") {
      previousPath = args[i + 1];
      i += 1;
      if (previousPath === undefined) throw new Error("--previous needs a path.");
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}.`);
    } else if (xpiPath === undefined) {
      xpiPath = arg;
    } else {
      throw new Error("Only one .xpi can be given.");
    }
  }
  if (xpiPath === undefined) {
    throw new Error(
      "Usage: npm run release-files -- <signed .xpi> [--previous <updates.json>] [--offline]",
    );
  }
  return { xpiPath, previousPath, offline };
}

async function previousUpdates({ previousPath, offline, readText, fetchText, log }) {
  if (previousPath !== undefined) {
    const text = await readText(previousPath);
    if (text === null) throw new Error(`${previousPath} does not exist.`);
    return text;
  }
  if (offline) return null;
  const text = await fetchText(UPDATE_URL);
  if (text === null) log("No updates.json in the releases repo yet: starting a new one.");
  return text;
}
