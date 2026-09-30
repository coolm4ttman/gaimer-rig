// GAIMER.RIG.WIN.1 — portable CLI postbuild.
//
// The previous inline script chained `chmod`, `mkdir -p` and `cp`, which cmd.exe
// cannot run, so `npm run build` failed outright on Windows before the daemon
// could ever be booted there. Same approach the daemon already uses
// (scripts/copy-workflow-specs.mjs): do it in Node so it runs everywhere.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgRoot, "..", "..");

/** chmod is meaningless on Windows; NTFS has no execute bit. Skip rather than
 *  fail, so the bin wrapper still gets its +x on POSIX where it matters. */
function makeExecutable(file) {
  if (process.platform === "win32") return;
  if (existsSync(file)) chmodSync(file, 0o755);
}

function copyByExtension(fromDir, toDir, ext) {
  if (!existsSync(fromDir)) return 0;
  mkdirSync(toDir, { recursive: true });
  let n = 0;
  for (const entry of readdirSync(fromDir)) {
    if (!entry.endsWith(ext)) continue;
    cpSync(join(fromDir, entry), join(toDir, entry));
    n++;
  }
  return n;
}

makeExecutable(join(pkgRoot, "dist", "bin-wrapper.js"));

const schemas = copyByExtension(
  join(pkgRoot, "src", "schemas"),
  join(pkgRoot, "dist", "schemas"),
  ".json",
);
const templates = copyByExtension(
  join(pkgRoot, "src", "lib", "scope-templates"),
  join(pkgRoot, "dist", "lib", "scope-templates"),
  ".md",
);

const license = join(repoRoot, "LICENSE");
if (existsSync(license)) cpSync(license, join(pkgRoot, "LICENSE"));

console.log(`[cli postbuild] ${schemas} schema(s), ${templates} template(s) copied`);
