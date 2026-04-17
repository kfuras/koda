import { watch } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { KodaAgent } from "./agent.js";
import { KodaBot } from "./bot.js";
import { startScheduler, reloadTasks } from "./scheduler.js";
import { startWebhookServer } from "./webhooks.js";
import { setupVoiceCommands } from "./voice.js";
import { KODA_HOME } from "./config.js";
import { checkIncomingTeleport } from "./teleport.js";
import { checkMemoryFreshness } from "./runtime.js";
import { createRegistryFromConfig, type AgentRegistry } from "./agent-registry.js";
import { setDelegateRegistry } from "./tools/delegate.js";
import { contentDedup, socialDedup, skoolDedup } from "./patterns.js";

/**
 * Read the restart reason persisted by restart_self, if any.
 * Returns the reason string and deletes the file so the next cold start
 * doesn't include stale info.
 */
async function consumeRestartReason(): Promise<string | undefined> {
  const file = resolve(KODA_HOME, "data/.last-restart.json");
  try {
    const raw = await readFile(file, "utf-8");
    const payload = JSON.parse(raw) as { reason?: string };
    await unlink(file).catch(() => {}); // best-effort cleanup
    return payload.reason;
  } catch {
    return undefined;
  }
}

// --- Hot-reload file watcher ---

function startFileWatcher(bot: KodaBot): void {
  const DEBOUNCE_MS = 300;
  const timers = new Map<string, NodeJS.Timeout>();

  const watchFile = (filePath: string, label: string, onReload: () => void) => {
    try {
      watch(filePath, () => {
        // Debounce: clear previous timer, set new one
        const existing = timers.get(filePath);
        if (existing) clearTimeout(existing);

        timers.set(filePath, setTimeout(() => {
          console.log(`[hot-reload] ${label} changed — reloading`);
          try {
            onReload();
            void bot.sendToChannel(`**[hot-reload]** ${label} reloaded.`);
          } catch (err) {
            console.error(`[hot-reload] Failed to reload ${label}:`, err);
          }
        }, DEBOUNCE_MS));
      });
      console.log(`  hot-reload: watching ${label}`);
    } catch (err) {
      console.error(`[hot-reload] Cannot watch ${filePath}:`, err instanceof Error ? err.message : err);
    }
  };

  watchFile(resolve(KODA_HOME, "tasks.json"), "tasks.json", () => {
    reloadTasks();
  });

  watchFile(resolve(KODA_HOME, "mcp-servers.json"), "mcp-servers.json", () => {
    // MCP servers are loaded at query creation time, so this is informational.
    // A full reload would require restarting the agent session.
    console.log("[hot-reload] mcp-servers.json changed — will apply on next session restart");
  });
}

// Prevent unhandled errors from crashing the process
process.on("unhandledRejection", (err) => {
  console.error("[unhandled]", err);
});

async function bootAgents(registry: AgentRegistry): Promise<void> {
  const agentIds = registry.getAgentIds();
  const defaultId = registry.getDefaultAgentId();
  console.log(`[boot] Starting ${agentIds.length} agent(s): ${agentIds.join(", ")}`);

  // Build sub-agent definitions (researcher/implementer/verifier for home agent)
  const subAgents = registry.buildSubAgentDefs();

  for (const agentId of agentIds) {
    const def = registry.getDef(agentId)!;
    const systemPrompt = registry.buildSystemPrompt(agentId);
    const isHome = agentId === defaultId;

    const agent = new KodaAgent({
      id: agentId,
      workspace: def.workspace,
      systemPrompt,
      model: def.model,
      maxTurns: def.maxTurns,
      maxBudgetUsd: def.maxBudgetUsd,
      mcpServerFilter: def.mcpServers,
      // Only the home agent gets sub-agent delegation capabilities
      subAgents: isHome ? subAgents : undefined,
    });

    await agent.start();
    registry.registerAgent(agentId, agent);
  }
}

async function main() {
  console.log("Starting Koda agent...");

  // 1. Build agent registry from config
  const registry = createRegistryFromConfig();

  // 2. Start all agents
  await bootAgents(registry);

  // 3. Warm up dedup caches from disk
  await Promise.all([contentDedup.warmup(), socialDedup.warmup(), skoolDedup.warmup()]);

  // 4. Inject registry into delegation tool so home agent can delegate
  setDelegateRegistry(registry);

  // 4. Start cache heartbeat on all agents (55min keep-alive, prevents Anthropic cache expiry)
  for (const agentId of registry.getAgentIds()) {
    registry.getAgent(agentId)?.startCacheHeartbeat();
  }

  // 5. Get the default agent (for backward-compatible single-agent paths)
  const defaultAgent = registry.getAgent(registry.getDefaultAgentId())!;

  // 4. Start Discord bot (routes messages to agents via registry)
  const bot = new KodaBot(defaultAgent, registry);
  await bot.start();

  // 5. Start scheduler (routes tasks to agents via registry)
  startScheduler(defaultAgent, bot, registry);

  // 6. Start GitHub webhook listener
  startWebhookServer(defaultAgent, bot);

  // 7. Setup voice channel commands
  setupVoiceCommands(bot, defaultAgent);

  // 8. Check for incoming teleport from CLI
  await checkIncomingTeleport((text) => {
    defaultAgent.send(text, async (response) => {
      await bot.sendToChannel(`**[teleport]** Resumed from CLI context:\n\n${response}`);
    });
  });

  // 9. Check memory freshness and warn agent
  const freshnessWarning = await checkMemoryFreshness();
  if (freshnessWarning) {
    console.log(`[freshness] ${freshnessWarning}`);
    defaultAgent.send(
      `[SYSTEM: Memory freshness check]\n${freshnessWarning}`,
      () => {},
    );
  }

  // 10. Announce we're online
  const restartReason = await consumeRestartReason();
  const agentCount = registry.getAgentIds().length;
  await bot.sendStartupMessage(restartReason, agentCount);

  // 11. Hot-reload config files (tasks.json, mcp-servers.json)
  startFileWatcher(bot);

  // Graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      console.log(`Received ${signal}, shutting down...`);
      await registry.stopAll();
      bot.getClient().destroy();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
