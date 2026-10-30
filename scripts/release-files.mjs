// Writes the files of one release into release-out/<version>/ and prints the commands that publish
// them (docs/RELEASING.md). Logic: scripts/lib/release-files.mjs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { releaseFiles } from "./lib/release-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

try {
  await releaseFiles(process.argv.slice(2), {
    root,
    readBytes: (path) => readFile(path),
    readText,
    writeFile,
    makeDir: (dir) => mkdir(dir, { recursive: true }),
    fetchText,
    log: (message) => console.log(message),
  });
} catch (err) {
  console.error(`release-files: ${err.message}`);
  process.exitCode = 1;
}
