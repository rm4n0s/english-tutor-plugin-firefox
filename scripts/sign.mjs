// Signs the extension on addons.mozilla.org as an unlisted version (docs/RELEASING.md). The logic
// is in scripts/lib/sign.mjs; this file only connects it to the real git, npm, web-ext and files.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sign } from "./lib/sign.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// Output goes to the terminal; for `git status` it is captured. On a failure only the command's
// name and exit code are reported (never the arguments or the environment).
function exec(command, args, { env }) {
  return new Promise((resolve, reject) => {
    const capture = command === "git" && args[0] === "status";
    const child = spawn(command, args, {
      cwd: root,
      env: env ?? process.env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.on("error", (err) => reject(new Error(`${command} could not start: ${err.code}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${command} ${args[0] ?? ""} failed with exit code ${code}`));
    });
  });
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function listFiles(dir) {
  const names = await readdir(dir);
  return Promise.all(
    names.map(async (name) => ({ name, mtimeMs: (await stat(`${dir}/${name}`)).mtimeMs })),
  );
}

try {
  await sign({
    root,
    env: process.env,
    exec,
    readText,
    listFiles,
    makeDir: (dir) => mkdir(dir, { recursive: true }),
    now: () => Date.now(),
    log: (message) => console.log(message),
  });
} catch (err) {
  console.error(`sign: ${err.message}`);
  process.exitCode = 1;
}
