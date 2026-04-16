import {
  query,
  type Query,
  type SDKResultMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_DEFAULTS, KODA_HOME, DEFAULT_TASK_LIMITS, CONFIG } from "./config.js";
import { agentToolsServer } from "./tools/agent-tools.js";
import { gscServer } from "./tools/gsc.js";
import { delegateServer } from "./tools/delegate.js";
import { evolveServer } from "./tools/evolve.js";
import { stateFileQueue } from "./patterns.js";

// --- Types ---

export type ResponseCallback = (text: string, isError: boolean) => void;

/** Per-agent configuration — provided by the AgentRegistry. */
export interface AgentConfig {
  id: string;
  workspace: string;           // absolute path
  systemPrompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServerFilter?: string[];  // only load these MCP server keys (undefined = all)
  subAgents?: Record<string, { description: string; prompt: string; model: string }>;
}

interface PendingMessage {
  userMessage: SDKUserMessage;
  onResponse: ResponseCallback;
}

// --- Session persistence ---

async function loadSessionIdFrom(filePath: string): Promise<string | undefined> {
  try {
    const id = (await readFile(filePath, "utf-8")).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

async function saveSessionIdTo(filePath: string, id: string): Promise<void> {
  const dir = resolve(filePath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, id, "utf-8");
}

// --- Message queue ---

class MessageQueue {
  private queue: PendingMessage[] = [];
  private resolve: ((msg: PendingMessage) => void) | null = null;

  push(msg: PendingMessage): void {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r(msg);
    } else {
      this.queue.push(msg);
    }
  }

  pull(): Promise<PendingMessage> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

// --- YOLO Risk Classifier ---

const HIGH_RISK_TOOLS = new Set([
  // X (posting, deleting, quoting, publishing articles)
  "mcp__x-mcp__post_tweet", "mcp__x-mcp__delete_tweet",
  "mcp__x-mcp__quote_tweet", "mcp__x-mcp__publish_x_article",
  // Bluesky
  "mcp__bluesky-mcp__create-post", "mcp__bluesky-mcp__delete-post",
  // Gmail
  "mcp__gmail__gmail_send", "mcp__gmail__gmail_trash",
  // YouTube
  "mcp__youtube__youtube_upload_video", "mcp__youtube__youtube_delete_video",
  // Publishing (multi-platform video)
  "mcp__publish-tools__publish_video", "mcp__publish-tools__devto_crosspost",
  // Skool (community posts)
  "mcp__skool-tools__skool_create_post", "mcp__skool-tools__skool_delete_post",
  // File system
  "Write", "Edit", "Bash",
  // Skill/plugin install tools
  "mcp__agent-tools__install_clawhub_skill",
  "mcp__agent-tools__install_claude_plugin",
  "mcp__agent-tools__remove_skill",
]);

const MEDIUM_RISK_TOOLS = new Set([
  "mcp__content-tools__generate_image",
  "mcp__skool-tools__skool_sync_members",
  "mcp__instagram-tools__upload_instagram",
  "mcp__meta-tools__meta_refresh_token",
  "mcp__airtable__create_record", "mcp__airtable__update_records",
  "mcp__airtable__delete_records",
]);

/** Redact secrets from log output — passwords, tokens, API keys, base64 auth. */
function redactSecrets(text: string): string {
  return text
    // API keys, tokens, passwords in curl headers/flags
    .replace(/(Bearer\s+|x-api-key:\s*|Authorization:\s*Basic\s+|password['":\s]+)([^\s"',}{]+)/gi, "$1[REDACTED]")
    // Env var values that look like secrets
    .replace(/([A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z_]*["':\s=]+)([^\s"',}{]+)/gi, "$1[REDACTED]")
    // Base64 encoded credentials (user:pass pattern)
    .replace(/echo\s+-n\s+"[^"]*"\s*\|\s*base64/g, "echo -n [REDACTED] | base64")
    // WordPress app passwords (xxxx xxxx xxxx pattern)
    .replace(/\b[A-Za-z0-9]{4}\s[A-Za-z0-9]{4}\s[A-Za-z0-9]{4}\s[A-Za-z0-9]{4}\s[A-Za-z0-9]{4}\s[A-Za-z0-9]{4}\b/g, "[REDACTED]");
}

function classifyRisk(toolName: string): "LOW" | "MEDIUM" | "HIGH" {
  if (HIGH_RISK_TOOLS.has(toolName)) return "HIGH";
  if (MEDIUM_RISK_TOOLS.has(toolName)) return "MEDIUM";
  return "LOW";
}

// --- MCP config: built-in SDK servers + external from mcp-servers.json ---

const MCP_SERVERS_FILE = resolve(KODA_HOME, "mcp-servers.json");

interface StdioMcpDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
  defaults?: Record<string, string>;
}

interface HttpMcpDef {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  defaults?: Record<string, string>;
}

type ExternalMcpDef = StdioMcpDef | HttpMcpDef;

type McpServerConfig =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

function resolveEnvVar(value: string, defaults?: Record<string, string>): string {
  return value.replace(/\$([A-Z_]+)/g, (_match, varName: string) => {
    return process.env[varName] ?? defaults?.[varName] ?? "";
  });
}

function loadExternalMcpServers(): Record<string, McpServerConfig> {
  try {
    const raw = readFileSync(MCP_SERVERS_FILE, "utf-8");
    const defs: Record<string, ExternalMcpDef> = JSON.parse(raw);
    const servers: Record<string, McpServerConfig> = {};

    for (const [name, def] of Object.entries(defs)) {
      if ("type" in def && def.type === "http") {
        // HTTP MCP server (e.g., Notipo)
        servers[name] = {
          type: "http",
          url: resolveEnvVar(def.url, def.defaults),
          ...(def.headers ? {
            headers: Object.fromEntries(
              Object.entries(def.headers).map(([k, v]) => [k, resolveEnvVar(v, def.defaults)]),
            ),
          } : {}),
        };
      } else {
        // stdio MCP server (command + args)
        const stdio = def as StdioMcpDef;
        servers[name] = {
          command: resolveEnvVar(stdio.command, stdio.defaults),
          args: stdio.args.map(a => resolveEnvVar(a, stdio.defaults)),
          ...(stdio.env ? {
            env: Object.fromEntries(
              Object.entries(stdio.env).map(([k, v]) => [k, resolveEnvVar(v, stdio.defaults)]),
            ),
          } : {}),
        };
      }
    }

    console.log(`[mcp] Loaded ${Object.keys(servers).length} external servers: ${Object.keys(servers).join(", ")}`);
    return servers;
  } catch (err) {
    console.error(`[mcp] Failed to load ${MCP_SERVERS_FILE}:`, err instanceof Error ? err.message : err);
    return {};
  }
}

function getMcpServers() {
  return {
    // Built-in SDK servers (TypeScript, compiled in)
    "agent-tools": agentToolsServer,
    delegate: delegateServer,
    evolve: evolveServer,
    gsc: gscServer,
    // External servers (loaded from mcp-servers.json)
    ...loadExternalMcpServers(),
  };
}

// --- Plugin discovery ---
//
// We used to pass `settingSources: ["user", "project"]` to query() to pick
// up Claude Code plugins and AgentSkills from the operator's ~/.claude/.
// That also bled in the operator's personal CLAUDE.md and ~/.claude/workspace/
// — which pointed Koda at the wrong learnings.md and memory/ directory (they
// belong to the human-operator-using-Claude-Code persona, not Koda).
//
// The Agent SDK has a dedicated `plugins: SdkPluginConfig[]` API for exactly
// this case: load Claude Code plugin bundles from explicit paths, without
// inheriting user settings. We enumerate the operator's installed plugins
// from ~/.claude/plugins/installed_plugins.json and pass their absolute
// paths — no filesystem settings are loaded, no workspace state leaks.

interface SdkPluginConfig {
  type: "local";
  path: string;
}

const KODA_PLUGINS_DIR = resolve(KODA_HOME, "plugins");

function discoverPlugins(): SdkPluginConfig[] {
  const out: SdkPluginConfig[] = [];

  // 1. Koda-owned plugins (if any) — first-class, always loaded.
  try {
    if (existsSync(KODA_PLUGINS_DIR)) {
      for (const name of readdirSync(KODA_PLUGINS_DIR)) {
        const p = resolve(KODA_PLUGINS_DIR, name);
        if (statSync(p).isDirectory()) out.push({ type: "local", path: p });
      }
    }
  } catch { /* best-effort */ }

  // Koda only loads plugins from ~/.koda/plugins/ — not from the operator's
  // ~/.claude/plugins/. This prevents Claude Code plugin changes from
  // accidentally affecting Koda, and avoids conflicts (e.g., the discord
  // plugin giving the agent a second Discord path that sent DMs).
  // To add a plugin for Koda: symlink it into ~/.koda/plugins/.

  console.log(`[plugins] Loaded ${out.length} plugin bundles`);
  return out;
}

// --- Persistent Agent ---

const MEMORY_EXTRACT_PROMPT = `You are a memory extraction agent. Review the conversation exchanges below and extract any key decisions, preferences, facts, or learnings worth remembering.

## CRITICAL TOOL CONSTRAINTS

Available tools: Read (unrestricted), Grep (unrestricted), Glob (unrestricted).
Write/Edit: ONLY for ~/.koda/learnings.md — no other file paths allowed.
Do NOT use: Bash, Agent, WebSearch, WebFetch, MCP tools, or any other tool.
Do NOT create new files. Do NOT delete files.

## Strategy

Turn 1: Read ~/.koda/learnings.md to see existing entries (avoid duplicates).
Turn 2: Write/Edit ~/.koda/learnings.md with new entries (if any).
Do NOT interleave reads and writes across multiple turns.

## Rules

Write ONLY genuinely new, non-obvious information (append, don't overwrite).
Skip if nothing is worth remembering. Most exchanges won't have extractable memory.
Keep entries to one line each. Prefix with "- ". Group under existing section headers.
Do NOT extract task status, temporary state, or things derivable from code/git.
Do NOT extract debugging details, error messages, or fix recipes.
Do NOT extract anything already present in learnings.md.`;

// --- Memory extraction state (closure-scoped, matches leak's pattern) ---

interface MemoryExtractionState {
  inProgress: boolean;
  turnsSinceLastExtraction: number;
  extractionThreshold: number; // extract every N turns
  pendingContext: { userMessage: string; agentResponse: string } | null;
  messageBuffer: Array<{ userMessage: string; agentResponse: string }>;
  mainAgentWroteMemory: boolean; // mutual exclusion flag
}

function createMemoryExtractionState(): MemoryExtractionState {
  return {
    inProgress: false,
    turnsSinceLastExtraction: 0,
    extractionThreshold: 3, // extract every 3 turns (not every turn)
    pendingContext: null,
    messageBuffer: [],
    mainAgentWroteMemory: false,
  };
}

export class KodaAgent {
  private turnsSinceCompact = 0;
  private queryInstance: Query | null = null;
  private abortController = new AbortController();
  private messageQueue = new MessageQueue();
  private currentCallback: ResponseCallback | null = null;
  private running = false;
  private sessionId: string | undefined;
  private onProgressCallback: ((taskName: string, text: string) => void) | null = null;
  private memoryState = createMemoryExtractionState();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastActivityMs = Date.now();

  /** Agent identity and workspace config. */
  readonly agentId: string;
  private config: AgentConfig;

  constructor(config?: AgentConfig) {
    // Backward compatible: if no config, use legacy single-agent defaults
    this.config = config ?? {
      id: "home",
      workspace: KODA_HOME,
      systemPrompt: "", // will be set in start() via legacy path
      model: AGENT_DEFAULTS.model,
    };
    this.agentId = this.config.id;
  }

  async start(): Promise<void> {
    const sessionFile = resolve(this.config.workspace, "data/.koda-session-id");
    this.sessionId = await loadSessionIdFrom(sessionFile);
    this.running = true;

    const inputStream = this.createInputStream();

    // Persistent session gets a high turn limit — it auto-compacts every 50
    // turns and recovers from max_turns, so this is a safety ceiling, not a
    // per-message budget. Complex tasks (3h video analysis, long research)
    // need room to breathe.
    const maxTurns = this.config.maxTurns ?? AGENT_DEFAULTS.maxTurns;
    const persistentMaxTurns = Math.max(maxTurns, 200);
    const model = this.config.model ?? AGENT_DEFAULTS.model;

    // System prompt: use provided config, or fall back to legacy global
    let systemPrompt = this.config.systemPrompt;
    if (!systemPrompt) {
      // Legacy: import SYSTEM_PROMPT from config.ts
      const { SYSTEM_PROMPT } = await import("./config.js");
      systemPrompt = SYSTEM_PROMPT;
    }

    const mcpServers = this.config.mcpServerFilter
      ? filterMcpServers(getMcpServers(), this.config.mcpServerFilter)
      : getMcpServers();

    this.queryInstance = query({
      prompt: inputStream,
      options: {
        abortController: this.abortController,
        systemPrompt,
        tools: { type: "preset", preset: "claude_code" },
        model,
        maxTurns: persistentMaxTurns,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        agents: this.config.subAgents ?? {
          researcher: {
            description: "Research agent for gathering information, scanning trends, reading docs, and web searches. Use for the research phase of complex tasks.",
            prompt: "You are a research agent. Gather information thoroughly. Return structured findings. Do not take actions — only research and report.",
            model: "sonnet",
            tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
          },
          implementer: {
            description: "Implementation agent for writing code, editing files, running scripts. Use for the implementation phase after research is complete.",
            prompt: "You are an implementation agent. Execute the plan precisely. Write clean code. Run tests. Report what you changed.",
            model: "inherit",
          },
          verifier: {
            description: "Verification agent for checking work, running tests, validating output. Use after implementation to verify everything works.",
            prompt: "You are a verification agent. Check that implementation is correct. Run tests. Validate outputs. Report any issues found.",
            model: "sonnet",
            tools: ["Read", "Glob", "Grep", "Bash"],
          },
        },
        cwd: this.config.workspace,
        // Load Claude Code plugins (skills/commands/agents) via the dedicated
        // `plugins` API instead of `settingSources`. This gives Koda access to
        // the ecosystem (compound-engineering, feature-dev, document-skills,
        // etc) WITHOUT inheriting the operator's ~/.claude/CLAUDE.md rules or
        // ~/.claude/workspace/ state. See discoverPlugins() above for why.
        plugins: discoverPlugins(),
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        mcpServers,
      },
    });

    console.log(`[agent:${this.agentId}] Started (model: ${model}, workspace: ${this.config.workspace})`);

    // Process output stream in background
    void this.processOutput();
  }

  send(text: string, onResponse: ResponseCallback): void {
    this.lastActivityMs = Date.now();
    this.sendRaw({ role: "user", content: text }, onResponse);
  }

  sendRaw(
    message: { role: "user"; content: unknown },
    onResponse: ResponseCallback,
  ): void {
    const userMessage: SDKUserMessage = {
      type: "user",
      session_id: this.sessionId ?? "",
      message: message as SDKUserMessage["message"],
      parent_tool_use_id: null,
    };

    this.messageQueue.push({ userMessage, onResponse });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopCacheHeartbeat();
    this.abortController.abort();
  }

  /**
   * Run a task in an isolated session — separate from the persistent conversation.
   * Gets its own turn limit, budget cap, and fresh context.
   * Returns { text, cost, turns, isError }.
   */
  async runIsolatedTask(
    taskName: string,
    prompt: string,
    taskLimits?: { maxTurns: number; maxBudgetUsd: number },
    modelOverride?: string,
  ): Promise<{ text: string; cost: number; turns: number; isError: boolean }> {
    const limits = taskLimits ?? DEFAULT_TASK_LIMITS;
    const controller = new AbortController();

    // Create a one-shot prompt (no streaming input)
    // Use agent-specific system prompt if available, else fall back to legacy
    let systemPrompt = this.config.systemPrompt;
    if (!systemPrompt) {
      const { SYSTEM_PROMPT } = await import("./config.js");
      systemPrompt = SYSTEM_PROMPT;
    }

    const mcpServers = this.config.mcpServerFilter
      ? filterMcpServers(getMcpServers(), this.config.mcpServerFilter)
      : getMcpServers();

    const taskQuery = query({
      prompt: prompt,
      options: {
        abortController: controller,
        systemPrompt,
        tools: { type: "preset", preset: "claude_code" },
        model: modelOverride ?? this.config.model ?? AGENT_DEFAULTS.model,
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.maxBudgetUsd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: this.config.workspace,
        plugins: discoverPlugins(),
        mcpServers,
      },
    });

    let resultText = "";
    let totalCost = 0;
    let totalTurns = 0;
    let isError = false;
    let lastToolName = "";
    const MAX_CONTINUATIONS = 2;

    // 30s progress summaries — post periodic updates for long tasks
    const PROGRESS_INTERVAL_MS = 30_000;
    const startTime = Date.now();
    const progressTimer = setInterval(() => {
      if (this.onProgressCallback && lastToolName) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        this.onProgressCallback(taskName, `${elapsed}s — ${lastToolName}...`);
      }
    }, PROGRESS_INTERVAL_MS);

    let currentQuery = taskQuery;
    let continuations = 0;

    try {
      while (true) {
        let hitMaxTurns = false;

        for await (const message of currentQuery) {
          if (message.type === "result") {
            const result = message as SDKResultMessage;
            totalCost += result.total_cost_usd ?? 0;
            totalTurns += result.num_turns ?? 0;

            if (result.subtype === "success") {
              isError = false;
              resultText = (result as unknown as { result: string }).result || resultText;
            } else if (result.subtype === "error_max_turns") {
              hitMaxTurns = true;
            } else {
              isError = true;
              const errors = (result as unknown as { errors?: string[] }).errors;
              resultText = `Task error (${result.subtype}): ${errors?.join(", ") ?? "unknown"}`;
            }
          } else if (message.type === "assistant") {
            const assistantMsg = message as SDKAssistantMessage;
            const content = assistantMsg.message?.content ?? [];

            for (const block of content) {
              if ((block as { type: string }).type === "tool_use") {
                lastToolName = (block as { type: string; name?: string }).name ?? "working";
              }
            }

            const textBlocks = content.filter(
              (b: { type: string }) => b.type === "text",
            );
            if (textBlocks.length > 0) {
              resultText = textBlocks
                .map((b: { type: string; text?: string }) => b.text ?? "")
                .join("\n");
            }
          }
        }

        // If max_turns hit, continue with a fresh query (up to MAX_CONTINUATIONS)
        if (hitMaxTurns && continuations < MAX_CONTINUATIONS) {
          continuations++;
          const remainingBudget = Math.max(0.5, limits.maxBudgetUsd - totalCost);
          console.log(
            `[task:${taskName}] max_turns reached — continuation ${continuations}/${MAX_CONTINUATIONS} ($${totalCost.toFixed(2)} spent)`,
          );

          currentQuery = query({
            prompt: `You were working on the task "${taskName}" but hit the turn limit. Here is your progress so far:\n\n${resultText.slice(-2000)}\n\nContinue where you left off and finish the task. Do NOT restart from the beginning.`,
            options: {
              abortController: controller,
              systemPrompt: systemPrompt,
              tools: { type: "preset", preset: "claude_code" },
              model: modelOverride ?? this.config.model ?? AGENT_DEFAULTS.model,
              maxTurns: limits.maxTurns,
              maxBudgetUsd: remainingBudget,
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              cwd: this.config.workspace,
              plugins: discoverPlugins(),
              mcpServers,
            },
          });
          isError = false;
          continue;
        }

        // If we still hit max_turns after all continuations, mark as error
        if (hitMaxTurns) {
          isError = true;
          resultText = `Task exhausted ${MAX_CONTINUATIONS + 1} rounds (${totalTurns} total turns). Last output:\n${resultText}`;
        }

        break;
      }
    } catch (err) {
      resultText = `Task crashed: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    } finally {
      clearInterval(progressTimer);
    }

    console.log(
      `[task:${taskName}] ${isError ? "FAILED" : "OK"} (${totalTurns} turns, $${totalCost.toFixed(2)}, limit: ${limits.maxTurns}t/$${limits.maxBudgetUsd}${continuations > 0 ? `, ${continuations} cont.` : ""})`,
    );

    return { text: resultText, cost: totalCost, turns: totalTurns, isError };
  }

  /** Set a callback for progress updates during long-running tasks. */
  setProgressCallback(cb: (taskName: string, text: string) => void): void {
    this.onProgressCallback = cb;
  }

  /**
   * Start cache heartbeat — sends a lightweight keep-alive every intervalMs
   * to prevent Anthropic's prompt cache from expiring (1hr TTL).
   * Only sends if the agent has been idle (no real messages) for at least
   * half the interval, avoiding unnecessary pings during active use.
   *
   * From OpenClaw: cache reads are dramatically cheaper than cache writes,
   * so keeping the cache warm saves real money on long-running agents.
   */
  startCacheHeartbeat(intervalMs = 55 * 60_000): void {
    if (this.heartbeatTimer) return; // already running

    this.heartbeatTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastActivityMs;
      // Only ping if idle for at least half the interval
      if (idleMs < intervalMs / 2) {
        return;
      }

      console.log(`[heartbeat:${this.agentId}] Cache keep-alive (idle ${Math.round(idleMs / 60_000)}min)`);
      this.messageQueue.push({
        userMessage: {
          type: "user",
          session_id: this.sessionId ?? "",
          message: {
            role: "user",
            content: "[SYSTEM: Cache heartbeat — no action needed. Reply with a single period.]",
          },
          parent_tool_use_id: null,
        },
        onResponse: () => {}, // discard response
      });
    }, intervalMs);
  }

  /** Stop the cache heartbeat timer. */
  stopCacheHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Queue a conversation exchange for memory extraction.
   * Uses cursor tracking (turn threshold), coalescing (stash-and-trail),
   * and mutual exclusion (inProgress guard) — matching the leak's pattern.
   */
  extractMemories(userMessage: string, agentResponse: string): void {
    // Skip short exchanges — not worth extracting
    if (userMessage.length < 50 && agentResponse.length < 100) return;
    // Skip system messages (not user conversations)
    if (userMessage.startsWith("[TICK]") || userMessage.startsWith("[SCHEDULED")) return;
    if (userMessage.startsWith("[OUTCOME CHECK]") || userMessage.startsWith("[DAILY DIGEST]")) return;
    if (userMessage.startsWith("[APPROVAL]") || userMessage.startsWith("[TELEPORT")) return;

    const state = this.memoryState;

    // Buffer the exchange
    state.messageBuffer.push({
      userMessage: userMessage.slice(0, 1000),
      agentResponse: agentResponse.slice(0, 2000),
    });

    // Cursor: only extract every N turns
    state.turnsSinceLastExtraction++;
    if (state.turnsSinceLastExtraction < state.extractionThreshold) {
      return;
    }

    // Coalescing: if extraction in progress, stash for trailing run
    if (state.inProgress) {
      console.log("[memory] Extraction in progress — stashing for trailing run");
      state.pendingContext = {
        userMessage: state.messageBuffer.map((m) => m.userMessage).join("\n---\n"),
        agentResponse: state.messageBuffer.map((m) => m.agentResponse).join("\n---\n"),
      };
      return;
    }

    // Run extraction
    void this.runMemoryExtraction();
  }

  private async runMemoryExtraction(): Promise<void> {
    const state = this.memoryState;
    state.inProgress = true;
    state.turnsSinceLastExtraction = 0;

    // Collect buffered messages into prompt
    const exchanges = state.messageBuffer
      .map((m, i) => `--- Exchange ${i + 1} ---\nUSER: ${m.userMessage}\nAGENT: ${m.agentResponse}`)
      .join("\n\n");
    state.messageBuffer = [];

    const prompt =
      `${MEMORY_EXTRACT_PROMPT}\n\n` +
      `Review these ${state.messageBuffer.length || "recent"} exchanges:\n\n${exchanges}`;

    try {
      const result = await this.runIsolatedTask("memory-extract", prompt, {
        maxTurns: 5,
        maxBudgetUsd: 0.5,
      });
      if (!result.isError && result.text) {
        console.log(`[memory] Extracted from conversation ($${result.cost.toFixed(2)})`);

        // Feedback: inject system message so main agent knows memories were saved
        // Only if the extraction actually wrote something (not "nothing to remember")
        const wrote = result.text.toLowerCase();
        if (!wrote.includes("nothing") && !wrote.includes("no new") && !wrote.includes("skip")) {
          this.messageQueue.push({
            userMessage: {
              type: "user",
              session_id: this.sessionId ?? "",
              message: {
                role: "user",
                content: `[SYSTEM: Memory updated — learnings.md was updated by background extraction. You do not need to respond to this.]`,
              },
              parent_tool_use_id: null,
            },
            onResponse: () => {},
          });
        }
      }
    } catch {
      // Best-effort — silently ignore
    } finally {
      state.inProgress = false;

      // Trailing run: if context was stashed while we were running, run once more
      if (state.pendingContext) {
        console.log("[memory] Running trailing extraction for stashed context");
        state.messageBuffer.push(state.pendingContext);
        state.pendingContext = null;
        state.turnsSinceLastExtraction = state.extractionThreshold; // force immediate run
        void this.runMemoryExtraction();
      }
    }
  }

  private async *createInputStream(): AsyncGenerator<SDKUserMessage> {
    while (this.running) {
      const pending = await this.messageQueue.pull();
      this.currentCallback = pending.onResponse;
      yield pending.userMessage;
    }
  }

  private async processOutput(): Promise<void> {
    if (!this.queryInstance) return;

    let currentText = "";
    let currentUserMessage = "";

    try {
      for await (const message of this.queryInstance) {
        // Track user messages for memory extraction
        if (message.type === "user") {
          const userMsg = message as SDKUserMessage;
          const content = userMsg.message?.content;
          if (typeof content === "string") {
            currentUserMessage = content;
          } else if (Array.isArray(content)) {
            currentUserMessage = content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { type: string; text?: string }) => b.text ?? "")
              .join("\n");
          }
        }

        // Save session ID from first message
        if ("session_id" in message && message.session_id && !this.sessionId) {
          this.sessionId = message.session_id as string;
          await saveSessionIdTo(resolve(this.config.workspace, "data/.koda-session-id"), this.sessionId);
          console.log(`[agent] Session: ${this.sessionId}`);
        }

        // YOLO Classifier — log tool use by risk level
        if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const content = assistantMsg.message?.content ?? [];

          // Log tool calls with risk classification + detect memory writes
          for (const block of content) {
            if ((block as { type: string }).type === "tool_use") {
              const toolBlock = block as { type: string; name?: string; input?: unknown };
              const risk = classifyRisk(toolBlock.name ?? "unknown");
              if (risk === "HIGH") {
                const redacted = redactSecrets(JSON.stringify(toolBlock.input).slice(0, 200));
                console.log(`[yolo] HIGH RISK: ${toolBlock.name} — ${redacted}`);
              }
              // Mutual exclusion: detect if main agent wrote to memory files
              if (toolBlock.name === "Write" || toolBlock.name === "Edit") {
                const input = toolBlock.input as { file_path?: string } | undefined;
                if (input?.file_path?.includes("learnings.md") || input?.file_path?.includes("observations.md")) {
                  this.memoryState.mainAgentWroteMemory = true;
                }
              }
            }
          }

          const textBlocks = content.filter(
            (b: { type: string }) => b.type === "text",
          );
          if (textBlocks.length > 0) {
            currentText = textBlocks
              .map((b: { type: string; text?: string }) => b.text ?? "")
              .join("\n");
          }
        }

        // Context compaction detection
        if ((message.type as string) === "compact_boundary") {
          console.log("[agent] Context compacted — session memory condensed");
        }

        if (message.type === "result") {
          const result = message as SDKResultMessage;
          let responseText: string;

          if (result.subtype === "success") {
            responseText = result.result || currentText;
          } else {
            responseText = `Agent error (${result.subtype}): ${result.errors.join(", ")}`;
          }

          // Save session ID
          if (result.session_id) {
            this.sessionId = result.session_id;
            await saveSessionIdTo(resolve(this.config.workspace, "data/.koda-session-id"), this.sessionId);
          }

          // Deliver response — but suppress error delivery for max_turns
          // since we'll recover and re-queue a continuation
          const savedCallback = this.currentCallback;
          if (savedCallback) {
            if (result.subtype === "error_max_turns") {
              // Don't deliver error to Discord — stash callback for recovery
              this.currentCallback = null;
            } else {
              savedCallback(responseText, result.is_error);
              this.currentCallback = null;
            }
          }

          // Extract memories from conversation (background, best-effort)
          // Mutual exclusion: skip if main agent already wrote to memory files this turn
          if (result.subtype === "success" && currentUserMessage && responseText) {
            if (this.memoryState.mainAgentWroteMemory) {
              console.log("[memory] Skipping extraction — main agent already wrote to memory files");
            } else {
              this.extractMemories(currentUserMessage, responseText);
            }
            this.memoryState.mainAgentWroteMemory = false; // reset for next turn
          }

          currentText = "";
          currentUserMessage = "";
          this.turnsSinceCompact += 1;
          console.log(
            `[agent] Turn complete (${result.num_turns} turns, $${result.total_cost_usd.toFixed(2)}, ${this.turnsSinceCompact} since compact)`,
          );

          // Proactive context compaction every 50 turns
          if (result.subtype === "success" && this.turnsSinceCompact >= 50) {
            console.log("[agent] Proactive compaction — context getting large");
            this.turnsSinceCompact = 0;
            this.messageQueue.push({
              userMessage: {
                type: "user",
                session_id: this.sessionId ?? "",
                message: { role: "user", content: "/compact" },
                parent_tool_use_id: null,
              },
              onResponse: () => {
                console.log("[agent] Compaction complete");
              },
            });
          }

          // Auto-recover from max_turns or other fatal errors
          if (result.subtype !== "success") {
            if (result.subtype === "error_max_turns" && this.sessionId) {
              // max_turns: compact, resume, then tell the agent to continue
              console.log(`[agent] max_turns reached — compacting and continuing`);
              this.turnsSinceCompact = 0;
              this.abortController = new AbortController();
              try {
                await this.start();
                // Compact first, then continue the interrupted work
                this.messageQueue.push({
                  userMessage: {
                    type: "user",
                    session_id: this.sessionId ?? "",
                    message: { role: "user", content: "/compact" },
                    parent_tool_use_id: null,
                  },
                  onResponse: () => {
                    console.log("[agent] Post-recovery compaction complete");
                  },
                });
                // Re-queue a continuation so the agent finishes what it was doing
                this.messageQueue.push({
                  userMessage: {
                    type: "user",
                    session_id: this.sessionId ?? "",
                    message: {
                      role: "user",
                      content: `[SYSTEM: You hit the turn limit while working. Continue where you left off and finish. Your last output was: ${currentText.slice(-500) || "(none)"}]`,
                    },
                    parent_tool_use_id: null,
                  },
                  onResponse: savedCallback ?? (() => {}),
                });
                console.log("[agent] Resumed session after max_turns — continuation queued");
              } catch (resumeErr) {
                // Resume failed — fall through to fresh session
                console.error("[agent] Resume failed, creating fresh session:", resumeErr);
                await new Promise((r) => setTimeout(r, 5000));
                if (this.running) {
                  this.sessionId = undefined;
                  this.abortController = new AbortController();
                  await this.start().catch((e) => console.error("[agent] Fresh start failed:", e));
                }
              }
            } else {
              // Other fatal errors: try resume first, fresh session as last resort
              console.log(`[agent] Fatal error (${result.subtype}) — attempting resume in 5s...`);
              await new Promise((r) => setTimeout(r, 5000));
              if (this.running) {
                this.abortController = new AbortController();
                try {
                  // Try resume with existing session
                  await this.start();
                  console.log("[agent] Resumed existing session after error");
                } catch {
                  // Resume failed — create fresh session
                  console.log("[agent] Resume failed — creating fresh session");
                  this.sessionId = undefined;
                  this.abortController = new AbortController();
                  await this.start().catch((e) => console.error("[agent] Fresh start failed:", e));
                }
              }
            }
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[agent] Stream error:", errorMsg);
      if (this.currentCallback) {
        this.currentCallback(`Agent stream error: ${errorMsg}`, true);
        this.currentCallback = null;
      }

      // Auto-restart: try resume with existing session first
      if (this.running) {
        console.log("[agent] Auto-restarting in 5 seconds (preserving session)...");
        await new Promise((r) => setTimeout(r, 5000));
        if (this.running) {
          this.abortController = new AbortController();
          try {
            // Try resume with existing session ID
            await this.start();
            console.log("[agent] Auto-restart successful (session preserved)");
          } catch {
            // Resume failed — try fresh session
            console.log("[agent] Resume failed — trying fresh session in 10s...");
            await new Promise((r) => setTimeout(r, 10_000));
            if (this.running) {
              this.sessionId = undefined;
              this.abortController = new AbortController();
              await this.start().catch((e) => {
                console.error("[agent] Fresh start failed:", e);
                // Last resort: retry in 30s
                setTimeout(() => {
                  if (this.running) {
                    this.abortController = new AbortController();
                    this.start().catch((e2) => console.error("[agent] Final retry failed:", e2));
                  }
                }, 30_000);
              });
            }
          }
        }
      }
    }
  }
}

// --- MCP server filtering ---

/** Filter MCP servers to only include the specified keys. */
function filterMcpServers<T extends Record<string, unknown>>(
  allServers: T,
  allowedKeys: string[],
): T {
  const allowed = new Set(allowedKeys);
  const filtered = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(allServers)) {
    if (allowed.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered as T;
}
