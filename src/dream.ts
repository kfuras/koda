/**
 * Dream Cycle — LLM-driven memory consolidation.
 *
 * Based on Claude Code's autoDream pattern:
 *   1. Orient — read existing memory files to understand current state
 *   2. Gather — scan recent logs, task results, and observations for new signal
 *   3. Consolidate — merge learnings into structured memory files
 *   4. Prune — remove stale entries, enforce size budgets, update index
 *
 * Runs as a forked isolated task with constrained budget.
 * Replaces the old dream-cycle.sh (bash+python, mechanical text processing).
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

  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory and observation files.
Synthesize what you've learned recently into durable, well-organized memories so that
future sessions can orient quickly.

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

## Phase 1 — Orient

- Read \`${memoryDir}/learnings.md\` to see current accumulated knowledge
- Read \`${memoryDir}/goals.md\` to understand active objectives
- Read \`${memoryDir}/soul.md\` and \`${memoryDir}/user.md\` for context on personality and user
- Skim \`${dataDir}/observations.md\` to see the raw observation stream

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in priority order:

1. **Observations** (\`${dataDir}/observations.md\`) — tagged entries from the observer.
   Focus on entries from the last 7 days. Look for patterns: same insight appearing 3+ times,
   facts that update or contradict existing learnings, new preferences or rules.

2. **Task results** (\`${dataDir}/.task-results/\`) — check the last 3 days of JSON files.
   Look for: tasks that repeatedly fail (systemic issues), tasks that got expensive (need optimization),
   successful patterns worth codifying.

3. **Autonomous logs** (\`${dataDir}/autonomous-logs/\`) — last 3 days of logs.
   Scan for: recurring errors, successful strategies, new tool usage patterns.

Do NOT exhaustively read all files. Grep narrowly for what matters:
\`grep -rn "FAILED\\|ERROR\\|expensive\\|healed" ${dataDir}/autonomous-logs/ | tail -30\`
\`grep -rn "rule\\|preference\\|goal" ${dataDir}/observations.md | tail -50\`

## Phase 3 — Consolidate

Update \`${memoryDir}/learnings.md\` with genuinely new, non-obvious information:

- **Merge** new signal into existing sections rather than appending duplicates
- **Convert** relative dates ("yesterday", "last week") to absolute dates
- **Delete** contradicted facts — if today's evidence disproves an old learning, fix it
- **Promote** patterns: if the same observation appears 3+ times, it's a learning
- **Demote** stale learnings: if something hasn't been relevant in 30+ days, consider removing it

Rules for what to write:
- One line per learning, prefixed with "- "
- Group by topic (Content Performance, Thumbnails, Video Pipeline, etc.)
- Include WHY when non-obvious ("X works because Y")
- Never write secrets, credentials, or personal data
- Never write task status or temporary state

Rules for what NOT to write:
- Things derivable from reading the code or git history
- Debugging solutions (the fix is in the code)
- Anything already in soul.md or user.md
- Ephemeral task details

Also check \`${memoryDir}/goals.md\`:
- Update progress on active goals based on task results
- Flag goals that appear stalled (no progress in 7+ days)
- Remove goals that are clearly completed

## Phase 4 — Prune

Enforce size budgets:
- \`learnings.md\` must stay under 100 lines. If over, remove the least relevant entries.
- \`observations.md\` — remove observations older than 30 days (events), 90 days (facts),
  180 days (preferences/goals), 365 days (rules). Move expired entries to
  \`${dataDir}/observations-archive.md\` (append, don't overwrite).
- Deduplicate observations: remove entries that say the same thing in different words.

Return a brief summary of what you consolidated, updated, or pruned.
If nothing changed (memories are already tight), say "Dream cycle: nothing to consolidate."`;
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

  try {
    const prompt = buildConsolidationPrompt();

    const result = await agent.runIsolatedTask("dream_cycle", prompt, {
      maxTurns: 20,
      maxBudgetUsd: 3,
    });

    if (result.isError) {
      console.error(`[dream] Failed ($${result.cost.toFixed(2)}, ${result.turns}t): ${result.text.slice(0, 200)}`);
      await rollbackLock();

      await bot.sendToChannel(
        `**[dream_cycle]** Failed ($${result.cost.toFixed(2)})\n\n${result.text.slice(0, 500)}`,
      );
    } else {
      console.log(`[dream] Complete ($${result.cost.toFixed(2)}, ${result.turns}t)`);
      await releaseLock();

      // Log the summary
      await stateFileQueue.run(async () => {
        const logDir = resolve(KODA_HOME, "data/autonomous-logs");
        await mkdir(logDir, { recursive: true });
        const today = new Date().toISOString().slice(0, 10);
        const line = `[${new Date().toISOString()}] [dream_cycle] ${result.text.slice(0, 500)}\n`;
        await writeFile(`${logDir}/${today}.log`, line, { flag: "a" });
      });

      // Only post to Discord if something actually changed
      if (!result.text.toLowerCase().includes("nothing to consolidate")) {
        await bot.sendToChannel(
          `**[dream_cycle]** ($${result.cost.toFixed(2)}, ${result.turns}t)\n\n${result.text.slice(0, 1500)}`,
        );
      } else {
        console.log("[dream] Nothing to consolidate");
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[dream] Crashed:", msg);
    await rollbackLock();
  }
}
