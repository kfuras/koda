/**
 * koda chat — send a message to the running Koda daemon and print the response.
 *
 * Like OpenClaw's `openclaw -p "message"` — talks to the live agent
 * via the webhook server's /chat endpoint.
 *
 * Usage:
 *   koda chat "check my YouTube analytics"
 *   koda chat                              # interactive mode
 */

import { createInterface } from "node:readline";

export const description = "Send a message to the running daemon";

const PORT = parseInt(process.env.WEBHOOK_PORT ?? "3847", 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function sendMessage(message: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { response: string; error: boolean };
  return data.response;
}

async function checkDaemon(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function runChat(args: string[]): Promise<number> {
  // Check if daemon is running
  if (!(await checkDaemon())) {
    console.error("Koda daemon is not running. Start it with: koda daemon");
    return 1;
  }

  // One-shot mode: koda chat "message"
  if (args.length > 0 && args[0] !== "--help" && args[0] !== "-h") {
    const message = args.join(" ");
    console.log(`\x1b[90msending to koda...\x1b[0m`);

    try {
      const response = await sendMessage(message);
      console.log(`\n${response}`);
      return 0;
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: koda chat [message]");
    console.log("  koda chat \"check analytics\"  — one-shot message");
    console.log("  koda chat                     — interactive mode");
    return 0;
  }

  // Interactive mode
  console.log("Koda Chat — type a message, press Enter. Type 'exit' to quit.\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36myou>\x1b[0m ",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "exit" || input === "quit") {
      rl.close();
      return;
    }

    console.log(`\x1b[90msending...\x1b[0m`);

    try {
      const response = await sendMessage(input);
      console.log(`\n\x1b[33mkoda>\x1b[0m ${response}\n`);
    } catch (err) {
      console.error(`\x1b[31mError: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
    }

    rl.prompt();
  });

  return new Promise<number>((resolve) => {
    rl.on("close", () => resolve(0));
  });
}
