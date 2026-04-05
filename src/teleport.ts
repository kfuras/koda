/**
 * Teleport — transfer context between Claude Code CLI and Koda.
 *
 * Save: Koda dumps current conversation context to ~/.koda/data/teleport.json
 * Load: Claude Code CLI reads the file to resume context
 *
 * Format: { timestamp, sessionId, context, summary }
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { KODA_HOME } from "./config.js";

const TELEPORT_FILE = resolve(KODA_HOME, "data/teleport.json");

export interface TeleportPayload {
  timestamp: string;
  sessionId: string | undefined;
  direction: "koda-to-cli" | "cli-to-koda";
  summary: string;
  context: string;
  files?: string[];
}

/**
 * Save context for teleporting to Claude Code CLI.
 * Koda writes its current state so the CLI can pick it up.
 */
export async function teleportSave(
  sessionId: string | undefined,
  summary: string,
  context: string,
  files?: string[],
): Promise<string> {
  await mkdir(resolve(KODA_HOME, "data"), { recursive: true });

  const payload: TeleportPayload = {
    timestamp: new Date().toISOString(),
    sessionId,
    direction: "koda-to-cli",
    summary,
    context,
    files,
  };

  await writeFile(TELEPORT_FILE, JSON.stringify(payload, null, 2));
  return TELEPORT_FILE;
}

/**
 * Load context teleported from Claude Code CLI.
 * Returns the payload if one exists, or null.
 */
export async function teleportLoad(): Promise<TeleportPayload | null> {
  try {
    const data = await readFile(TELEPORT_FILE, "utf-8");
    const payload: TeleportPayload = JSON.parse(data);
    if (payload.direction === "cli-to-koda") {
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check for incoming teleport on startup.
 * If Claude Code CLI saved context for Koda, inject it into the agent.
 */
export async function checkIncomingTeleport(
  sendToAgent: (text: string) => void,
): Promise<boolean> {
  const payload = await teleportLoad();
  if (!payload) return false;

  console.log(`[teleport] Incoming context from CLI (${payload.timestamp})`);

  const prompt =
    `[TELEPORT — context from Claude Code CLI]\n\n` +
    `**Summary:** ${payload.summary}\n\n` +
    `**Context:**\n${payload.context}\n\n` +
    (payload.files?.length ? `**Files involved:** ${payload.files.join(", ")}\n\n` : "") +
    `Continue this work. The user transferred this context from their CLI session to you.`;

  sendToAgent(prompt);

  // Clear the teleport file so it doesn't trigger again
  await writeFile(TELEPORT_FILE, JSON.stringify({ consumed: true, consumedAt: new Date().toISOString() }));
  return true;
}
