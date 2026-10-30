import { describe, expect, it } from "vitest";
import { sign } from "./sign.mjs";

const ROOT = "/repo/";
const GOOD = {
  "/repo/src/manifest.json": JSON.stringify({ version: "0.2.0" }),
  "/repo/package.json": JSON.stringify({ version: "0.2.0" }),
  "/repo/package-lock.json": JSON.stringify({
    version: "0.2.0",
    packages: { "": { version: "0.2.0" } },
  }),
};
const SECRET = "fake-secret-value";

// A fake git, npm and web-ext. `web-ext sign` "writes" the signed file into the fake folder.
function setup({ files = GOOD, status = "", env = {}, signFails = false, writeXpi = true } = {}) {
  const calls = [];
  const folder = [{ name: "old-0.1.0.xpi", mtimeMs: 1 }];
  let clock = 1_000_000;
  const logs = [];
  const deps = {
    root: ROOT,
    env,
    exec: (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (command === "git" && args[0] === "status") return Promise.resolve({ stdout: status });
      if (command === "npx" && args[0] === "web-ext") {
        if (signFails) return Promise.reject(new Error("web-ext sign failed with exit code 1"));
        clock += 5000;
        if (writeXpi) folder.push({ name: "id-0.2.0.xpi", mtimeMs: clock });
      }
      return Promise.resolve({ stdout: "" });
    },
    readText: (path) => Promise.resolve(files[path] ?? null),
    listFiles: () => Promise.resolve(folder),
    makeDir: () => Promise.resolve(),
    now: () => clock,
    log: (message) => logs.push(message),
  };
  return { deps, calls, logs };
}

const keyEnv = { WEB_EXT_API_KEY: "user:1:2", WEB_EXT_API_SECRET: SECRET };

describe("sign", () => {
  it("builds, archives HEAD, signs unlisted and returns the signed file", async () => {
    const { deps, calls, logs } = setup({ env: keyEnv });
    const xpi = await sign(deps);
    expect(xpi).toBe("/repo/web-ext-artifacts/id-0.2.0.xpi");
    expect(calls.map((c) => [c.command, ...c.args.slice(0, 2)])).toEqual([
      ["git", "status", "--porcelain"],
      ["npm", "run", "build"],
      ["git", "archive", "--format=zip"],
      ["npx", "web-ext", "sign"],
    ]);
    const archive = calls[2].args;
    expect(archive).toEqual([
      "archive",
      "--format=zip",
      "-o",
      "/repo/web-ext-artifacts/english-tutor-0.2.0-source.zip",
      "HEAD",
    ]);
    const signArgs = calls[3].args;
    expect(signArgs).toContain("--channel=unlisted");
    expect(signArgs).toContain("--upload-source-code");
    expect(signArgs[signArgs.indexOf("--upload-source-code") + 1]).toBe(
      "/repo/web-ext-artifacts/english-tutor-0.2.0-source.zip",
    );
    expect(logs.join("\n")).toContain("/repo/web-ext-artifacts/id-0.2.0.xpi");
  });

  it("passes the key only through the environment of web-ext, and never prints it", async () => {
    const { deps, calls, logs } = setup({ env: keyEnv });
    await sign(deps);
    for (const call of calls) {
      expect(JSON.stringify(call.args)).not.toContain(SECRET);
      expect(JSON.stringify(call.args)).not.toContain("user:1:2");
    }
    expect(calls[3].env.WEB_EXT_API_KEY).toBe("user:1:2");
    expect(calls[3].env.WEB_EXT_API_SECRET).toBe(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("reads the key from .env when the environment has none", async () => {
    const files = {
      ...GOOD,
      "/repo/.env": `WEB_EXT_API_KEY="user:3:4"\nWEB_EXT_API_SECRET='${SECRET}'\n`,
    };
    const { deps, calls } = setup({ files });
    await sign(deps);
    expect(calls[3].env.WEB_EXT_API_KEY).toBe("user:3:4");
    expect(calls[3].env.WEB_EXT_API_SECRET).toBe(SECRET);
  });

  it.each([
    ["a dirty tree", { env: keyEnv, status: " M src/manifest.json\n" }, "not clean"],
    [
      "versions that differ",
      {
        env: keyEnv,
        files: { ...GOOD, "/repo/package.json": JSON.stringify({ version: "0.1.0" }) },
      },
      "differ",
    ],
    ["a missing key", {}, "https://addons.mozilla.org/developers/addon/api/key/"],
    [
      "a missing package-lock.json",
      { env: keyEnv, files: { ...GOOD, "/repo/package-lock.json": undefined } },
      "package-lock.json is missing",
    ],
    ["a refused signing", { env: keyEnv, signFails: true }, "web-ext sign failed"],
    ["no signed file afterwards", { env: keyEnv, writeXpi: false }, "no signed"],
  ])("stops on %s", async (_name, options, message) => {
    const { deps, calls } = setup(options);
    const err = await sign(deps).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(message);
    if (message !== "web-ext sign failed" && message !== "no signed") {
      // Stopped before the build, the archive or the upload.
      expect(calls.some((c) => c.command === "npm" || c.command === "npx")).toBe(false);
    }
  });
});
