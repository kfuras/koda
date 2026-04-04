import { KodaAgent } from "./agent.js";
import { KodaBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";
import { startWebhookServer } from "./webhooks.js";
import { setupVoiceCommands } from "./voice.js";

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

  // 6. Announce we're online
  await bot.sendStartupMessage();

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
