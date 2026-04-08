/**
 * koda logs — tail Koda's pm2 logs.
 *
 * Wraps `pm2 logs koda`. Supports --errors (stderr only) and --lines N.
 */

import { spawn } from "node:child_process";

export const description = "Tail the Koda daemon logs (pm2)";

export async function runLogs(args: string[]): Promise<number> {
  const pmArgs = ["logs", "koda"];

  let errOnly = false;
  let lines = 50;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--errors" || a === "--err") {
      errOnly = true;
    } else if (a === "--lines" || a === "-n") {
      const next = args[++i];
      const parsed = parseInt(next, 10);
      if (Number.isNaN(parsed)) {
        console.error(`koda logs: --lines requires a number, got '${next}'`);
        return 2;
      }
      lines = parsed;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: koda logs [--errors] [--lines N]");
      console.log("  --errors, --err    Show only stderr");
      console.log("  --lines N, -n N    Number of lines to show (default 50)");
      return 0;
    }
  }

  if (errOnly) pmArgs.push("--err");
  pmArgs.push("--lines", String(lines));

  return new Promise((res) => {
    const proc = spawn("pm2", pmArgs, { stdio: "inherit" });
    proc.on("close", code => res(code ?? 0));
    proc.on("error", err => {
      console.error(`pm2 logs failed: ${err.message}`);
      res(1);
    });
  });
}
