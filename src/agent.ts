import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKResultMessage,
  SDKUserMessage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_PROMPT, AGENT_DEFAULTS, CONTENT_HUB_DIR, TASK_LIMITS, DEFAULT_TASK_LIMITS } from "./config.js";
import { agentToolsServer } from "./tools/agent-tools.js";
import { gscServer } from "./tools/gsc.js";

// --- Types ---

export type ResponseCallback = (text: string, isError: boolean) => void;

interface PendingMessage {
  userMessage: SDKUserMessage;
  onResponse: ResponseCallback;
}

// --- Session persistence ---

const SESSION_FILE = resolve(CONTENT_HUB_DIR, "data/.koda-session-id");

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
]);

const MEDIUM_RISK_TOOLS = new Set([
  "generate_image", "skool_airtable_sync",
  "mcp__airtable__create_record", "mcp__airtable__update_records",
  "mcp__airtable__delete_records",
]);

function classifyRisk(toolName: string): "LOW" | "MEDIUM" | "HIGH" {
  if (HIGH_RISK_TOOLS.has(toolName)) return "HIGH";
  if (MEDIUM_RISK_TOOLS.has(toolName)) return "MEDIUM";
  return "LOW";
}

// --- MCP config: built-in SDK servers + external from mcp-servers.json ---

const MCP_SERVERS_FILE = resolve(import.meta.dirname ?? ".", "..", "mcp-servers.json");

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

export class KodaAgent {
  private turnsSinceCompact = 0;
  private queryInstance: Query | null = null;
  private abortController = new AbortController();
  private messageQueue = new MessageQueue();
  private currentCallback: ResponseCallback | null = null;
  private running = false;
  private sessionId: string | undefined;

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
        settingSources: ["project"],
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
  ): Promise<{ text: string; cost: number; turns: number; isError: boolean }> {
    const limits = TASK_LIMITS[taskName] ?? DEFAULT_TASK_LIMITS;
    const controller = new AbortController();

    // Create a one-shot prompt (no streaming input)
    const taskQuery = query({
      prompt: prompt,
      options: {
        abortController: controller,
        systemPrompt: SYSTEM_PROMPT,
        tools: { type: "preset", preset: "claude_code" },
        model: AGENT_DEFAULTS.model,
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.maxBudgetUsd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: CONTENT_HUB_DIR,
        settingSources: ["project"],
        mcpServers: getMcpServers(),
      },
    });

    let resultText = "";
    let totalCost = 0;
    let totalTurns = 0;
    let isError = false;

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
          const textBlocks = (assistantMsg.message?.content ?? []).filter(
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
    }

    console.log(
      `[task:${taskName}] ${isError ? "FAILED" : "OK"} (${totalTurns} turns, $${totalCost.toFixed(2)}, limit: ${limits.maxTurns}t/$${limits.maxBudgetUsd})`,
    );

    return { text: resultText, cost: totalCost, turns: totalTurns, isError };
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

    try {
      for await (const message of this.queryInstance) {
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

          // Log tool calls with risk classification
          for (const block of content) {
            if ((block as { type: string }).type === "tool_use") {
              const toolBlock = block as { type: string; name?: string; input?: unknown };
              const risk = classifyRisk(toolBlock.name ?? "unknown");
              if (risk === "HIGH") {
                console.log(`[yolo] HIGH RISK: ${toolBlock.name} — ${JSON.stringify(toolBlock.input).slice(0, 200)}`);
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

          currentText = "";
          this.turnsSinceCompact += result.num_turns ?? 1;
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
            console.log(`[agent] Fatal error (${result.subtype}) — restarting session in 5s...`);
            await new Promise((r) => setTimeout(r, 5000));
            if (this.running) {
              this.sessionId = undefined;
              this.abortController = new AbortController();
              try {
                await this.start();
                console.log("[agent] Session restarted after max_turns recovery");
              } catch (restartErr) {
                console.error("[agent] Recovery restart failed:", restartErr);
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

      // Auto-restart the agent session
      if (this.running) {
        console.log("[agent] Auto-restarting in 5 seconds...");
        await new Promise((r) => setTimeout(r, 5000));
        if (this.running) {
          try {
            this.abortController = new AbortController();
            await this.start();
            console.log("[agent] Auto-restart successful");
          } catch (restartErr) {
            console.error("[agent] Auto-restart failed:", restartErr);
            // Retry again in 30 seconds
            setTimeout(() => {
              if (this.running) {
                console.log("[agent] Retrying auto-restart...");
                this.abortController = new AbortController();
                this.start().catch((e) => console.error("[agent] Retry failed:", e));
              }
            }, 30_000);
          }
        }
      }
    }
  }
}
