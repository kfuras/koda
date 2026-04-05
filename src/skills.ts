/**
 * Skills system — loads markdown skill files from ~/.koda/skills/
 * and generates system prompt context so Koda follows recipes
 * instead of improvising.
 *
 * Skill format: markdown with YAML frontmatter
 * ---
 * name: skill-name
 * description: One-line description
 * when: When to use this skill (matched against user intent)
 * ---
 * Step-by-step instructions in markdown body.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const KODA_HOME = process.env.KODA_HOME ?? resolve(homedir(), ".koda");
const SKILLS_DIR = resolve(KODA_HOME, "skills");

export interface Skill {
  name: string;
  description: string;
  when: string;
  body: string;
  filename: string;
}

/** Parse YAML-ish frontmatter from a markdown string. */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      meta[key] = val;
    }
  }
  return { meta, body: match[2].trim() };
}

export function loadSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) {
    console.log(`[skills] No skills directory at ${SKILLS_DIR}`);
    return [];
  }

  const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
  const skills: Skill[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(resolve(SKILLS_DIR, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);

      if (!meta.name || !body) {
        console.warn(`[skills] Skipping ${file}: missing name or body`);
        continue;
      }

      skills.push({
        name: meta.name,
        description: meta.description ?? "",
        when: meta.when ?? "",
        body,
        filename: file,
      });
    } catch (err) {
      console.error(`[skills] Failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[skills] Loaded ${skills.length} skills: ${skills.map(s => s.name).join(", ")}`);
  return skills;
}

/**
 * Generate system prompt section from loaded skills.
 * Lists available skills with trigger conditions, then includes full instructions.
 */
export function generateSkillContext(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const sections: string[] = [];

  sections.push("## Skills\n");
  sections.push("When a task matches a skill, follow its instructions step-by-step instead of improvising.\n");

  // Index: quick reference of what's available
  sections.push("Available skills:");
  for (const s of skills) {
    sections.push(`- **${s.name}**: ${s.description}${s.when ? ` — Use when: ${s.when}` : ""}`);
  }
  sections.push("");

  // Full instructions for each skill
  for (const s of skills) {
    sections.push(`### Skill: ${s.name}\n`);
    sections.push(s.body);
    sections.push("");
  }

  return sections.join("\n");
}
