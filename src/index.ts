import { startBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";

async function main() {
  console.log("Starting Koda agent...");
  const client = await startBot();
  startScheduler(client);

  // Graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`Received ${signal}, shutting down...`);
      client.destroy();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
