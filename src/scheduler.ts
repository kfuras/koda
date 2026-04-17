import cron from "node-cron";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { type KodaAgent } from "./agent.js";
import { type KodaBot } from "./bot.js";
import { type AgentRegistry } from "./agent-registry.js";
import { KODA_HOME, TICK_INTERVAL_MS, DAILY_BUDGET_USD, CONFIG } from "./config.js";
import { observeTaskResult } from "./runtime.js";
import { stateFileQueue, taskCircuitBreaker, sessionRegistry } from "./patterns.js";
import { runDreamCycle } from "./dream.js";

const execFileAsync = promisify(execFile);

// --- Types ---

interface TaskDef {
  prompt: string;
  cron: string;
  type: "silent" | "approval";
  timeout?: number;
  chain?: string;
  limits?: { maxTurns: number; maxBudgetUsd: number };
  agentId?: string;  // route to specific agent (default = home)
  model?: string;    // model override per task
}

interface TaskResult {
  status: "ok" | "failed" | "healed" | "exhausted";
  error?: string;
  timestamp: string;
}

// --- Load tasks from ~/.koda/tasks.json ---

function loadTasks(): Record<string, TaskDef> {
  const tasksFile = resolve(KODA_HOME, "tasks.json");
  try {
    const raw = readFileSync(tasksFile, "utf-8");
    const tasks = JSON.parse(raw) as Record<string, TaskDef>;
    console.log(`[scheduler] Loaded ${Object.keys(tasks).length} tasks from ${tasksFile}`);
    return tasks;
  } catch (err) {
    console.error(`[scheduler] Failed to load tasks from ${tasksFile}:`, err instanceof Error ? err.message : err);
    return {};
  }
}

let TASKS = loadTasks();

/** Hot-reload tasks from disk. Called by file watcher. */
export function reloadTasks(): void {
  TASKS = loadTasks();
}

export function getTasks(): Record<string, TaskDef> {
  return TASKS;
}

// --- Daily cost tracking ---

let dailyCostUsd = 0;
let dailyCostDate = today();

export function getDailyCost(): { cost: number; date: string; budget: number } {
  return { cost: dailyCostUsd, date: dailyCostDate, budget: DAILY_BUDGET_USD };
}

function trackCost(cost: number): boolean {
  const now = today();
  if (now !== dailyCostDate) {
    dailyCostUsd = 0;
    dailyCostDate = now;
  }
  dailyCostUsd += cost;
  if (dailyCostUsd > DAILY_BUDGET_USD) {
    console.log(`[budget] Daily budget exceeded: $${dailyCostUsd.toFixed(2)} > $${DAILY_BUDGET_USD}`);
    return false;
  }
  return true;
}

// --- Task result tracking ---

const RESULTS_DIR = `${KODA_HOME}/data/.task-results`;

async function loadResults(date: string): Promise<Record<string, TaskResult>> {
  await mkdir(RESULTS_DIR, { recursive: true });
  try {
    const data = await readFile(`${RESULTS_DIR}/${date}.json`, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveResult(
  date: string,
  taskId: string,
  result: TaskResult,
): Promise<void> {
  await stateFileQueue.run(async () => {
    const results = await loadResults(date);
    results[taskId] = result;
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      `${RESULTS_DIR}/${date}.json`,
      JSON.stringify(results, null, 2),
    );
  });
}

// --- Helpers ---

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function logToFile(taskName: string, text: string): Promise<void> {
  const dir = `${KODA_HOME}/data/autonomous-logs`;
  await mkdir(dir, { recursive: true });
  const line = `[${new Date().toISOString()}] [${taskName}] ${text}\n`;
  await writeFile(`${dir}/${today()}.log`, line, { flag: "a" });
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

// --- Self-healing ---

const HEAL_PROMPT = `You are the self-healing agent. A scheduled task just failed.
Your job is to diagnose the root cause, fix the broken script/config, and re-run the task.
You have full bash and MCP tool access.
Read the relevant source files to understand what went wrong.
Make minimal, targeted fixes — don't rewrite entire scripts.
Log what you fixed to ~/.koda/data/daily-logs/{date}.md.
After fixing files, commit your changes to git with a descriptive message (prefix with 'fix:').
If you can't fix it autonomously (needs human action like logging into a website),
explain exactly what the user needs to do.`;

const MAX_HEAL_ATTEMPTS = 2;

async function selfHeal(
  taskName: string,
  task: TaskDef,
  errorText: string,
  agent: KodaAgent,
  bot: KodaBot,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    console.log(`[${taskName}] Self-heal attempt ${attempt}/${MAX_HEAL_ATTEMPTS}`);
    await logToFile(taskName, `Self-heal attempt ${attempt}: ${errorText.slice(0, 200)}`);

    const healPrompt =
      `${HEAL_PROMPT}\n\nFailed task: ${taskName}\nError: ${errorText}\n\n` +
      `Original task prompt: ${task.prompt}\n\nDiagnose, fix, and re-run.`;

    const result = await agent.runIsolatedTask(`heal:${taskName}`, healPrompt);
    trackCost(result.cost);

    if (!result.isError) {
      await saveResult(today(), taskName, {
        status: "healed",
        timestamp: timestamp(),
      });
      await logToFile(taskName, `HEALED on attempt ${attempt}`);
      await bot.sendToChannel(
        `**[SELF-HEALED]** ${taskName}\n\nFixed after ${attempt} attempt(s):\n${result.text.slice(0, 1500)}`,
      );
      return true;
    }

    errorText = result.text;
  }

  await saveResult(today(), taskName, {
    status: "exhausted",
    error: errorText.slice(0, 2000),
    timestamp: timestamp(),
  });
  await logToFile(taskName, `EXHAUSTED after ${MAX_HEAL_ATTEMPTS} heal attempts`);
  await bot.sendToChannel(
    `**[HEAL FAILED]** ${taskName}\n\n` +
    `Self-healing failed after ${MAX_HEAL_ATTEMPTS} attempts.\n` +
    `Last error: ${errorText.slice(0, 1500)}`,
  );
  return false;
}

// --- Outcome checker ---

async function checkOutcomes(agent: KodaAgent): Promise<void> {
  const dir = `${KODA_HOME}/data/outcomes`;
  const now = new Date();

  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir).catch(() => [] as string[]);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const data = JSON.parse(await readFile(`${dir}/${file}`, "utf-8"));
      const unchecked = data.filter(
        (o: { checked: boolean; check_at: string }) =>
          !o.checked && new Date(o.check_at) <= now,
      );

      if (unchecked.length === 0) continue;

      for (const outcome of unchecked) {
        console.log(`[outcomes] Checking: ${outcome.content_type} — ${outcome.content_id}`);
        // Mark as checked BEFORE dispatching the async agent.send() call.
        // Previously we set checked=true inside the callback, but the writeFile
        // below ran synchronously before the callback fired, so the mutation
        // never persisted and the same outcomes re-fired every cycle forever.
        // Fire-and-forget is intentional — the check either happens or it's
        // a one-shot attempt. Better than infinite retry on broken IDs.
        outcome.checked = true;
        agent.send(
          `[OUTCOME CHECK] Check performance of this ${outcome.content_type} posted on ${outcome.posted_at}:\n` +
          `Description: ${outcome.description}\n` +
          `ID/URL: ${outcome.content_id}\n\n` +
          `Pull the current metrics (likes, views, engagement). Compare to typical performance.\n` +
          `Record your findings using the observe() tool.\n` +
          `If it performed unusually well or poorly, note WHY you think that happened.`,
          () => {},
        );
      }

      await writeFile(`${dir}/${file}`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error("[outcomes] Check failed:", err);
  }
}

// --- Initiative review ---

async function reviewInitiatives(_agent: KodaAgent, bot: KodaBot): Promise<void> {
  const file = `${KODA_HOME}/data/.agent-initiatives.json`;
  try {
    const raw = await readFile(file, "utf-8");
    const data = JSON.parse(raw) as Array<{
      id: string;
      description: string;
      reason: string;
      priority: string;
      status: string;
      sent_at?: string;
    }>;

    // Only pick NEW pending initiatives. Once sent, status flips to
    // "awaiting_approval" — this loop ignores those so we don't spam
    // Discord every 2h with the same message.
    const pending = data.filter(
      (i) => i.status === "pending" && (i.priority === "medium" || i.priority === "high"),
    );

    if (pending.length === 0) return;

    for (const initiative of pending) {
      await bot.sendApproval(
        `initiative:${initiative.id}`,
        `**Self-initiated task (${initiative.priority}):**\n${initiative.description}\n\n**Reason:** ${initiative.reason}`,
      );
      initiative.status = "awaiting_approval";
      initiative.sent_at = new Date().toISOString();
    }

    // Persist the status flip so the next review cycle skips these.
    await writeFile(file, JSON.stringify(data, null, 2));
    console.log(`[initiatives] Sent ${pending.length} for approval, marked awaiting_approval`);
  } catch (err) {
    // No initiatives file yet is fine; other errors are worth knowing about.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[initiatives] Review failed:", err);
    }
  }
}

// --- Heartbeat ---

const HEARTBEAT_FILE = `${KODA_HOME}/data/.koda-heartbeat`;

function startHeartbeat(): NodeJS.Timeout {
  const beat = async () => {
    try {
      await writeFile(
        HEARTBEAT_FILE,
        `${Date.now()}\n${process.pid}\nkoda-agent\n`,
      );
    } catch {
      // Silently ignore
    }
  };
  void beat();
  return setInterval(beat, 60_000);
}

// --- Tick loop ---

function startTickLoop(agent: KodaAgent, bot: KodaBot) {
  const tick = async () => {
    const userIdle = bot.isUserIdle();
    const date = today();
    const hour = new Date().getHours();

    if (hour < 7 || hour > 23) return;

    const tickPrompt =
      `[TICK] Lightweight check-in. User is ${userIdle ? "IDLE/OFFLINE" : "ACTIVE"}.` +
      ` Date: ${date}, time: ${new Date().toTimeString().slice(0, 5)}.` +
      `\n\nRead ~/.koda/data/observations.md and ~/.koda/goals.md.` +
      `\n\nAssess:` +
      `\n1. Any approved initiatives that haven't been started?` +
      `\n2. Anything urgent for today?` +
      `\n\nIf something needs doing, call propose_task() to queue it — do NOT execute now.` +
      `\nIf nothing needs attention, respond with exactly "tick ok".` +
      `\nMax 3 tool calls total.`;

    // Silent tick — no Discord output for normal operation. Tick acts via
    // propose_task() if it finds anything, and propose_task handles surfacing.
    // Circuit breaker surfaces only failures (after 3 consecutive) and recovery.
    try {
      await agent.runIsolatedTask(
        "tick",
        tickPrompt,
        { maxTurns: 3, maxBudgetUsd: 0.25 },
        "claude-sonnet-4-6",
      );
      // Detect recovery: if we were in a failing state, announce recovery once.
      const wasFailing = taskCircuitBreaker.status("tick").failures > 0;
      taskCircuitBreaker.recordSuccess("tick");
      if (wasFailing) {
        await bot.sendProactive(`**[tick]** Recovered.`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[tick] failed:", errorMsg);
      const justTripped = taskCircuitBreaker.recordFailure("tick");
      if (justTripped) {
        await bot.sendProactive(
          `**[tick]** Tick loop has failed 3 times. Last error: ${errorMsg}. Further failures will be silent until recovery.`,
        );
      }
    }
  };

  if (TICK_INTERVAL_MS <= 0) {
    console.log("  tick_loop: DISABLED (TICK_INTERVAL_MS=0)");
    return undefined as unknown as ReturnType<typeof setInterval>;
  }
  return setInterval(tick, TICK_INTERVAL_MS);
}

// --- Dream cycle ---
// Now handled by src/dream.ts (LLM-driven 4-phase consolidation).
// The old dream-cycle.sh (bash+python) is kept at ~/.koda/scripts/ as a fallback.

// --- Daily digest ---

async function sendDailyDigest(agent: KodaAgent, bot: KodaBot): Promise<void> {
  const date = today();
  console.log(`[digest] Generating daily digest for ${date}`);

  agent.send(
    `[DAILY DIGEST] Summarize what you did today (${date}). Check:\n` +
    `- ~/.koda/data/autonomous-logs/${date}.log for task results\n` +
    `- ~/.koda/data/.task-results/${date}.json for success/failure counts\n` +
    `- ~/.koda/data/observations.md for observations recorded today\n` +
    `- ~/.koda/data/.agent-initiatives.json for proposed tasks\n\n` +
    `Today's API spend: $${dailyCostUsd.toFixed(2)} / $${DAILY_BUDGET_USD} daily budget.\n\n` +
    `Format as a concise evening report. Include: tasks completed, tasks failed, ` +
    `observations recorded, content drafted, API spend, and anything that needs attention tomorrow.\n` +
    `Keep it under 1500 characters.`,
    async (responseText) => {
      // Layer 4 of the 6-layer memory pipeline: persist the digest as a daily log
      // so the morning learnings_review task has fresh material to consolidate
      // into LEARNINGS.md. Without this, learnings_review reads stale files
      // every day and produces no new learnings (the circuit was broken after
      // the March 2026 TypeScript rewrite — this restores it).
      try {
        const logDir = resolve(KODA_HOME, "data/daily-logs");
        await mkdir(logDir, { recursive: true });
        const logPath = resolve(logDir, `${date}.md`);
        await writeFile(
          logPath,
          `# Daily Log — ${date}\n\n${responseText}\n`,
          "utf-8",
        );
        console.log(`[digest] Wrote daily log: ${logPath}`);
      } catch (err) {
        console.error(
          `[digest] Failed to write daily log:`,
          err instanceof Error ? err.message : err,
        );
      }

      await bot.sendProactive(`**[Daily Digest — ${date}]**\n\n${responseText}`);
    },
  );
}

// --- Auto-backup ---

async function autoBackup(): Promise<void> {
  console.log("[backup] Backing up agent data...");

  try {
    const backupDir = `${KODA_HOME}/backups`;
    const stamp = today();
    await execFileAsync("mkdir", ["-p", backupDir]);
    await execFileAsync("rsync", [
      "-a", "--delete",
      `${KODA_HOME}/data/`,
      `${backupDir}/${stamp}/`,
    ]);

    console.log(`[backup] Synced to ${backupDir}/${stamp}/`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[backup] Failed:", msg);
  }
}

// --- Missed task detection ---

async function detectMissedTasks(
  tasks: Record<string, TaskDef>,
  agent: KodaAgent,
  bot: KodaBot,
): Promise<void> {
  const date = today();
  const results = await loadResults(date);
  const now = new Date();
  let missed = 0;

  const MAX_MISSED_RECOVERY = 3;
  const STAGGER_DELAY_MS = 60_000; // 1 minute between missed tasks
  const missedTasks: Array<{ name: string; task: TaskDef; hour: number; minute: number }> = [];

  for (const [name, task] of Object.entries(tasks)) {
    // Skip if already ran today (any terminal status — ok, healed, failed, exhausted)
    if (results[name]) continue;

    // Parse cron to see if it should have fired today before now
    try {
      const parts = task.cron.split(/\s+/);
      if (parts.length >= 2) {
        const minute = parseInt(parts[0], 10);
        const hour = parseInt(parts[1], 10);
        if (!isNaN(hour) && !isNaN(minute)) {
          const scheduledTime = new Date(now);
          scheduledTime.setHours(hour, minute, 0, 0);
          if (scheduledTime < now) {
            missedTasks.push({ name, task, hour, minute });
          }
        }
      }
    } catch {
      // Can't parse cron — skip
    }
  }

  if (missedTasks.length === 0) return;

  // Sort: approval tasks first, then by most recent scheduled time
  missedTasks.sort((a, b) => {
    const aApproval = a.task.type === "approval" ? 0 : 1;
    const bApproval = b.task.type === "approval" ? 0 : 1;
    if (aApproval !== bApproval) return aApproval - bApproval;
    return (b.hour * 60 + b.minute) - (a.hour * 60 + a.minute);
  });
  const toRecover = missedTasks.slice(0, MAX_MISSED_RECOVERY);
  const skipped = missedTasks.length - toRecover.length;

  console.log(`[missed] Found ${missedTasks.length} missed tasks, recovering ${toRecover.length}${skipped > 0 ? ` (skipping ${skipped} oldest)` : ""}`);
  await bot.sendToChannel(
    `**[startup]** Recovering ${toRecover.length} missed task(s)${skipped > 0 ? ` (${skipped} older tasks skipped)` : ""}: ${toRecover.map(t => t.name).join(", ")}`,
  );

  // Stagger execution — don't fire all at once
  for (let i = 0; i < toRecover.length; i++) {
    const { name, task, hour, minute } = toRecover[i];
    const delay = i * STAGGER_DELAY_MS;
    console.log(`[missed] ${name} (scheduled ${hour}:${String(minute).padStart(2, "0")}) — ${delay > 0 ? `executing in ${delay / 1000}s` : "executing now"}`);
    await logToFile(name, `MISSED — recovering on startup${delay > 0 ? ` (staggered ${delay / 1000}s)` : ""}`);
    if (delay > 0) {
      setTimeout(() => void executeTask(name, task, agent, bot), delay);
    } else {
      void executeTask(name, task, agent, bot);
    }
  }
}

// --- Task execution ---

const MAX_TASK_RETRIES = 2;
const RETRY_DELAY_MS = 5 * 60 * 1000;

async function executeTask(
  name: string,
  task: TaskDef,
  agent: KodaAgent,
  bot: KodaBot,
  retryCount = 0,
): Promise<void> {
  const date = today();

  // Circuit breaker — skip if tripped
  if (taskCircuitBreaker.isOpen(name)) {
    const status = taskCircuitBreaker.status(name);
    console.log(`[${name}] Circuit OPEN — skipping (${Math.round(status.cooldownRemaining / 60_000)}min cooldown remaining)`);
    await logToFile(name, `CIRCUIT OPEN — skipped (${status.failures} consecutive failures)`);
    return;
  }

  // Session registry — prevent duplicate execution
  if (await sessionRegistry.isRunning(name)) {
    console.log(`[${name}] Already running — skipping duplicate`);
    return;
  }

  const results = await loadResults(date);
  if (results[name] && retryCount === 0) {
    console.log(`[${date}] Skipping ${name} — already ran today (${results[name].status})`);
    return;
  }

  if (!trackCost(0)) {
    console.log(`[${date}] Skipping ${name} — daily budget exceeded ($${dailyCostUsd.toFixed(2)})`);
    await logToFile(name, `SKIPPED — daily budget exceeded ($${dailyCostUsd.toFixed(2)}/$${DAILY_BUDGET_USD})`);
    return;
  }

  // Register session
  const sessionPath = await sessionRegistry.register(name);

  console.log(`[${date}] Running task: ${name} (isolated, attempt ${retryCount + 1}/${MAX_TASK_RETRIES + 1})`);

  const fullPrompt =
    `[SCHEDULED TASK: ${name}] ${task.prompt}\n\nToday's date: ${date}`;

  const result = await agent.runIsolatedTask(name, fullPrompt, task.limits, task.model);

  trackCost(result.cost);

  if (!result.isError) {
    taskCircuitBreaker.recordSuccess(name);
    await sessionRegistry.complete(sessionPath, "completed");
    await saveResult(date, name, { status: "ok", timestamp: timestamp() });
    await logToFile(name, `OK ($${result.cost.toFixed(2)}, ${result.turns}t) — ${result.text.slice(0, 200)}`);

    const agentLabel = task.agentId ? `${name} → ${task.agentId}` : name;
    if (task.type === "approval") {
      await bot.sendApproval(agentLabel, result.text);
    } else if (result.text.length > 10) {
      await bot.sendToChannel(`**[${agentLabel}]**\n\n${result.text}`);
    }

    await observeTaskResult(name, true, result.cost, result.turns, result.text);

    if (task.chain && TASKS[task.chain]) {
      const nextTask = TASKS[task.chain];
      const chainPrompt = `${nextTask.prompt}\n\n[CONTEXT FROM ${name}]:\n${result.text.slice(0, 3000)}`;
      console.log(`[chain] ${name} → ${task.chain}`);
      await logToFile(name, `CHAIN → ${task.chain}`);
      void executeTask(task.chain, { ...nextTask, prompt: chainPrompt }, agent, bot);
    }
  } else {
    const tripped = taskCircuitBreaker.recordFailure(name);
    await sessionRegistry.complete(sessionPath, "failed");
    await saveResult(date, name, {
      status: "failed",
      error: result.text.slice(0, 2000),
      timestamp: timestamp(),
    });
    await logToFile(name, `FAILED ($${result.cost.toFixed(2)}, ${result.turns}t) — ${result.text.slice(0, 200)}`);

    await observeTaskResult(name, false, result.cost, result.turns, result.text);

    if (tripped) {
      await bot.sendToChannel(
        `**[CIRCUIT BREAKER]** ${name}\n\nStopped retrying after ${taskCircuitBreaker.status(name).failures} consecutive failures. Will retry in 30 minutes.`,
      );
    } else if (retryCount < MAX_TASK_RETRIES) {
      const delayMs = RETRY_DELAY_MS * (retryCount + 1);
      console.log(`[${name}] Retrying in ${delayMs / 60000} minutes...`);
      await logToFile(name, `RETRY scheduled in ${delayMs / 60000}min`);
      setTimeout(() => {
        void executeTask(name, task, agent, bot, retryCount + 1);
      }, delayMs);
    } else {
      console.log(`[${name}] All retries exhausted, attempting self-heal...`);
      await selfHeal(name, task, result.text, agent, bot);
    }
  }
}

// --- Scheduler ---

export function startScheduler(agent: KodaAgent, bot: KodaBot, registry?: AgentRegistry): void {
  console.log(`Scheduling ${Object.keys(TASKS).length} tasks from ~/.koda/tasks.json`);

  // Log progress to console only (no Discord spam)
  agent.setProgressCallback((taskName, text) => {
    console.log(`[${taskName}] ${text}`);
  });

  // Set progress callback on all agents in registry
  if (registry) {
    for (const agentId of registry.getAgentIds()) {
      const a = registry.getAgent(agentId);
      if (a && a !== agent) {
        a.setProgressCallback((taskName, text) => {
          console.log(`[${taskName}] ${text}`);
        });
      }
    }
  }

  // Clean up stale sessions from previous run
  void sessionRegistry.cleanupStale();

  // Detect and run missed tasks from downtime
  void detectMissedTasks(TASKS, agent, bot);

  for (const [name, task] of Object.entries(TASKS)) {
    // Resolve which agent runs this task
    const taskAgent = (task.agentId ? registry?.getAgent(task.agentId) : undefined) ?? agent;

    cron.schedule(task.cron, () => {
      void executeTask(name, task, taskAgent, bot);
    }, {
      timezone: "Europe/Oslo",
    });
    console.log(`  ${name}: ${task.cron}${task.agentId ? ` → ${task.agentId}` : ""}`);
  }

  // Daily digest — 21:00
  cron.schedule("0 21 * * *", () => {
    void sendDailyDigest(agent, bot);
  }, { timezone: "Europe/Oslo" });
  console.log(`  daily_digest: 0 21 * * *`);

  // Dream cycle (LLM-driven) + backup — 3:07 AM
  cron.schedule("7 3 * * *", () => {
    void runDreamCycle(agent, bot).then(() => {
      setTimeout(() => void autoBackup(), 60_000);
    });
  }, { timezone: "Europe/Oslo" });
  console.log(`  dream_cycle + auto_backup: 7 3 * * *`);

  // Outcome checks — every 6 hours
  cron.schedule("0 */6 * * *", () => {
    void checkOutcomes(agent);
  }, { timezone: "Europe/Oslo" });
  console.log(`  outcome_check: 0 */6 * * *`);

  // Initiative review — every 2 hours
  cron.schedule("0 */2 * * *", () => {
    void reviewInitiatives(agent, bot);
  }, { timezone: "Europe/Oslo" });
  console.log(`  initiative_review: 0 */2 * * *`);

  // Heartbeat
  startHeartbeat();
  console.log(`  heartbeat: every 60s`);

  // Tick loop
  startTickLoop(agent, bot);
  console.log(`  tick_loop: every ${TICK_INTERVAL_MS / 1000}s`);
}
