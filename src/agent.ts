import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.js";
import { SYSTEM_PROMPT, AGENT_DEFAULTS, CONTENT_HUB_DIR } from "./config.js";
import { contentHubServer } from "./tools/content-hub.js";

export interface AgentResult {
  text: string;
  costUsd: number;
  turns: number;
}

export async function runAgent(prompt: string): Promise<AgentResult> {
  let resultText = "";
  let costUsd = 0;
  let turns = 0;

  const q = query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      tools: { type: "preset", preset: "claude_code" },
      model: AGENT_DEFAULTS.model,
      maxTurns: AGENT_DEFAULTS.maxTurns,
      maxBudgetUsd: AGENT_DEFAULTS.maxBudgetUsd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: CONTENT_HUB_DIR,
      settingSources: ["project"],
      mcpServers: {
        "content-hub": contentHubServer,
        youtube: {
          command: "youtube-studio-mcp",
          args: [],
        },
        "x-mcp": {
          command: "python3",
          args: ["/Users/YOUR_USERNAME/code/content-hub/servers/x_mcp_server.py"],
        },
        "bluesky-mcp": {
          command: "npx",
          args: ["-y", "@semihberkay/bluesky-mcp"],
          env: {
            BLUESKY_IDENTIFIER: "kjetilfuras.bsky.social",
            BLUESKY_PASSWORD: process.env.BLUESKY_APP_PASSWORD ?? "",
          },
        },
        gmail: {
          command: "/Users/YOUR_USERNAME/code/gmail-mcp/.venv/bin/python",
          args: ["/Users/YOUR_USERNAME/code/gmail-mcp/server.py"],
        },
        airtable: {
          command: "/Users/YOUR_USERNAME/code/n8n-assistant/scripts/run-airtable-mcp.sh",
          args: [],
        },
      },
    },
  });

  for await (const message of q) {
    console.log(`[agent] message type=${message.type}${("subtype" in message) ? ` subtype=${(message as Record<string, unknown>).subtype}` : ""}`);
    if (message.type === "result") {
      const result = message as SDKResultMessage;
      costUsd = result.total_cost_usd;
      turns = result.num_turns;
      if (result.subtype === "success") {
        resultText = result.result;
      } else {
        resultText = `Agent error (${result.subtype}): ${result.errors.join(", ")}`;
      }
    }
  }

  return { text: resultText, costUsd, turns };
}
