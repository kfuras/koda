/**
 * Dream Cycle — 3-phase scored memory consolidation.
 *
 * Inspired by OpenClaw's dreaming system (confirmed from source):
 *   1. Light (2-day lookback) — ingest observations, dedupe, stage candidates
 *   2. REM (7-day lookback) — process task results/logs, extract patterns, score
 *   3. Deep — apply threshold gates, promote survivors to learnings.md
 *
 * Scoring uses 6 weighted signals (from OpenClaw's dreaming-phases.ts):
 *   Relevance 0.30, Frequency 0.24, Query diversity 0.15,
 *   Recency 0.15, Consolidation 0.10, Richness 0.06
 *
 * Forgetting curve: exp(-(ln(2)/14) * ageDays) — 14-day half-life
 * Threshold gates: minScore 0.75, minRecallCount 3, minUniqueQueries 2
 *
 * Runs as a forked isolated task with constrained budget.
 */

import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { KODA_HOME } from "./config.js";
import { type KodaAgent } from "./agent.js";
import { type KodaBot } from "./bot.js";
import { stateFileQueue } from "./patterns.js";

// --- Lock ---

const LOCK_FILE = resolve(KODA_HOME, "data/.dream-lock");
const LOCK_STALE_MS = 60 * 60_000; // 1 hour

async function tryAcquireLock(): Promise<boolean> {
  try {
    const s = await stat(LOCK_FILE);
    const age = Date.now() - s.mtimeMs;
    if (age < LOCK_STALE_MS) {
      // Check if holding PID is still alive
      const pid = parseInt(await readFile(LOCK_FILE, "utf-8"), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0); // signal 0 = existence check
          console.log(`[dream] Lock held by live PID ${pid} (${Math.round(age / 1000)}s old)`);
          return false;
        } catch {
          // PID is dead — reclaim
        }
      }
    }
    // Stale or dead PID — reclaim
  } catch {
    // No lock file — good
  }

  await mkdir(resolve(KODA_HOME, "data"), { recursive: true });
  await writeFile(LOCK_FILE, String(process.pid));

  // Verify we won the race
  try {
    const content = await readFile(LOCK_FILE, "utf-8");
    if (parseInt(content.trim(), 10) !== process.pid) return false;
  } catch {
    return false;
  }

  return true;
}

async function releaseLock(): Promise<void> {
  try {
    // Update mtime to record last consolidation time, clear PID
    await writeFile(LOCK_FILE, "");
  } catch {
    // Best effort
  }
}

async function rollbackLock(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(LOCK_FILE);
  } catch {
    // Best effort
  }
}

// --- Consolidation prompt ---

function buildConsolidationPrompt(): string {
  const memoryDir = KODA_HOME;
  const dataDir = resolve(KODA_HOME, "data");
  const today = new Date().toISOString().slice(0, 10);

  return `# Dream: 3-Phase Scored Memory Consolidation

You are performing a dream — a scored consolidation of recent observations into durable learnings.
Unlike a simple merge, you will SCORE each candidate observation before deciding whether to promote it.

Memory home: \`${memoryDir}\`
Data directory: \`${dataDir}\`
Today: ${today}

## CRITICAL TOOL CONSTRAINTS

You may ONLY use these tools:
- **Read** — read any file (unrestricted)
- **Glob** — find files by pattern (unrestricted)
- **Grep** — search file contents (unrestricted)
- **Bash** — ONLY read-only commands: ls, find, grep, cat, stat, wc, head, tail, and similar.
  Do NOT run any command that writes, deletes, redirects to a file, or modifies state.
- **Edit/Write** — ONLY for files within \`${memoryDir}/\` and \`${dataDir}/\`.
  Do NOT write to any path outside these directories.

Do NOT use: MCP tools, Agent tool, WebSearch, WebFetch, or any write-capable Bash.
Do NOT delete files. Do NOT run git commands. Do NOT install packages.

---

## Phase 1 — LIGHT (2-day lookback)

Purpose: Ingest recent observations, deduplicate, stage candidates.

1. Read \`${dataDir}/observations.md\` — focus on entries from the last 2 days only.
2. Read \`${memoryDir}/learnings.md\` to know what already exists (avoid duplicates).
3. For each recent observation, check:
   - Is it already captured in learnings.md? → SKIP (duplicate)
   - Is it nearly identical to another recent observation? → MERGE (keep the better-worded one)
   - Is it trivially obvious or ephemeral? → SKIP
4. Build a candidate list of observations that passed dedup. For each, note:
   - The observation text
   - Its date
   - Its type tag ([rule], [preference], [fact], etc.)

This phase NEVER writes to learnings.md. Only stages candidates.

## Phase 2 — REM (7-day lookback)

Purpose: Enrich candidates with frequency/context data, score each one.

1. Scan broader sources for supporting evidence (7-day window):
   - \`${dataDir}/observations.md\` — grep for similar themes to each candidate
   - \`${dataDir}/.task-results/\` — last 3 days of JSON files (failures, expensive tasks, patterns)
   - \`${dataDir}/autonomous-logs/\` — last 3 days (grep for FAILED, ERROR, healed, expensive)

2. For each candidate, calculate a score using these 6 signals:

   | Signal | Weight | How to assess |
   |--------|--------|---------------|
   | **Relevance** | 0.30 | How relevant is this to the agent's current goals and work? (Read goals.md) |
   | **Frequency** | 0.24 | How many times has this insight appeared? Use: log(hitCount+1)/log(7). 1 mention=0.36, 3=0.71, 6=1.0 |
   | **Query diversity** | 0.15 | How many different contexts/tasks surfaced this? (1 context=0.3, 2=0.6, 3+=1.0) |
   | **Recency** | 0.15 | How recent? Use forgetting curve: exp(-(0.693/14)*ageDays). Today=1.0, 7d=0.71, 14d=0.50, 30d=0.23 |
   | **Consolidation** | 0.10 | Does this connect to or strengthen existing learnings? (0=isolated, 1=fits a pattern) |
   | **Richness** | 0.06 | How conceptually deep? (0=trivial fact, 1=non-obvious insight with WHY) |

   Final score = sum of (signal_value × weight). Range: 0.0 to 1.0.

3. Also check \`${memoryDir}/goals.md\`:
   - Update progress on active goals based on task results
   - Flag goals that appear stalled (no progress in 7+ days)
   - Remove goals that are clearly completed

## Phase 3 — DEEP (promote or prune)

Purpose: Apply threshold gates, promote survivors, prune stale entries.

### Promotion gates (ALL must pass):
- **minScore: 0.75** — final score must be at least 0.75
- **minRecallCount: 3** — observation must have appeared in 3+ separate entries/contexts
- **minUniqueQueries: 2** — must have been referenced from 2+ different topics/tasks

Only candidates passing ALL three gates get promoted to \`${memoryDir}/learnings.md\`.
Maximum 10 promotions per dream cycle.

### How to promote:
- **Merge** into existing sections rather than appending duplicates
- **Convert** relative dates to absolute dates
- **Delete** contradicted facts — if today's evidence disproves an old learning, fix it
- One line per learning, prefixed with "- "
- Group by topic. Include WHY when non-obvious.
- Never write secrets, credentials, or personal data

### Pruning:
- \`learnings.md\` must stay under 100 lines. If over, remove entries with lowest estimated scores.
- \`observations.md\` — remove observations older than: 30 days (events), 90 days (facts),
  180 days (preferences/goals), 365 days (rules). Move expired to \`${dataDir}/observations-archive.md\`.
- Deduplicate observations that say the same thing in different words.

### What NOT to write to learnings.md:
- Things derivable from code or git history
- Debugging solutions (the fix is in the code)
- Anything already in soul.md or user.md
- Ephemeral task details or temporary state

## Output

Return a structured summary:
1. Candidates staged (Light phase count)
2. Candidates scored (list each with its score and pass/fail)
3. Promotions made (what was added/updated in learnings.md)
4. Pruning done (what was removed or archived)
5. Goals updated (any changes to goals.md)

If nothing changed, say "Dream cycle: nothing to consolidate."`;
}

// --- Cross-agent librarian prompt ---

function buildLibrarianPrompt(): string {
  const sharedDir = resolve(KODA_HOME, "shared");
  const crossfeedDir = resolve(KODA_HOME, "crossfeed");
  const agentsDir = resolve(KODA_HOME, "agents");
  const today = new Date().toISOString().slice(0, 10);

  return `# Dream: Cross-Agent Librarian

You are the librarian — you read all agents' recent observations and learnings,
then cross-pollinate intelligence between them.

Today: ${today}
Shared directory: \`${sharedDir}\`
Crossfeed directory: \`${crossfeedDir}\`
Agent workspaces: \`${agentsDir}/social/\`, \`${agentsDir}/content/\`, \`${agentsDir}/analytics/\`
Home workspace: \`${KODA_HOME}\`

## CRITICAL TOOL CONSTRAINTS

You may ONLY use these tools:
- **Read** — read any file (unrestricted)
- **Glob** — find files by pattern (unrestricted)
- **Grep** — search file contents (unrestricted)
- **Edit/Write** — ONLY for files within \`${sharedDir}/\`, \`${crossfeedDir}/\`, and \`${KODA_HOME}/data/\`.
  Do NOT write to agent workspace files — those belong to the agents themselves.

Do NOT use: MCP tools, Agent tool, WebSearch, WebFetch, Bash, or any other tool.

---

## Step 1 — Read all agents' recent knowledge

Read these files (skip if they don't exist yet):
- \`${KODA_HOME}/learnings.md\` (home agent)
- \`${agentsDir}/social/learnings.md\`
- \`${agentsDir}/content/learnings.md\`
- \`${agentsDir}/analytics/learnings.md\`
- \`${KODA_HOME}/data/observations.md\` (home observations)
- \`${agentsDir}/social/data/observations.md\`
- \`${agentsDir}/content/data/observations.md\`
- \`${agentsDir}/analytics/data/observations.md\`

Also read the current shared files:
- \`${sharedDir}/preferences.md\`
- \`${sharedDir}/goals.md\`
- \`${crossfeedDir}/digest.md\`

## Step 2 — Classify each learning/observation

For each notable item found across all agents, classify it:

| Classification | Action |
|----------------|--------|
| **User-wide preference** (tone, style, rules, boundaries) | Promote to \`${sharedDir}/preferences.md\` |
| **Cross-domain insight** (social trend useful for content, analytics insight useful for social) | Add to \`${crossfeedDir}/digest.md\` |
| **Goal update** (progress on shared goals from any agent) | Update \`${sharedDir}/goals.md\` |
| **Domain-specific only** | Leave where it is — don't move or copy |

## Step 3 — Update shared files

### ${sharedDir}/preferences.md
- Add any new user-wide preferences discovered by any agent
- Remove duplicates — don't repeat what's already there
- Keep under 50 lines

### ${crossfeedDir}/digest.md
- Replace the entire digest with fresh cross-pollination entries
- Format: one entry per insight, with source agent and why it's relevant to other agents
- Example entries:
  - "[from social] AI topics get 3x engagement on X — content agent should prioritize AI content"
  - "[from analytics] Physics/space Shorts get 2x retention — social agent should promote these"
  - "[from content] New Anthropic release (Claude Managed Agents) — social agent should post about this"
- Keep under 30 lines. Only include genuinely cross-useful insights.
- Remove stale entries (older than 14 days or no longer relevant)

### ${sharedDir}/goals.md
- Update goal progress based on analytics agent data
- If the home agent's goals.md has been updated, sync relevant changes here

## Output

Return a brief summary:
1. Items found across agents
2. Preferences promoted to shared
3. Cross-pollination entries added to digest
4. Goals updated

If nothing cross-agent was found, say "Librarian: no cross-agent insights to share."`;
}

// --- Main entry point ---

export async function runDreamCycle(
  agent: KodaAgent,
  bot: KodaBot,
): Promise<void> {
  console.log("[dream] Starting LLM-driven dream cycle...");

  // Acquire lock
  if (!(await tryAcquireLock())) {
    console.log("[dream] Could not acquire lock — skipping");
    return;
  }

  let totalCost = 0;

  try {
    // --- Phase A: Per-agent consolidation (scored 3-phase dream) ---
    const prompt = buildConsolidationPrompt();

    const result = await agent.runIsolatedTask("dream_cycle", prompt, {
      maxTurns: 20,
      maxBudgetUsd: 3,
    });

    totalCost += result.cost;

    if (result.isError) {
      console.error(`[dream] Consolidation failed ($${result.cost.toFixed(2)}, ${result.turns}t): ${result.text.slice(0, 200)}`);
      await rollbackLock();

      await bot.sendToChannel(
        `**[dream_cycle]** Consolidation failed ($${result.cost.toFixed(2)})\n\n${result.text.slice(0, 500)}`,
      );
      return;
    }

    console.log(`[dream] Consolidation complete ($${result.cost.toFixed(2)}, ${result.turns}t)`);

    // --- Phase B: Cross-agent librarian ---
    console.log("[dream] Starting cross-agent librarian...");

    const librarianPrompt = buildLibrarianPrompt();
    const libResult = await agent.runIsolatedTask("dream_librarian", librarianPrompt, {
      maxTurns: 15,
      maxBudgetUsd: 2,
    }, "claude-sonnet-4-6"); // librarian runs on sonnet — cheaper, doesn't need creativity

    totalCost += libResult.cost;

    if (libResult.isError) {
      console.error(`[dream] Librarian failed ($${libResult.cost.toFixed(2)}): ${libResult.text.slice(0, 200)}`);
      // Non-fatal — consolidation already succeeded
    } else {
      console.log(`[dream] Librarian complete ($${libResult.cost.toFixed(2)}, ${libResult.turns}t)`);
    }

    await releaseLock();

    // Log the summary
    await stateFileQueue.run(async () => {
      const logDir = resolve(KODA_HOME, "data/autonomous-logs");
      await mkdir(logDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const line = `[${new Date().toISOString()}] [dream_cycle] ($${totalCost.toFixed(2)}) ${result.text.slice(0, 300)}` +
        (libResult.isError ? "" : ` | Librarian: ${libResult.text.slice(0, 200)}`) + "\n";
      await writeFile(`${logDir}/${today}.log`, line, { flag: "a" });
    });

    // Post to Discord if something changed
    const consolidationChanged = !result.text.toLowerCase().includes("nothing to consolidate");
    const librarianChanged = !libResult.isError && !libResult.text.toLowerCase().includes("no cross-agent");

    if (consolidationChanged || librarianChanged) {
      const parts: string[] = [];
      if (consolidationChanged) {
        parts.push(`**Consolidation:**\n${result.text.slice(0, 1000)}`);
      }
      if (librarianChanged) {
        parts.push(`**Cross-agent librarian:**\n${libResult.text.slice(0, 500)}`);
      }
      await bot.sendToChannel(
        `**[dream_cycle]** ($${totalCost.toFixed(2)})\n\n${parts.join("\n\n")}`,
      );
    } else {
      console.log("[dream] Nothing to consolidate or cross-pollinate");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[dream] Crashed:", msg);
    await rollbackLock();
  }
}
