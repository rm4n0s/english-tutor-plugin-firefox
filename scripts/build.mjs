// Bundles src/ into dist/: three esbuild entry points, plus the manifest, HTML, CSS and icons.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = `${root}src/`;
const dist = `${root}dist/`;

const entryPoints = {
  background: `${src}background/main.ts`,
  tutor: `${src}tutor/main.ts`,
  options: `${src}options/main.ts`,
};

const copies = [
  ["manifest.json", "manifest.json"],
  ["tutor/tutor.html", "tutor.html"],
  ["tutor/tutor.css", "tutor.css"],
  ["options/options.html", "options.html"],
  ["options/options.css", "options.css"],
  ["ui/theme.css", "theme.css"],
  ["ui/components.css", "components.css"],
  ["icons", "icons"],
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints,
  outdir: dist,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox140",
  logLevel: "warning",
});

for (const [from, to] of copies) {
  await cp(`${src}${from}`, `${dist}${to}`, { recursive: true });
}

console.log("built dist/");
