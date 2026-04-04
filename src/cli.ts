import { createInterface } from "node:readline";
import { KodaAgent } from "./agent.js";

async function main() {
  console.log("Koda CLI — type a message, press Enter. Type 'exit' to quit.\n");

  const agent = new KodaAgent();
  await agent.start();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
  });

  rl.prompt();

  rl.on("line", (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "exit" || input === "quit") {
      console.log("Shutting down...");
      void agent.stop();
      rl.close();
      process.exit(0);
    }

    agent.send(input, (responseText) => {
      console.log(`\nkoda> ${responseText}\n`);
      rl.prompt();
    });
  });

  rl.on("close", () => {
    void agent.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
