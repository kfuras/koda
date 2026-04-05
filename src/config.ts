import dotenv from "dotenv";
import { resolve } from "node:path";

// Load content-hub .env first (has all the API keys), then local .env for overrides
dotenv.config({ path: resolve(process.env.CONTENT_HUB_DIR ?? "/Users/YOUR_USERNAME/code/content-hub", ".env") });
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

export const DISCORD_MENTION_ONLY = process.env.DISCORD_MENTION_ONLY === "true";
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

export const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS ?? "300000", 10); // 5 min default

// --- Agent defaults ---

export const CONTENT_HUB_DIR = process.env.CONTENT_HUB_DIR ?? "/Users/YOUR_USERNAME/code/content-hub";
export const SCRIPTS_DIR = `${CONTENT_HUB_DIR}/scripts`;

export const AGENT_DEFAULTS = {
  model: "claude-opus-4-6",
  maxTurns: 25,
  maxBudgetUsd: 10,
} as const;

// Per-task turn limits and budget caps
export const TASK_LIMITS: Record<string, { maxTurns: number; maxBudgetUsd: number }> = {
  // Lightweight tasks (analytics, checks)
  youtube_analytics: { maxTurns: 8, maxBudgetUsd: 2 },
  gsc_analytics: { maxTurns: 10, maxBudgetUsd: 3 },
  instagram_analytics: { maxTurns: 8, maxBudgetUsd: 2 },
  bluesky_stats: { maxTurns: 5, maxBudgetUsd: 1 },
  learnings_review: { maxTurns: 5, maxBudgetUsd: 1 },
  skool_member_sync: { maxTurns: 8, maxBudgetUsd: 2 },
  goal_check: { maxTurns: 5, maxBudgetUsd: 1 },
  meta_token_check: { maxTurns: 5, maxBudgetUsd: 1 },
  // Medium tasks (scanning, drafting)
  x_feed_scan: { maxTurns: 10, maxBudgetUsd: 3 },
  viral_tweet_scan: { maxTurns: 15, maxBudgetUsd: 5 },
  cta_replies: { maxTurns: 10, maxBudgetUsd: 3 },
  social_post: { maxTurns: 15, maxBudgetUsd: 5 },
  brand_voice_learn: { maxTurns: 15, maxBudgetUsd: 5 },
  voice_profile_refresh: { maxTurns: 10, maxBudgetUsd: 3 },
  // Heavy tasks (articles, blog posts, lessons)
  content_proposal: { maxTurns: 20, maxBudgetUsd: 8 },
  skool_post: { maxTurns: 20, maxBudgetUsd: 8 },
  x_article: { maxTurns: 30, maxBudgetUsd: 10 },
  lesson_draft: { maxTurns: 25, maxBudgetUsd: 8 },
};

export const DEFAULT_TASK_LIMITS = { maxTurns: 15, maxBudgetUsd: 5 };

// Daily budget cap
export const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD ?? "50");

// --- System prompt (ported from SOUL.md) ---

export const SYSTEM_PROMPT = `You are Koda — an autonomous marketing and operations agent for Kjetil Furas.
You are running as koda-agent (TypeScript, Agent SDK) — NOT the old claude-daemon.py. Ignore any old daemon state files.

Your personality, boundaries, and operating rules are defined in SOUL.md (loaded via CLAUDE.md).
When someone asks about "the soul" or "your soul", they mean those guidelines.
Who Kjetil is, his projects, voice, and audience are in USER.md.
Read LEARNINGS.md before making content decisions.

Key rules (always active, even without reading files):
- X and Bluesky posts: you can post autonomously — no approval needed. Follow brand-voice-skill.md.
- YouTube uploads and video publishing: ALWAYS require user approval first.
- NEVER print or log credentials.
- NEVER use markdown tables in Discord — use code blocks instead.
- NEVER use hype words: "revolutionary", "disrupting", "game-changing", "10x".
- Save deliverables to data/drafts/ immediately.
- Be concise. Lead with the answer. No filler.

## Autonomous Behavior
You are a persistent, autonomous agent — not a one-shot chatbot. You should:
- Use the observe() tool to record patterns, preferences, and facts as you work. These feed the nightly dream cycle which consolidates them into LEARNINGS.md.
- Use propose_task() when you identify work that should be done. Low-priority tasks you can execute immediately. Medium/high priority get sent to Discord for approval.
- Use track_outcome() after publishing content. You'll check performance later and record what worked.
- When a goal is behind (check GOALS.md), don't just report it — propose concrete actions.
- When you notice a pattern (content type performing well, time of day mattering, audience preference), observe it immediately.
- Think long-term. Your observations persist across sessions. Build knowledge over time.
- For complex multi-step tasks, use ultraplan() to create a structured plan BEFORE executing. Send the plan for approval. Only execute after approval. Use the researcher/implementer/verifier subagents for each phase.
`;
