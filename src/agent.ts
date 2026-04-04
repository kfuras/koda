import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKResultMessage,
  SDKUserMessage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SYSTEM_PROMPT, AGENT_DEFAULTS, CONTENT_HUB_DIR } from "./config.js";
import { contentHubServer } from "./tools/content-hub.js";
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

// --- Persistent Agent ---

export class KodaAgent {
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
        mcpServers: {
          "content-hub": contentHubServer,
          "agent-tools": agentToolsServer,
          gsc: gscServer,
          context7: {
            command: "npx",
            args: ["-y", "@upstash/context7-mcp"],
          },
          youtube: {
            command: "youtube-studio-mcp",
            args: [],
          },
          "x-mcp": {
            command: process.env.X_MCP_COMMAND ?? "python3",
            args: [process.env.X_MCP_PATH ?? `${CONTENT_HUB_DIR}/servers/x_mcp_server.py`],
          },
          "bluesky-mcp": {
            command: "npx",
            args: ["-y", "@semihberkay/bluesky-mcp"],
            env: {
              BLUESKY_IDENTIFIER: process.env.BLUESKY_HANDLE ?? "kjetilfuras.bsky.social",
              BLUESKY_PASSWORD: process.env.BLUESKY_APP_PASSWORD ?? "",
            },
          },
          gmail: {
            command: process.env.GMAIL_MCP_PYTHON ?? "/Users/YOUR_USERNAME/code/gmail-mcp/.venv/bin/python",
            args: [process.env.GMAIL_MCP_PATH ?? "/Users/YOUR_USERNAME/code/gmail-mcp/server.py"],
          },
          airtable: {
            command: process.env.AIRTABLE_MCP_COMMAND ?? "/Users/YOUR_USERNAME/code/n8n-assistant/scripts/run-airtable-mcp.sh",
            args: [],
          },
        },
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
          console.log(
            `[agent] Turn complete (${result.num_turns} turns, $${result.total_cost_usd.toFixed(2)})`,
          );
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[agent] Stream error:", errorMsg);
      if (this.currentCallback) {
        this.currentCallback(`Agent stream error: ${errorMsg}`, true);
        this.currentCallback = null;
      }
    }
  }
}
