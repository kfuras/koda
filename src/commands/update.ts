/**
 * koda update — pull latest code, rebuild, run doctor, restart.
 *
 * Flow:
 *   1. Preflight — worktree must be clean (unless --force)
 *   2. git fetch origin main
 *   3. Compare SHAs; exit early if equal (unless --force)
 *   4. Print commit list
 *   5. If --dry-run, stop here
 *   6. git pull --ff-only
 *   7. npm install
 *   8. npm run build
 *   9. koda doctor — final safety check
 *  10. Rollback on any failure (git reset --hard + npm install)
 *  11. Persist reason for startup message
 *  12. pm2 restart if the daemon is running
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { findKodaRepoRoot } from "./_paths.js";
import { runDoctor } from "./doctor.js";

const execFileAsync = promisify(execFile);
const KODA_HOME = process.env.KODA_HOME ?? resolve(homedir(), ".koda");

export const description = "Pull latest code, rebuild, and restart Koda";

export async function runUpdate(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: koda update [options]");
    console.log("");
    console.log("Options:");
    console.log("  --dry-run      Preview what would change; make no changes");
    console.log("  --force        Update even if worktree has uncommitted changes");
    console.log("  --no-restart   Skip the pm2 restart at the end");
    return 0;
  }

  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const noRestart = args.includes("--no-restart");

  console.log("");
  console.log("\x1b[1mKoda update\x1b[0m");
  console.log("");

  // 1. Find repo root
  let repo: string;
  try {
    repo = findKodaRepoRoot();
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Could not locate Koda repo: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
  console.log(`  Repo:    ${repo}`);

  // 2. Preflight: worktree clean
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
    if (stdout.trim() && !force) {
      console.error("");
      console.error(`\x1b[31m✗\x1b[0m Worktree is not clean. Uncommitted changes:`);
      for (const line of stdout.trim().split("\n")) {
        console.error(`    ${line}`);
      }
      console.error("");
      console.error(`Commit or stash your changes, or re-run with --force.`);
      return 1;
    }
    if (stdout.trim()) {
      console.log(`  \x1b[33m⚠\x1b[0m Worktree has uncommitted changes (--force)`);
    } else {
      console.log(`  \x1b[32m✓\x1b[0m Worktree clean`);
    }
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m git status failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  // 3. Fetch
  console.log("  Fetching origin...");
  try {
    await execFileAsync("git", ["fetch", "origin", "main"], { cwd: repo });
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m git fetch failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  // 4. Compare SHAs
  const { stdout: currentRaw } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
  const { stdout: upstreamRaw } = await execFileAsync("git", ["rev-parse", "origin/main"], { cwd: repo });
  const currentSha = currentRaw.trim();
  const upstreamSha = upstreamRaw.trim();

  if (currentSha === upstreamSha && !force) {
    console.log("");
    console.log(`  \x1b[32m✓\x1b[0m Already up to date at ${currentSha.slice(0, 7)}`);
    console.log("");
    return 0;
  }

  // 5. Commit list
  const { stdout: logOut } = await execFileAsync(
    "git",
    ["log", "--oneline", `${currentSha}..${upstreamSha}`],
    { cwd: repo },
  );
  const commits = logOut.trim().split("\n").filter(l => l.trim());

  console.log("");
  console.log(`  ${currentSha.slice(0, 7)} → ${upstreamSha.slice(0, 7)} (${commits.length} commit${commits.length === 1 ? "" : "s"})`);
  for (const c of commits) console.log(`    ${c}`);
  console.log("");

  if (dryRun) {
    console.log("  \x1b[33m(dry run — no changes made)\x1b[0m");
    console.log("");
    return 0;
  }

  const rollbackSha = currentSha;

  // 6. Pull
  console.log("  \x1b[1m[1/4] git pull\x1b[0m");
  try {
    await runAndStream("git", ["pull", "--ff-only", "origin", "main"], repo);
  } catch {
    console.error(`\x1b[31m✗\x1b[0m git pull failed`);
    return 1;
  }

  // 7. npm install
  console.log("");
  console.log("  \x1b[1m[2/4] npm install\x1b[0m");
  try {
    await runAndStream("npm", ["install"], repo);
  } catch {
    console.error(`\x1b[31m✗\x1b[0m npm install failed — rolling back`);
    await rollback(repo, rollbackSha);
    return 1;
  }

  // 8. Build
  console.log("");
  console.log("  \x1b[1m[3/4] npm run build\x1b[0m");
  try {
    await runAndStream("npm", ["run", "build"], repo);
  } catch {
    console.error(`\x1b[31m✗\x1b[0m npm run build failed — rolling back`);
    await rollback(repo, rollbackSha);
    return 1;
  }

  // 9. Doctor
  console.log("");
  console.log("  \x1b[1m[4/4] koda doctor\x1b[0m");
  const doctorCode = await runDoctor([]);
  if (doctorCode !== 0) {
    console.error(`\x1b[31m✗\x1b[0m koda doctor reported errors — rolling back`);
    await rollback(repo, rollbackSha);
    return 1;
  }

  // 10. Persist reason
  const reasonText = `updated ${rollbackSha.slice(0, 7)} → ${upstreamSha.slice(0, 7)} (${commits.length} commit${commits.length === 1 ? "" : "s"})`;
  try {
    await mkdir(resolve(KODA_HOME, "data"), { recursive: true });
    await writeFile(
      resolve(KODA_HOME, "data/.last-restart.json"),
      JSON.stringify({ reason: reasonText, timestamp: new Date().toISOString() }, null, 2),
    );
  } catch { /* not fatal */ }

  // 11. Restart daemon
  if (noRestart) {
    console.log("");
    console.log(`  \x1b[32m✓\x1b[0m Updated (--no-restart)`);
    console.log(`    ${reasonText}`);
    console.log("");
    console.log("  Run: pm2 restart koda --update-env");
    console.log("");
    return 0;
  }

  if (await isPm2Running()) {
    console.log("");
    console.log("  Restarting daemon...");
    try {
      await execFileAsync("pm2", ["restart", "koda", "--update-env"]);
      console.log("");
      console.log(`\x1b[32m✓\x1b[0m Updated and restarted`);
      console.log(`  ${reasonText}`);
      console.log("");
      return 0;
    } catch (err) {
      console.error(`\x1b[33m⚠\x1b[0m Update succeeded, pm2 restart failed: ${err instanceof Error ? err.message : err}`);
      console.error("  Run: pm2 restart koda --update-env");
      return 0;
    }
  } else {
    console.log("");
    console.log(`\x1b[32m✓\x1b[0m Updated (daemon not running)`);
    console.log(`  ${reasonText}`);
    console.log("  Run: pm2 start ecosystem.config.cjs  (to start the daemon)");
    console.log("");
    return 0;
  }
}

async function rollback(repo: string, sha: string): Promise<void> {
  try {
    console.log("");
    console.log(`  Rolling back to ${sha.slice(0, 7)}...`);
    await execFileAsync("git", ["reset", "--hard", sha], { cwd: repo });
    await runAndStream("npm", ["install"], repo);
    console.log(`  \x1b[33m⚠\x1b[0m Rolled back to ${sha.slice(0, 7)}. Daemon NOT restarted.`);
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Rollback FAILED: ${err instanceof Error ? err.message : err}`);
    console.error("  The repo may be in an inconsistent state. Fix manually.");
  }
}

async function isPm2Running(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"]);
    const procs = JSON.parse(stdout) as Array<{ name: string; pm2_env?: { status: string } }>;
    const koda = procs.find(p => p.name === "koda");
    return koda?.pm2_env?.status === "online";
  } catch {
    return false;
  }
}

async function runAndStream(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const proc = spawn(cmd, args, { cwd, stdio: "inherit" });
    proc.on("close", code => {
      if (code === 0) res();
      else rej(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", rej);
  });
}
