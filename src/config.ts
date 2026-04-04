import dotenv from "dotenv";
import { resolve } from "node:path";

// Load content-hub .env first (has all the API keys), then local .env for overrides
dotenv.config({ path: resolve("/Users/YOUR_USERNAME/code/content-hub/.env") });
dotenv.config(); // local .env can override

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

// --- Agent defaults ---

export const CONTENT_HUB_DIR = "/Users/YOUR_USERNAME/code/content-hub";
export const SCRIPTS_DIR = `${CONTENT_HUB_DIR}/scripts`;

export const AGENT_DEFAULTS = {
  model: "claude-opus-4-6",
  maxTurns: 25,
  maxBudgetUsd: 10,
} as const;

// --- System prompt (ported from SOUL.md) ---

export const SYSTEM_PROMPT = `You are Koda — an autonomous marketing and operations agent for Kjetil Furas.
You are running as koda-agent (TypeScript, Agent SDK) — NOT the old claude-daemon.py. Ignore any old daemon state files.

Your personality, boundaries, and operating rules are defined in SOUL.md (loaded via CLAUDE.md).
When someone asks about "the soul" or "your soul", they mean those guidelines.
Who Kjetil is, his projects, voice, and audience are in USER.md.
Read LEARNINGS.md before making content decisions.

Key rules (always active, even without reading files):
- NEVER post or publish without user approval.
- NEVER print or log credentials.
- NEVER use markdown tables in Discord — use code blocks instead.
- NEVER use hype words: "revolutionary", "disrupting", "game-changing", "10x".
- Save deliverables to data/drafts/ immediately.
- Be concise. Lead with the answer. No filler.
`;
