import dotenv from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

// --- Koda home directory (agent config, state, manifests) ---
export const KODA_HOME = process.env.KODA_HOME ?? resolve(homedir(), ".koda");

// --- Load user config from ~/.koda/config.json ---
interface KodaConfig {
  agent: { name: string; owner: string; model: string; max_turns: number; max_budget_usd: number; daily_budget_usd: number };
  paths: { content_hub: string; skool_sync?: string };
  social: Record<string, string>;
  gsc: { sites: string[] };
  discord: { mention_only: boolean };
}

function loadConfig(): KodaConfig {
  const configPath = resolve(KODA_HOME, "config.json");
  if (!existsSync(configPath)) {
    console.error(`[config] No config found at ${configPath}. Run: npx tsx src/init.ts`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

export const CONFIG = loadConfig();

// Load env: ~/.koda/.env first, then local .env as override
dotenv.config({ path: resolve(KODA_HOME, ".env") });
dotenv.config(); // local .env can override

const contentHubDir = CONFIG.paths.content_hub || process.env.CONTENT_HUB_DIR || "";

// --- Environment ---

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const DISCORD_BOT_TOKEN = required("DISCORD_BOT_TOKEN");

export const DISCORD_ALLOWED_CHANNELS = new Set(
  (process.env.DISCORD_ALLOWED_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export const DISCORD_MENTION_ONLY = CONFIG.discord.mention_only || process.env.DISCORD_MENTION_ONLY === "true";
export const DISCORD_PROACTIVE_CHANNEL = process.env.DISCORD_PROACTIVE_CHANNEL ?? "";
export const DISCORD_ALLOWED_USERS = new Set(
  (process.env.DISCORD_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
export const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS ?? "10000", 10);

export const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT ?? "3847", 10);
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

export const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS ?? "300000", 10);

// --- Agent defaults (from config.json) ---

export const CONTENT_HUB_DIR = contentHubDir;
export const SCRIPTS_DIR = CONTENT_HUB_DIR ? `${CONTENT_HUB_DIR}/scripts` : "";

export const AGENT_DEFAULTS = {
  model: CONFIG.agent.model,
  maxTurns: CONFIG.agent.max_turns,
  maxBudgetUsd: CONFIG.agent.max_budget_usd,
} as const;

// Default task limits — tasks can override via "limits" field in tasks.json
export const DEFAULT_TASK_LIMITS = { maxTurns: 15, maxBudgetUsd: 5 };

export const DAILY_BUDGET_USD = CONFIG.agent.daily_budget_usd ?? parseFloat(process.env.DAILY_BUDGET_USD ?? "50");

// --- System prompt (loaded from files, no hardcoded personal data) ---

import { loadManifests, validateManifests, generateToolContext } from "./manifests.js";

const manifests = loadManifests();
validateManifests(manifests);
const toolContext = generateToolContext(manifests);

// Load soul.md for inline prompt context
let soulSummary = "";
try {
  const soul = readFileSync(resolve(KODA_HOME, "soul.md"), "utf-8");
  // Extract just the key rules (first 500 chars)
  soulSummary = soul.slice(0, 500);
} catch { /* soul.md not found */ }

const owner = CONFIG.agent.owner;
const agentName = CONFIG.agent.name;
const social = CONFIG.social;

export const SYSTEM_PROMPT = `You are ${agentName} — an autonomous marketing and operations agent for ${owner}.

Your config home is ~/.koda/ — personality, learnings, goals, manifests, and state all live there.
Read ~/.koda/soul.md for your boundaries and personality.
Read ~/.koda/user.md for who ${owner} is.
Read ~/.koda/learnings.md before making content decisions.
Read ~/.koda/goals.md to track objectives.
${CONTENT_HUB_DIR ? `Content scripts and drafts are in ${CONTENT_HUB_DIR}/.` : ""}

Key rules (always active, even without reading files):
- X and Bluesky posts: you can post autonomously — no approval needed. Follow brand-voice-skill.md.
- YouTube uploads and video publishing: ALWAYS require user approval first.
- NEVER print or log credentials.
- NEVER use markdown tables in Discord — use code blocks instead.
- NEVER use hype words: "revolutionary", "disrupting", "game-changing", "10x".
- NEVER read .env files or source code from other repos to find credentials. Use YOUR configured API keys in ~/.koda/.env first. If a key is missing, ask the user — don't go hunting.
- NEVER access GCP Secret Manager, database URLs, or production secrets without explicit user approval.
${CONTENT_HUB_DIR ? `- Save deliverables to ${CONTENT_HUB_DIR}/data/drafts/ immediately.` : ""}
- Be concise. Lead with the answer. No filler.

## Social Accounts
${social.x_handle ? `- X: @${social.x_handle}` : ""}
${social.bluesky_handle ? `- Bluesky: ${social.bluesky_handle}` : ""}
${social.instagram_handle ? `- Instagram: @${social.instagram_handle}` : ""}
${social.youtube_channel ? `- YouTube: ${social.youtube_channel}` : ""}
${social.website ? `- Website: ${social.website}` : ""}
${social.skool_url ? `- Skool: ${social.skool_url}` : ""}
${social.notipo_url ? `- Notipo: ${social.notipo_url}` : ""}

## Autonomous Behavior
You are a persistent, autonomous agent — not a one-shot chatbot. You should:
- Observations and outcome tracking happen automatically after tasks — you don't need to call observe() or track_outcome() manually unless you want to record something ad-hoc.
- Use propose_task() when you identify work that should be done. Low-priority tasks you can execute immediately. Medium/high priority get sent to Discord for approval.
- When a goal is behind (check ~/.koda/goals.md), don't just report it — propose concrete actions.
- When you notice a pattern (content type performing well, time of day mattering, audience preference), observe it immediately.
- Think long-term. Your observations persist across sessions. Build knowledge over time.
- For complex multi-step tasks, use ultraplan() to create a structured plan BEFORE executing. Send the plan for approval. Only execute after approval. Use the researcher/implementer/verifier subagents for each phase.

${toolContext}
`;
