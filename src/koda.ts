#!/usr/bin/env node
/**
 * koda — command-line interface for the Koda daemon.
 *
 * Subcommand router. Each command lives in src/commands/<name>.ts and
 * exports a `description` string and a `runX` function that takes
 * string[] args and returns Promise<number> (exit code).
 *
 * Usage:
 *   koda <command> [options]
 *
 * Install: `npm link` from the repo root creates a global `koda` binary
 * at <npm-prefix>/bin/koda. The binary finds its own repo root at runtime
 * via findKodaRepoRoot() in src/commands/_paths.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runStatus, description as statusDesc } from "./commands/status.js";
import { runUpdate, description as updateDesc } from "./commands/update.js";
import { runLogs, description as logsDesc } from "./commands/logs.js";
import { runRestart, description as restartDesc } from "./commands/restart.js";
import { runDoctor, description as doctorDesc } from "./commands/doctor.js";
import { runSkills, description as skillsDesc } from "./commands/skills.js";
import { runHealth, description as healthDesc } from "./commands/health.js";

interface Command {
  description: string;
  run: (args: string[]) => Promise<number>;
}

const COMMANDS: Record<string, Command> = {
  status:  { description: statusDesc,  run: async () => runStatus() },
  update:  { description: updateDesc,  run: runUpdate },
  logs:    { description: logsDesc,    run: runLogs },
  restart: { description: restartDesc, run: runRestart },
  doctor:  { description: doctorDesc,  run: runDoctor },
  skills:  { description: skillsDesc,  run: runSkills },
  health:  { description: healthDesc,  run: async () => runHealth() },
};

function printUsage(): void {
  console.log("");
  console.log("\x1b[1mkoda\x1b[0m — autonomous content production daemon");
  console.log("");
  console.log("\x1b[1mUSAGE\x1b[0m");
  console.log("  koda <command> [options]");
  console.log("");
  console.log("\x1b[1mCOMMANDS\x1b[0m");
  const entries = Object.entries(COMMANDS);
  const maxLen = Math.max(...entries.map(([name]) => name.length));
  for (const [name, cmd] of entries) {
    console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}`);
  }
  console.log("");
  console.log("\x1b[1mOPTIONS\x1b[0m");
  console.log("  -h, --help     Show help");
  console.log("  -v, --version  Show version");
  console.log("");
  console.log("Run 'koda <command> --help' for options specific to a command.");
  console.log("");
}

function printVersion(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Walk up looking for a package.json with name koda-agent
    let dir = here;
    while (dir !== "/" && dir !== ".") {
      const pkgPath = resolve(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
        if (pkg.name === "koda-agent") {
          console.log(`koda ${pkg.version ?? "unknown"}`);
          return;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    console.log("koda (version unknown)");
  } catch {
    console.log("koda (version unknown)");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    printUsage();
    process.exit(0);
  }

  if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
    printVersion();
    process.exit(0);
  }

  const commandName = argv[0];
  const commandArgs = argv.slice(1);

  const command = COMMANDS[commandName];
  if (!command) {
    console.error(`koda: unknown command '${commandName}'`);
    console.error(`Run 'koda --help' to see available commands.`);
    process.exit(2);
  }

  try {
    const code = await command.run(commandArgs);
    process.exit(code);
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m koda ${commandName} crashed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack.split("\n").slice(1, 5).join("\n"));
    }
    process.exit(1);
  }
}

void main();
