/**
 * koda skills — list installed skills across all sources.
 *
 * Read-only inventory across:
 *   - ~/.koda/skills/ (flat .md and directory-based SKILL.md)
 *   - ~/.claude/skills/ (Claude Code Agent Skills)
 *   - ~/.claude/plugins/installed_plugins.json (claude-plugins.dev)
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const KODA_HOME = process.env.KODA_HOME ?? resolve(homedir(), ".koda");

export const description = "List installed skills across all sources";

export async function runSkills(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";

  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log("Usage: koda skills list");
    console.log("  Lists skills across ~/.koda/skills/, ~/.claude/skills/,");
    console.log("  and Claude Code plugins.");
    return 0;
  }

  if (sub !== "list") {
    console.error(`koda skills: unknown subcommand '${sub}'`);
    console.error(`Use 'koda skills list' to list installed skills.`);
    return 2;
  }

  console.log("");
  console.log("\x1b[1mInstalled skills\x1b[0m");
  console.log("");

  // Koda skills
  const kodaSkills: string[] = [];
  const kodaSkillsDir = resolve(KODA_HOME, "skills");
  if (existsSync(kodaSkillsDir)) {
    for (const entry of readdirSync(kodaSkillsDir)) {
      try {
        const full = resolve(kodaSkillsDir, entry);
        const st = statSync(full);
        if (st.isFile() && entry.endsWith(".md")) {
          kodaSkills.push(`${entry.replace(/\.md$/, "")} (flat)`);
        } else if (st.isDirectory() && existsSync(resolve(full, "SKILL.md"))) {
          kodaSkills.push(`${entry} (directory)`);
        }
      } catch { /* ignore */ }
    }
  }
  console.log(`  Koda (~/.koda/skills/) — ${kodaSkills.length}:`);
  if (kodaSkills.length === 0) {
    console.log("    (none)");
  } else {
    for (const s of kodaSkills.sort()) console.log(`    ${s}`);
  }
  console.log("");

  // Claude Code Agent Skills
  const claudeSkills: string[] = [];
  const claudeSkillsDir = resolve(homedir(), ".claude/skills");
  if (existsSync(claudeSkillsDir)) {
    for (const entry of readdirSync(claudeSkillsDir)) {
      try {
        if (statSync(resolve(claudeSkillsDir, entry)).isDirectory()) {
          claudeSkills.push(entry);
        }
      } catch { /* ignore */ }
    }
  }
  console.log(`  Claude Code Agent Skills (~/.claude/skills/) — ${claudeSkills.length}:`);
  if (claudeSkills.length === 0) {
    console.log("    (none)");
  } else {
    for (const s of claudeSkills.sort()) console.log(`    ${s}`);
  }
  console.log("");

  // Claude Code plugins
  const plugins: string[] = [];
  const pluginsFile = resolve(homedir(), ".claude/plugins/installed_plugins.json");
  if (existsSync(pluginsFile)) {
    try {
      const data = JSON.parse(readFileSync(pluginsFile, "utf-8")) as { plugins?: Record<string, unknown> };
      plugins.push(...Object.keys(data.plugins ?? {}));
    } catch { /* ignore */ }
  }
  console.log(`  Claude Code plugins (~/.claude/plugins/) — ${plugins.length}:`);
  if (plugins.length === 0) {
    console.log("    (none)");
  } else {
    for (const p of plugins.sort()) console.log(`    ${p}`);
  }
  console.log("");

  return 0;
}
