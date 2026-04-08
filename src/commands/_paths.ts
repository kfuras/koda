/**
 * Shared path utilities for the Koda CLI.
 *
 * The `koda` binary is installed via `npm link`, which creates a symlink
 * from `<npm-prefix>/bin/koda` to `<repo>/dist/koda.js`. To make `koda update`
 * and other commands work regardless of where the user cloned the repo, we
 * walk up from the CLI's own file location until we find a package.json
 * with name "koda-agent". That lets the binary work from any clone path
 * (~/code/koda, ~/projects/koda, /opt/koda, ~/kaf/koda — anywhere).
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Find the root of the Koda repo by walking up from this file's location.
 * Throws if no valid repo is found (shouldn't happen in practice).
 *
 * Can be overridden via the KODA_REPO_DIR environment variable for exotic
 * install layouts.
 */
export function findKodaRepoRoot(): string {
  if (process.env.KODA_REPO_DIR) {
    return process.env.KODA_REPO_DIR;
  }

  const startDir = dirname(fileURLToPath(import.meta.url));
  let dir = startDir;

  while (dir !== "/" && dir !== ".") {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "koda-agent") return dir;
      } catch {
        // ignore parse errors; keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  throw new Error(
    `Could not find Koda repo root (walked up from ${startDir}). ` +
    `Expected a package.json with "name": "koda-agent" at some ancestor directory. ` +
    `Set KODA_REPO_DIR env var to override.`,
  );
}
