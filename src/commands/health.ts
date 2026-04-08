/**
 * koda health — run a health check on the Koda daemon.
 *
 * Thin wrapper over pm2 + log file inspection. Same spirit as the
 * check_health MCP tool exposed to Discord, but runnable from terminal.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KODA_HOME = process.env.KODA_HOME ?? resolve(homedir(), ".koda");

export const description = "Run a health check on the Koda daemon";

export async function runHealth(): Promise<number> {
  console.log("");
  console.log("\x1b[1mKoda health check\x1b[0m");
  console.log("");

  let healthy = true;

  // 1. pm2 process
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"]);
    const procs = JSON.parse(stdout) as Array<{
      name: string;
      pm2_env?: { status: string; restart_time?: number };
    }>;
    const koda = procs.find(p => p.name === "koda");
    if (koda) {
      const status = koda.pm2_env?.status ?? "unknown";
      const restarts = koda.pm2_env?.restart_time ?? 0;
      if (status === "online") {
        console.log(`  \x1b[32m✓\x1b[0m pm2: online (${restarts} restarts)`);
      } else {
        console.log(`  \x1b[31m✗\x1b[0m pm2: ${status}`);
        healthy = false;
      }
    } else {
      console.log(`  \x1b[31m✗\x1b[0m pm2: koda process not found`);
      healthy = false;
    }
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m pm2 query failed: ${err instanceof Error ? err.message : err}`);
    healthy = false;
  }

  // 2. Log files
  const outLog = resolve(KODA_HOME, "logs/koda-out.log");
  const errLog = resolve(KODA_HOME, "logs/koda-error.log");
  if (existsSync(outLog)) {
    const kb = Math.round(statSync(outLog).size / 1024);
    console.log(`  \x1b[32m✓\x1b[0m stdout log: ${kb}KB`);
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m stdout log missing`);
  }
  if (existsSync(errLog)) {
    const kb = Math.round(statSync(errLog).size / 1024);
    console.log(`  \x1b[32m✓\x1b[0m stderr log: ${kb}KB`);
  } else {
    console.log(`  \x1b[33m⚠\x1b[0m stderr log missing`);
  }

  // 3. Recent stderr
  if (existsSync(errLog)) {
    try {
      const { stdout } = await execFileAsync("tail", ["-n", "10", errLog]);
      if (stdout.trim()) {
        console.log("");
        console.log("  Recent stderr (last 10 lines):");
        console.log(stdout.split("\n").map(l => `    ${l}`).join("\n"));
      }
    } catch { /* ignore */ }
  }

  console.log("");
  if (healthy) {
    console.log("\x1b[32mhealthy\x1b[0m");
    console.log("");
    return 0;
  } else {
    console.log("\x1b[31mnot healthy — see above\x1b[0m");
    console.log("");
    return 1;
  }
}
