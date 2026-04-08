/**
 * koda restart — restart the Koda daemon with a reason.
 *
 * Persists the reason to ~/.koda/data/.last-restart.json so the next
 * startup message in Discord includes it.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KODA_HOME = process.env.KODA_HOME ?? resolve(homedir(), ".koda");

export const description = "Restart the Koda daemon with a reason";

export async function runRestart(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: koda restart [reason...]");
    console.log("  Restarts the pm2-managed Koda daemon.");
    console.log("  The reason (if given) is persisted and appears in the next");
    console.log("  Discord startup message.");
    return 0;
  }

  const reason = args.join(" ").trim() || "manual restart via koda cli";

  try {
    await mkdir(resolve(KODA_HOME, "data"), { recursive: true });
    await writeFile(
      resolve(KODA_HOME, "data/.last-restart.json"),
      JSON.stringify({ reason, timestamp: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    console.error(
      `Warning: could not persist restart reason: ${err instanceof Error ? err.message : err}`,
    );
  }

  console.log(`Restarting koda — reason: ${reason}`);
  try {
    await execFileAsync("pm2", ["restart", "koda", "--update-env"]);
    console.log("\x1b[32m✓\x1b[0m koda restarted");
    return 0;
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m pm2 restart failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}
