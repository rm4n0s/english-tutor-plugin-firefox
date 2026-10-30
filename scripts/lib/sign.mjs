// `npm run sign` (docs/RELEASING.md), with everything that touches the outside world passed in,
// so that a test can use a fake `git`, a fake `web-ext` and a temporary folder.

import { loadAmoKeys, KEY_NAME, SECRET_NAME } from "./env-file.mjs";
import { buildSignArgs, checkClean, checkVersions, findSignedXpi } from "./release.mjs";

/**
 * deps:
 * - root: absolute path of the repo (with a trailing slash)
 * - env: process.env
 * - exec(command, args, { env? }): runs a command, resolves `{ stdout }`, rejects when it fails.
 *   It is the only way git, npm and web-ext are run.
 * - readText(path): the text of a file, or null if it does not exist
 * - listFiles(dir): `[{ name, mtimeMs }]`
 * - makeDir(dir)
 * - now(): milliseconds
 * - log(message)
 * Returns the absolute path of the signed `.xpi`.
 */
export async function sign(deps) {
  const { root, env, exec, readText, listFiles, makeDir, now, log } = deps;

  const status = await exec("git", ["status", "--porcelain"], {});
  checkClean(status.stdout);

  const readJson = async (path) => {
    const text = await readText(`${root}${path}`);
    if (text === null) throw new Error(`${path} is missing.`);
    return JSON.parse(text);
  };
  const version = checkVersions({
    manifest: await readJson("src/manifest.json"),
    pkg: await readJson("package.json"),
    lock: await readJson("package-lock.json"),
  });

  // Before the slow steps: a missing key stops the run here.
  const keys = await loadAmoKeys(env, () => readText(`${root}.env`));

  const artifactsDir = `${root}web-ext-artifacts`;
  const sourceZip = `${artifactsDir}/english-tutor-${version}-source.zip`;
  await makeDir(artifactsDir);

  log(`Signing English Tutor ${version} as unlisted.`);
  await exec("npm", ["run", "build"], {});
  await exec("git", ["archive", "--format=zip", "-o", sourceZip, "HEAD"], {});

  // A small margin: a file system's clock can be a few milliseconds behind this one.
  const startedAt = now() - 2000;
  const [command, ...args] = buildSignArgs({
    sourceDir: `${root}dist`,
    sourceZip,
    artifactsDir,
  });
  // The key goes only through the child's environment, never on a command line.
  await exec(`npx`, [command, ...args], {
    env: { ...env, [KEY_NAME]: keys.key, [SECRET_NAME]: keys.secret },
  });

  const name = findSignedXpi(await listFiles(artifactsDir), version, startedAt);
  const xpi = `${artifactsDir}/${name}`;
  log(`Signed: ${xpi}`);
  log("Next: npm run release-files -- " + xpi);
  return xpi;
}
