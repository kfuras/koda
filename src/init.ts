/**
 * koda init — set up ~/.koda/ directory with config and template files.
 *
 * Like `openclaw onboard`: creates the user's ~/.koda/ structure and copies
 * template files into place on first install. Never overwrites existing
 * files — your config, memory, and skills are safe.
 *
 * Usage: `npx tsx src/init.ts` (or run via `koda init` once that command lands)
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const KODA_HOME = resolve(homedir(), ".koda");

// Walk up from this file to find the repo root (works from both src/ and dist/)
function findRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (dir !== "/" && dir !== ".") {
    if (existsSync(resolve(dir, "package.json")) && existsSync(resolve(dir, "templates"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find repo root with templates/ dir from ${here}`);
}

const REPO_ROOT = findRepoRoot();
const TEMPLATES_DIR = resolve(REPO_ROOT, "templates");

// Directories to create under ~/.koda/
const DIRS = [
  "",
  "data",
  "data/outcomes",
  "data/plans",
  "data/.task-results",
  "data/autonomous-logs",
  "data/daily-logs",
  "logs",
  "manifests",
  "skills",
  "servers",
  "scripts",
  "backups",
];

/**
 * Template files to copy on first run.
 * - src: filename under templates/ (with .example suffix)
 * - dst: filename in ~/.koda/ (without .example suffix — this is what Koda reads)
 */
const TEMPLATE_FILES = [
  { src: "config.example.json",       dst: "config.json" },
  { src: "soul.example.md",           dst: "soul.md" },
  { src: "user.example.md",           dst: "user.md" },
  { src: "goals.example.md",          dst: "goals.md" },
  { src: "learnings.example.md",      dst: "learnings.md" },
  { src: "mcp-servers.example.json",  dst: "mcp-servers.json" },
  { src: "tasks.example.json",        dst: "tasks.json" },
];

function init(): void {
  console.log(`Initializing Koda home at ${KODA_HOME}\n`);

  // 1. Create directories
  console.log("Creating directories:");
  for (const dir of DIRS) {
    const path = resolve(KODA_HOME, dir);
    if (existsSync(path)) {
      console.log(`  exists   ${dir || "~/.koda/"}`);
    } else {
      mkdirSync(path, { recursive: true });
      console.log(`  created  ${dir || "~/.koda/"}`);
    }
  }

  // 2. Copy template files (never overwrite existing user config)
  console.log("\nCopying template files:");
  for (const { src, dst } of TEMPLATE_FILES) {
    const srcPath = resolve(TEMPLATES_DIR, src);
    const dstPath = resolve(KODA_HOME, dst);

    if (!existsSync(srcPath)) {
      console.log(`  skipped  ${dst}  (template ${src} missing in repo)`);
      continue;
    }
    if (existsSync(dstPath)) {
      console.log(`  exists   ${dst}  (kept — your version preserved)`);
      continue;
    }
    copyFileSync(srcPath, dstPath);
    console.log(`  created  ${dst}`);
  }

  // 3. Also write the .example versions alongside real files for reference
  // This way users can always see the latest template without losing their config
  console.log("\nWriting reference copies (always overwritten):");
  for (const { src } of TEMPLATE_FILES) {
    const srcPath = resolve(TEMPLATES_DIR, src);
    const dstPath = resolve(KODA_HOME, src);
    if (!existsSync(srcPath)) continue;
    copyFileSync(srcPath, dstPath);
    console.log(`  wrote    ${src}`);
  }

  // 4. Copy .env.example from the repo root
  const repoEnvExample = resolve(REPO_ROOT, ".env.example");
  const kodaEnvExample = resolve(KODA_HOME, ".env.example");
  if (existsSync(repoEnvExample)) {
    copyFileSync(repoEnvExample, kodaEnvExample);
    console.log(`\n  wrote    .env.example  (from repo root)`);
  }

  // 5. Copy example skills (preserves existing skill dirs)
  const srcSkillsDir = resolve(TEMPLATES_DIR, "skills");
  const dstSkillsDir = resolve(KODA_HOME, "skills");
  if (existsSync(srcSkillsDir)) {
    console.log("\nCopying example skills:");
    for (const entry of readdirSync(srcSkillsDir)) {
      const src = resolve(srcSkillsDir, entry);
      const dst = resolve(dstSkillsDir, entry);
      try {
        const st = statSync(src);
        if (st.isFile() && entry.endsWith(".md")) {
          if (existsSync(dst)) {
            console.log(`  exists   skills/${entry}`);
          } else {
            copyFileSync(src, dst);
            console.log(`  created  skills/${entry}`);
          }
        } else if (st.isDirectory()) {
          if (existsSync(dst)) {
            console.log(`  exists   skills/${entry}/`);
          } else {
            copySkillDirectory(src, dst);
            console.log(`  created  skills/${entry}/`);
          }
        }
      } catch { /* ignore */ }
    }
  }

  // 6. Copy MCP servers (preserves existing)
  const srcServersDir = resolve(TEMPLATES_DIR, "servers");
  const dstServersDir = resolve(KODA_HOME, "servers");
  if (existsSync(srcServersDir)) {
    console.log("\nCopying MCP servers:");
    for (const entry of readdirSync(srcServersDir)) {
      const src = resolve(srcServersDir, entry);
      const dst = resolve(dstServersDir, entry);
      if (statSync(src).isFile() && entry.endsWith(".py")) {
        if (existsSync(dst)) {
          console.log(`  exists   servers/${entry}`);
        } else {
          copyFileSync(src, dst);
          console.log(`  created  servers/${entry}`);
        }
      }
    }
  }

  console.log(`
${"-".repeat(60)}
Koda home ready at ${KODA_HOME}

Next steps:
  1. Edit ~/.koda/config.json           (name, social handles, model budgets)
  2. Edit ~/.koda/soul.md                (agent personality, working style)
  3. Edit ~/.koda/user.md                (who you are, your projects, your voice)
  4. Edit ~/.koda/goals.md               (measurable targets)
  5. Edit ~/.koda/tasks.json             (scheduled tasks — or keep the examples)
  6. Copy ~/.koda/.env.example → ~/.koda/.env and fill in secrets
  7. Run: koda doctor                   (verify your setup)
  8. Run: pm2 start ecosystem.config.cjs  (start the daemon)
  9. Run: koda status                   (check it's running)

The .example files in ~/.koda/ are reference copies — refreshed on every
run of init. Your real files (without .example) are never overwritten.
`);
}

function copySkillDirectory(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcFile = resolve(src, entry);
    const dstFile = resolve(dst, entry);
    const st = statSync(srcFile);
    if (st.isFile()) {
      copyFileSync(srcFile, dstFile);
    } else if (st.isDirectory()) {
      copySkillDirectory(srcFile, dstFile);
    }
  }
}

init();
