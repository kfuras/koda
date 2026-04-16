/**
 * Delegation tool — lets the home agent send work to domain agents.
 *
 * This is Koda's equivalent of OpenClaw's sessions_send pattern.
 * The home agent calls delegate_to_agent, which runs the task on
 * the target agent's isolated session (with its own MCP servers),
 * and returns the result.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type KodaAgent } from "../agent.js";
import { type AgentRegistry } from "../agent-registry.js";

let registry: AgentRegistry | null = null;

/** Call this at boot to inject the registry. */
export function setDelegateRegistry(reg: AgentRegistry): void {
  registry = reg;
}

const delegateToAgent = tool(
  "delegate_to_agent",
  "Delegate a task to a specialist domain agent. The agent runs the task using its own " +
  "tools (MCP servers) and returns the result. Use this when the user asks about something " +
  "in a specific domain:\n" +
  "- 'analytics' — YouTube stats, GSC reports, Instagram metrics, goal tracking, performance data\n" +
  "- 'social' — X/Bluesky/Instagram posting, viral scanning, engagement, brand voice\n" +
  "- 'content' — blog posts, articles, Skool lessons, content proposals, SEO writing\n\n" +
  "The specialist has its own focused context and domain-specific tools that you don't have.",
  {
    agent_id: z.enum(["analytics", "social", "content"]).describe("Which specialist agent to delegate to"),
    task: z.string().describe("Clear description of what the agent should do. Be specific."),
  },
  async ({ agent_id, task }) => {
    if (!registry) {
      return { content: [{ type: "text" as const, text: "Error: Agent registry not initialized." }] };
    }

    const agent = registry.getAgent(agent_id);
    if (!agent) {
      return { content: [{ type: "text" as const, text: `Error: Agent '${agent_id}' not found or not started.` }] };
    }

    console.log(`[delegate] home → ${agent_id}: ${task.slice(0, 100)}...`);

    try {
      const result = await agent.runIsolatedTask(
        `delegate:${agent_id}`,
        task,
        { maxTurns: 25, maxBudgetUsd: 5 },
      );

      const status = result.isError ? "FAILED" : "OK";
      console.log(`[delegate] ${agent_id} ${status} ($${result.cost.toFixed(2)}, ${result.turns}t)`);

      return {
        content: [{
          type: "text" as const,
          text: result.isError
            ? `[${agent_id} agent error]: ${result.text}`
            : `[${agent_id} agent response]:\n${result.text}`,
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[delegate] ${agent_id} crashed: ${msg}`);
      return { content: [{ type: "text" as const, text: `[${agent_id} agent crashed]: ${msg}` }] };
    }
  },
);

export const delegateServer = createSdkMcpServer({
  name: "delegate",
  version: "0.1.0",
  tools: [delegateToAgent],
});
