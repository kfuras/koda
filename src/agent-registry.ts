/**
 * Agent Registry — manages multiple named agent instances.
 *
 * Each agent gets its own workspace, system prompt, MCP servers, and
 * persistent query() session. Borrows from OpenClaw's multi-agent model
 * but keeps Koda's production advantages (circuit breakers, budget caps).
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { KODA_HOME, AGENT_DEFAULTS, DEFAULT_TASK_LIMITS, CONFIG } from "./config.js";
import { loadManifests, validateManifests, generateToolContext } from "./manifests.js";
import { loadSkills, generateSkillContext } from "./skills.js";
import { KodaAgent } from "./agent.js";
import { resolveAgent, type Binding } from "./router.js";

// --- Types ---

export interface AgentDef {
  id: string;
  default?: boolean;
  workspace: string;          // absolute path or ~ relative
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: string[];      // filter keys from mcp-servers.json
  skills?: string[];          // skill names to load (empty = none, undefined = all)
}

export interface AgentsConfig {
  defaults?: {
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
  };
  list: AgentDef[];
}

// --- Registry ---

export class AgentRegistry {
  private agents = new Map<string, KodaAgent>();
  private agentDefs = new Map<string, AgentDef>();
  private defaultAgentId: string;
  private bindings: Binding[];

  constructor(agentsConfig: AgentsConfig, bindings: Binding[]) {
    this.bindings = bindings;

    // Find default agent
    const defaultDef = agentsConfig.list.find((a) => a.default);
    this.defaultAgentId = defaultDef?.id ?? agentsConfig.list[0]?.id ?? "home";

    // Register all agent definitions
    for (const def of agentsConfig.list) {
      // Resolve workspace path
      const workspace = def.workspace.replace(/^~/, process.env.HOME ?? "");
      this.agentDefs.set(def.id, { ...def, workspace });
    }
  }

  /** Get or create an agent instance by ID. */
  getAgent(agentId: string): KodaAgent | undefined {
    return this.agents.get(agentId);
  }

  /** Get the agent definition by ID. */
  getDef(agentId: string): AgentDef | undefined {
    return this.agentDefs.get(agentId);
  }

  /** Get the default agent ID. */
  getDefaultAgentId(): string {
    return this.defaultAgentId;
  }

  /** Get all agent IDs. */
  getAgentIds(): string[] {
    return [...this.agentDefs.keys()];
  }

  /** Register a started agent instance. */
  registerAgent(agentId: string, agent: KodaAgent): void {
    this.agents.set(agentId, agent);
  }

  /** Route a message to the correct agent ID using bindings. */
  routeMessage(context: { channel?: string; channelId?: string; userId?: string }): string {
    return resolveAgent(this.bindings, this.defaultAgentId, context);
  }

  /** Get the system prompt for an agent, loading from its workspace. */
  buildSystemPrompt(agentId: string): string {
    const def = this.agentDefs.get(agentId);
    if (!def) throw new Error(`Unknown agent: ${agentId}`);

    const workspace = def.workspace;
    const sharedDir = resolve(KODA_HOME, "shared");

    // Load workspace-specific files
    const soul = readFileSafe(resolve(workspace, "soul.md"));
    const learnings = readFileSafe(resolve(workspace, "learnings.md"));
    const goals = readFileSafe(resolve(workspace, "goals.md"));

    // Load shared files (Tier 1 — all agents read these)
    const sharedUser = readFileSafe(resolve(sharedDir, "user.md"))
      || readFileSafe(resolve(KODA_HOME, "user.md")); // fallback to legacy location
    const sharedPreferences = readFileSafe(resolve(sharedDir, "preferences.md"));
    const sharedGoals = readFileSafe(resolve(sharedDir, "goals.md"));

    // Load crossfeed digest (Tier 3 — cross-agent intelligence)
    const crossfeed = readFileSafe(resolve(KODA_HOME, "crossfeed", "digest.md"));

    // Load tool/skill context
    const manifests = loadManifests();
    validateManifests(manifests);
    const toolContext = generateToolContext(manifests);
    const skills = loadSkills();
    const skillContext = generateSkillContext(skills);

    const owner = CONFIG.agent.owner;
    const social = CONFIG.social;

    return `You are ${def.id === this.defaultAgentId ? CONFIG.agent.name : `${CONFIG.agent.name}:${def.id}`} — an autonomous agent for ${owner}.

Your workspace is ${workspace}/ — your personality, learnings, goals, skills, and state all live there.
${soul ? `\n## Identity\n${soul.slice(0, 500)}` : ""}

## User
${sharedUser || `Owner: ${owner}`}
${sharedPreferences ? `\n## Preferences\n${sharedPreferences}` : ""}

${learnings ? `## Learnings\n${learnings.slice(0, 3000)}` : ""}
${goals ? `## Goals\n${goals}` : ""}
${sharedGoals ? `## Shared Goals\n${sharedGoals}` : ""}
${crossfeed ? `## Cross-Agent Intelligence\n${crossfeed.slice(0, 1000)}` : ""}

Key rules:
- Your workspace is ${workspace}/. Files outside this directory belong to other agents or the operator.
- Daily logs at ${workspace}/data/daily-logs/YYYY-MM-DD.md.
- NEVER print or log credentials.
- NEVER use markdown tables in Discord — use code blocks instead.
- Be concise. Lead with the answer. No filler.
${def.id === this.defaultAgentId ? `
## Agent Delegation — MANDATORY

You are the coordinator. You do NOT have YouTube, X, Bluesky, Instagram, Skool, GSC, Notipo, or content-tools. Those tools live on your specialist agents. You MUST use the **delegate_to_agent** MCP tool to send work to them.

Your specialists (call via delegate_to_agent tool):
- **analytics** — Has YouTube, GSC, Instagram, Bluesky, X tools. Use for ANY request about stats, metrics, analytics, performance, or numbers.
- **social** — Has X, Bluesky, Instagram, content-tools. Use for ANY request about social media posting, engagement, trends, or brand voice.
- **content** — Has content-tools, Notipo, Skool, GSC, Context7. Use for ANY request about blog posts, articles, Skool lessons, content creation, or SEO.

Example: user asks "check my YouTube analytics" → call delegate_to_agent with agent_id="analytics" and task="Pull YouTube 7-day analytics and report key metrics."

You handle directly: general conversation, multi-domain coordination, file operations, Gmail, Airtable, code changes, and tasks that span multiple domains.
` : ""}
## Social Accounts
${social.x_handle ? `- X: @${social.x_handle}` : ""}
${social.bluesky_handle ? `- Bluesky: ${social.bluesky_handle}` : ""}
${social.instagram_handle ? `- Instagram: @${social.instagram_handle}` : ""}
${social.youtube_channel ? `- YouTube: ${social.youtube_channel}` : ""}
${social.website ? `- Website: ${social.website}` : ""}
${social.skool_url ? `- Skool: ${social.skool_url}` : ""}

${toolContext}

${skillContext}
`;
  }

  /**
   * Build sub-agent definitions for the home agent.
   * These let the home agent delegate work to domain specialists
   * via the Agent SDK's built-in sub-agent spawning.
   */
  buildSubAgentDefs(): Record<string, { description: string; prompt: string; model: string }> {
    const subAgents: Record<string, { description: string; prompt: string; model: string }> = {
      // Keep existing utility sub-agents
      researcher: {
        description: "Research agent for gathering information, scanning trends, reading docs, and web searches. Use for the research phase of complex tasks.",
        prompt: "You are a research agent. Gather information thoroughly. Return structured findings. Do not take actions — only research and report.",
        model: "sonnet",
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
      },
    };

    // Add domain agents as sub-agents (skip the default/home agent)
    for (const [id, def] of this.agentDefs) {
      if (id === this.defaultAgentId) continue;

      const soul = readFileSafe(resolve(def.workspace, "soul.md"));
      const learnings = readFileSafe(resolve(def.workspace, "learnings.md"));
      const domainContext = [soul, learnings].filter(Boolean).join("\n\n");

      // Map model names to SDK model format
      const modelMap: Record<string, string> = {
        "claude-opus-4-6": "opus",
        "claude-sonnet-4-6": "sonnet",
        "claude-haiku-4-5": "haiku",
      };
      const sdkModel = modelMap[def.model ?? ""] ?? "sonnet";

      subAgents[id] = {
        description: buildAgentDescription(id, def),
        prompt: domainContext || `You are the ${id} specialist agent.`,
        model: sdkModel,
      };
    }

    return subAgents;
  }

  /** Stop all agents. */
  async stopAll(): Promise<void> {
    for (const agent of this.agents.values()) {
      await agent.stop();
    }
  }
}

// --- Helpers ---

function buildAgentDescription(id: string, def: AgentDef): string {
  const descriptions: Record<string, string> = {
    social: "Social media specialist — handles X, Bluesky, Instagram posting, viral tweet scanning, CTA replies, brand voice, and social engagement. Delegate here when the user asks about social media, posting, engagement, or trends.",
    content: "Content strategist and writer — handles blog posts, X articles, Skool lessons, content proposals, and AI ecosystem watching. Delegate here when the user asks about content creation, blog posts, SEO, or Skool community.",
    analytics: "Data analyst — handles YouTube analytics, GSC reports, Instagram stats, Bluesky stats, goal tracking, and weekly reports. Delegate here when the user asks about metrics, stats, analytics, or performance.",
  };
  return descriptions[id] ?? `Specialist agent for ${id} tasks. Delegate ${id}-related work here.`;
}

function readFileSafe(path: string): string {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Build AgentRegistry from config.json.
 * Falls back to a single "home" agent for backward compatibility.
 */
export function createRegistryFromConfig(): AgentRegistry {
  const raw = CONFIG as unknown as Record<string, unknown>;
  const agentsConfig: AgentsConfig = raw.agents
    ? raw.agents as AgentsConfig
    : {
        list: [{
          id: "home",
          default: true,
          workspace: KODA_HOME,
          model: AGENT_DEFAULTS.model,
        }],
      };

  const bindings: Binding[] = (raw.bindings as Binding[]) ?? [];

  return new AgentRegistry(agentsConfig, bindings);
}
