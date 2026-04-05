/**
 * koda init — set up ~/.koda/ directory with config and template files.
 * Like `openclaw onboard` — generates user-specific config from templates.
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const KODA_HOME = resolve(homedir(), ".koda");
const TEMPLATES_DIR = resolve(import.meta.dirname ?? ".", "..", "templates");

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
];

const TEMPLATE_FILES = [
  { src: "config.json", dst: "config.json" },
  { src: "soul.md", dst: "soul.md" },
  { src: "user.md", dst: "user.md" },
  { src: "learnings.md", dst: "learnings.md" },
  { src: "goals.md", dst: "goals.md" },
  { src: "mcp-servers.json", dst: "mcp-servers.json" },
];

function init() {
  console.log(`Initializing Koda home directory: ${KODA_HOME}\n`);

  // Create directories
  for (const dir of DIRS) {
    const path = resolve(KODA_HOME, dir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
      console.log(`  Created: ${dir || "~/.koda/"}`);
    }
  }

  // Copy template files (skip if already exist)
  for (const { src, dst } of TEMPLATE_FILES) {
    const target = resolve(KODA_HOME, dst);
    if (existsSync(target)) {
      console.log(`  Exists:  ${dst} (skipped)`);
    } else {
      copyFileSync(resolve(TEMPLATES_DIR, src), target);
      console.log(`  Created: ${dst}`);
    }
  }

  // Create .env.example
  const envExample = resolve(KODA_HOME, ".env.example");
  if (!existsSync(envExample)) {
    writeFileSync(envExample, `# Required
DISCORD_BOT_TOKEN=
DISCORD_ALLOWED_CHANNELS=
DISCORD_PROACTIVE_CHANNEL=
DISCORD_ALLOWED_USERS=

# Content hub (path to your content scripts/pipeline)
CONTENT_HUB_DIR=

# Social (set these in ~/.secrets.zsh or here)
# X_CONSUMER_KEY=
# X_CONSUMER_SECRET=
# X_ACCESS_TOKEN=
# X_ACCESS_TOKEN_SECRET=
# BLUESKY_HANDLE=
# BLUESKY_APP_PASSWORD=
# NOTIPO_API_KEY=
# NOTIPO_URL=https://notipo.com
# GEMINI_API_KEY=
# AIRTABLE_API_KEY=

# Optional
# TICK_INTERVAL_MS=0
# DAILY_BUDGET_USD=50
# KODA_HOME=~/.koda
`);
    console.log(`  Created: .env.example`);
  }

  console.log(`
Done! Next steps:

  1. Edit ~/.koda/config.json with your details
  2. Edit ~/.koda/soul.md and ~/.koda/user.md
  3. Add MCP servers to ~/.koda/mcp-servers.json
  4. Add plugin manifests to ~/.koda/manifests/
  5. Set required env vars (see ~/.koda/.env.example)
  6. Run: npx tsx src/index.ts
`);
}

init();
