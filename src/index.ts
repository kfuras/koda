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

async function main() {
  console.log("Starting Koda agent...");

  // 1. Start persistent agent session
  const agent = new KodaAgent();
  await agent.start();

  // 2. Start Discord bot (feeds messages into agent)
  const bot = new KodaBot(agent);
  await bot.start();

  // 3. Start scheduler (feeds tasks into agent via bot)
  startScheduler(agent, bot);

  // 4. Start GitHub webhook listener
  startWebhookServer(agent, bot);

  // 5. Setup voice channel commands
  setupVoiceCommands(bot, agent);

  // 6. Check for incoming teleport from CLI
  await checkIncomingTeleport((text) => {
    agent.send(text, async (response) => {
      await bot.sendToChannel(`**[teleport]** Resumed from CLI context:\n\n${response}`);
    });
  });

  // 7. Check memory freshness and warn agent
  const freshnessWarning = await checkMemoryFreshness();
  if (freshnessWarning) {
    console.log(`[freshness] ${freshnessWarning}`);
    agent.send(
      `[SYSTEM: Memory freshness check]\n${freshnessWarning}`,
      () => {},
    );
  }

  // 8. Announce we're online — include the restart reason if one was persisted
  //    by restart_self, and surface skill count so the operator has visible
  //    feedback that the restart completed and the new state loaded.
  const restartReason = await consumeRestartReason();
  await bot.sendStartupMessage(restartReason);

  // 8. Hot-reload config files (tasks.json, mcp-servers.json)
  startFileWatcher(bot);

  // Graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      console.log(`Received ${signal}, shutting down...`);
      await agent.stop();
      bot.getClient().destroy();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
