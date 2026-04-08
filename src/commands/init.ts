/**
 * koda init — set up ~/.koda/ directory with template files.
 *
 * Thin wrapper that shells to the init.ts script. Exists as a subcommand
 * so the user never needs to remember `npx tsx src/init.ts` — they just
 * run `koda init`.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { findKodaRepoRoot } from "./_paths.js";

export const description = "Set up ~/.koda/ with template files (safe to re-run)";

export async function runInit(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: koda init");
    console.log("");
    console.log("  Creates ~/.koda/ directories and copies template files.");
    console.log("  Existing files are preserved — safe to re-run any time.");
    console.log("  Reference .example copies are refreshed on every run.");
    return 0;
  }

  const repo = findKodaRepoRoot();

  // Prefer the compiled dist version if present, otherwise tsx
  const distInit = resolve(repo, "dist/init.js");
  const srcInit = resolve(repo, "src/init.ts");

  let cmd: string;
  let cmdArgs: string[];
  try {
    const { existsSync } = await import("node:fs");
    if (existsSync(distInit)) {
      cmd = "node";
      cmdArgs = [distInit];
    } else {
      cmd = "npx";
      cmdArgs = ["tsx", srcInit];
    }
  } catch {
    cmd = "npx";
    cmdArgs = ["tsx", srcInit];
  }

  return new Promise((res) => {
    const proc = spawn(cmd, cmdArgs, { cwd: repo, stdio: "inherit" });
    proc.on("close", code => res(code ?? 0));
    proc.on("error", err => {
      console.error(`koda init failed: ${err.message}`);
      res(1);
    });
  });
}
