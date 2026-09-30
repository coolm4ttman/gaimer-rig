// GAIMER.RIG.WIN.1 — portable TUI postbuild. `chmod +x` is a cmd.exe syntax
// error on Windows and meaningless on NTFS, so do it in Node and skip there.
import { chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const main = join(pkgRoot, "dist", "main.js");
if (process.platform !== "win32" && existsSync(main)) chmodSync(main, 0o755);
