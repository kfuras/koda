/**
 * koda status — show daemon state, skills, plugins, memory freshness.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KODA_HOME = process.env.KODA_HOME ?? resolve(homedir(), ".koda");

export const description = "Show Koda daemon state, skills, and memory";

export async function runStatus(): Promise<number> {
  // 1. pm2 daemon state
  let pmStatus = "not running";
  let pmUptime = "—";
  let pmPid = "—";
  let pmRestarts = 0;
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"]);
    const procs = JSON.parse(stdout) as Array<{
      name: string;
      pid: number;
      pm2_env?: { status: string; pm_uptime?: number; restart_time?: number };
    }>;
    const koda = procs.find(p => p.name === "koda");
    if (koda) {
      pmStatus = koda.pm2_env?.status ?? "unknown";
      pmPid = String(koda.pid);
      pmRestarts = koda.pm2_env?.restart_time ?? 0;
      if (koda.pm2_env?.pm_uptime) {
        pmUptime = formatUptime(Math.floor((Date.now() - koda.pm2_env.pm_uptime) / 1000));
      }
    }
  } catch (err) {
    pmStatus = `pm2 query failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 2. Skills inventory
  const kodaSkillsCount = countKodaSkills(resolve(KODA_HOME, "skills"));
  const claudeSkillsCount = countClaudeSkills(resolve(homedir(), ".claude/skills"));
  const pluginsCount = countClaudePlugins(resolve(homedir(), ".claude/plugins/installed_plugins.json"));

  // 3. Memory freshness
  const obsAge = fileAge(resolve(KODA_HOME, "data/observations.md"));
  const learningsAge = fileAge(resolve(KODA_HOME, "learnings.md"));
  const latestDailyLog = latestFile(resolve(KODA_HOME, "data/daily-logs"), ".md");

  // 4. Last restart reason
  let lastRestartReason = "—";
  const restartFile = resolve(KODA_HOME, "data/.last-restart.json");
  if (existsSync(restartFile)) {
    try {
      const data = JSON.parse(readFileSync(restartFile, "utf-8")) as { reason?: string };
      if (data.reason) lastRestartReason = data.reason;
    } catch { /* ignore */ }
  }

  // 5. Render
  const statusColor = pmStatus === "online" ? "\x1b[32m" : "\x1b[31m";
  console.log("");
  console.log("\x1b[1mKoda status\x1b[0m");
  console.log("");
  console.log("  Daemon:");
  console.log(`    status    ${statusColor}${pmStatus}\x1b[0m`);
  console.log(`    pid       ${pmPid}`);
  console.log(`    uptime    ${pmUptime}`);
  console.log(`    restarts  ${pmRestarts}`);
  console.log("");
  console.log("  Skills:");
  console.log(`    koda        ${kodaSkillsCount}`);
  console.log(`    claude      ${claudeSkillsCount}`);
  console.log(`    plugins     ${pluginsCount}`);
  console.log("");
  console.log("  Memory:");
  console.log(`    observations   ${obsAge}`);
  console.log(`    learnings      ${learningsAge}`);
  console.log(`    daily log      ${latestDailyLog}`);
  console.log("");
  console.log("  Last restart:");
  console.log(`    ${lastRestartReason}`);
  console.log("");

  return 0;
}

function countKodaSkills(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    try {
      const st = statSync(full);
      if (st.isFile() && entry.endsWith(".md")) n++;
      else if (st.isDirectory() && existsSync(resolve(full, "SKILL.md"))) n++;
    } catch { /* ignore */ }
  }
  return n;
}

function countClaudeSkills(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    try {
      if (statSync(resolve(dir, entry)).isDirectory()) n++;
    } catch { /* ignore */ }
  }
  return n;
}

function countClaudePlugins(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as { plugins?: Record<string, unknown> };
    return Object.keys(data.plugins ?? {}).length;
  } catch {
    return 0;
  }
}

function fileAge(path: string): string {
  if (!existsSync(path)) return "missing";
  try {
    const ageSec = Math.floor((Date.now() - statSync(path).mtimeMs) / 1000);
    if (ageSec < 60) return `${ageSec}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
    return `${Math.floor(ageSec / 86400)}d ago`;
  } catch {
    return "unknown";
  }
}

function latestFile(dir: string, ext: string): string {
  if (!existsSync(dir)) return "none";
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(ext)).sort();
    return files.length > 0 ? files[files.length - 1].replace(new RegExp(`\\${ext}$`), "") : "none";
  } catch {
    return "none";
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
