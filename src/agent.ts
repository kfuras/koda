import {
  query,
  type Query,
  type SDKResultMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_PROMPT, AGENT_DEFAULTS, CONTENT_HUB_DIR, KODA_HOME, DEFAULT_TASK_LIMITS } from "./config.js";
import { agentToolsServer } from "./tools/agent-tools.js";
import { gscServer } from "./tools/gsc.js";
import { stateFileQueue } from "./patterns.js";

// --- Types ---

export type ResponseCallback = (text: string, isError: boolean) => void;

interface PendingMessage {
  userMessage: SDKUserMessage;
  onResponse: ResponseCallback;
}

// --- Session persistence ---

const SESSION_FILE = resolve(KODA_HOME, "data/.koda-session-id");

async function loadSessionId(): Promise<string | undefined> {
  try {
    const id = (await readFile(SESSION_FILE, "utf-8")).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

async function saveSessionId(id: string): Promise<void> {
  await mkdir(resolve(CONTENT_HUB_DIR, "data"), { recursive: true });
  await writeFile(SESSION_FILE, id, "utf-8");
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
  "post_tweet", "publish_video", "quote_tweet",
  "mcp__x-mcp__post_tweet", "mcp__x-mcp__delete_tweet",
  "mcp__bluesky-mcp__create-post", "mcp__bluesky-mcp__delete-post",
  "mcp__gmail__gmail_send", "mcp__gmail__gmail_trash",
  "mcp__youtube__youtube_upload_video", "mcp__youtube__youtube_delete_video",
  "Write", "Edit", "Bash",
  // Skill/plugin install tools — downloads and enables third-party code.
  "mcp__agent-tools__install_clawhub_skill",
  "mcp__agent-tools__install_claude_plugin",
  "mcp__agent-tools__remove_skill",
]);

const MEDIUM_RISK_TOOLS = new Set([
  "generate_image", "skool_airtable_sync",
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

interface ExternalMcpDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
  defaults?: Record<string, string>;
}

function resolveEnvVar(value: string, defaults?: Record<string, string>): string {
  return value.replace(/\$([A-Z_]+)/g, (_match, varName: string) => {
    return process.env[varName] ?? defaults?.[varName] ?? "";
  });
}

function loadExternalMcpServers(): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
  try {
    const raw = readFileSync(MCP_SERVERS_FILE, "utf-8");
    const defs: Record<string, ExternalMcpDef> = JSON.parse(raw);
    const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};

    for (const [name, def] of Object.entries(defs)) {
      servers[name] = {
        command: resolveEnvVar(def.command, def.defaults),
        args: def.args.map(a => resolveEnvVar(a, def.defaults)),
        ...(def.env ? {
          env: Object.fromEntries(
            Object.entries(def.env).map(([k, v]) => [k, resolveEnvVar(v, def.defaults)]),
          ),
        } : {}),
      };
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
    gsc: gscServer,
    // External servers (loaded from mcp-servers.json)
    ...loadExternalMcpServers(),
  };
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

  async start(): Promise<void> {
    this.sessionId = await loadSessionId();
    this.running = true;

    const inputStream = this.createInputStream();

    this.queryInstance = query({
      prompt: inputStream,
      options: {
        abortController: this.abortController,
        systemPrompt: SYSTEM_PROMPT,
        tools: { type: "preset", preset: "claude_code" },
        model: AGENT_DEFAULTS.model,
        maxTurns: AGENT_DEFAULTS.maxTurns,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        agents: {
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
        cwd: CONTENT_HUB_DIR,
        // Load both user-level (~/.claude/) and project-level settings so Koda
        // inherits the Claude Code plugin + Agent Skills ecosystem (compound-
        // engineering, feature-dev, code-review, document-skills, n8n skills,
        // etc) on top of Koda's own ~/.koda/skills/ layer. This is the same
        // marketplace surface Claude Code has — one config flag unlocks it.
        settingSources: ["user", "project"],
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        mcpServers: getMcpServers(),
      },
    });

    // Process output stream in background
    void this.processOutput();
  }

  send(text: string, onResponse: ResponseCallback): void {
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
    const taskQuery = query({
      prompt: prompt,
      options: {
        abortController: controller,
        systemPrompt: SYSTEM_PROMPT,
        tools: { type: "preset", preset: "claude_code" },
        model: modelOverride ?? AGENT_DEFAULTS.model,
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.maxBudgetUsd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: CONTENT_HUB_DIR,
        // Load both user-level (~/.claude/) and project-level settings so Koda
        // inherits the Claude Code plugin + Agent Skills ecosystem (compound-
        // engineering, feature-dev, code-review, document-skills, n8n skills,
        // etc) on top of Koda's own ~/.koda/skills/ layer. This is the same
        // marketplace surface Claude Code has — one config flag unlocks it.
        settingSources: ["user", "project"],
        mcpServers: getMcpServers(),
      },
    });

    let resultText = "";
    let totalCost = 0;
    let totalTurns = 0;
    let isError = false;
    let lastToolName = "";

    // 30s progress summaries — post periodic updates for long tasks
    const PROGRESS_INTERVAL_MS = 30_000;
    const startTime = Date.now();
    const progressTimer = setInterval(() => {
      if (this.onProgressCallback && lastToolName) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        this.onProgressCallback(taskName, `${elapsed}s — ${lastToolName}...`);
      }
    }, PROGRESS_INTERVAL_MS);

    try {
      for await (const message of taskQuery) {
        if (message.type === "result") {
          const result = message as SDKResultMessage;
          totalCost = result.total_cost_usd ?? 0;
          totalTurns = result.num_turns ?? 0;
          isError = result.subtype !== "success";

          if (result.subtype === "success") {
            resultText = (result as unknown as { result: string }).result || resultText;
          } else {
            const errors = (result as unknown as { errors?: string[] }).errors;
            resultText = `Task error (${result.subtype}): ${errors?.join(", ") ?? "unknown"}`;
          }
        } else if (message.type === "assistant") {
          const assistantMsg = message as SDKAssistantMessage;
          const content = assistantMsg.message?.content ?? [];

          // Track last tool use for progress summaries
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
    } catch (err) {
      resultText = `Task crashed: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    } finally {
      clearInterval(progressTimer);
    }

    console.log(
      `[task:${taskName}] ${isError ? "FAILED" : "OK"} (${totalTurns} turns, $${totalCost.toFixed(2)}, limit: ${limits.maxTurns}t/$${limits.maxBudgetUsd})`,
    );

    return { text: resultText, cost: totalCost, turns: totalTurns, isError };
  }

  /** Set a callback for progress updates during long-running tasks. */
  setProgressCallback(cb: (taskName: string, text: string) => void): void {
    this.onProgressCallback = cb;
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
          await saveSessionId(this.sessionId);
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
            await saveSessionId(this.sessionId);
          }

          // Deliver response
          if (this.currentCallback) {
            this.currentCallback(responseText, result.is_error);
            this.currentCallback = null;
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
              // max_turns: try compaction first, then resume with existing session
              console.log(`[agent] max_turns reached — compacting and resuming session`);
              this.turnsSinceCompact = 0;
              this.abortController = new AbortController();
              try {
                // Resume with same session (don't clear sessionId!)
                await this.start();
                // Immediately request compaction
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
                console.log("[agent] Resumed session after max_turns with compaction");
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
