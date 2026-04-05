/**
 * Reusable patterns extracted from Claude Code architecture.
 *
 * - AsyncQueue: sequential execution wrapper (FIFO, prevents race conditions)
 * - CircuitBreaker: stop retrying after N consecutive failures
 * - SessionRegistry: track active sessions, prevent duplicate execution
 */

import { writeFile, readFile, mkdir, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { KODA_HOME } from "./config.js";

// ---------------------------------------------------------------------------
// 1. AsyncQueue — sequential execution wrapper
// ---------------------------------------------------------------------------

export class AsyncQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  /**
   * Enqueue a function to run sequentially. Returns when that function completes.
   * All enqueued functions execute in FIFO order, one at a time.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      await task();
    }
    this.running = false;
  }
}

/** Shared queue for all state-file writes (task results, observations, outcomes). */
export const stateFileQueue = new AsyncQueue();

// ---------------------------------------------------------------------------
// 2. CircuitBreaker — stop after N consecutive failures
// ---------------------------------------------------------------------------

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private readonly threshold: number;
  private readonly cooldownMs: number;

  /**
   * @param threshold  Number of consecutive failures before the circuit opens.
   * @param cooldownMs Time in ms before a tripped circuit resets and allows retries.
   */
  constructor(threshold = 3, cooldownMs = 30 * 60_000) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  /** Returns true if the circuit is open (should NOT attempt the operation). */
  isOpen(key: string): boolean {
    const state = this.circuits.get(key);
    if (!state?.open) return false;

    // Check if cooldown has elapsed
    if (Date.now() - state.lastFailure >= this.cooldownMs) {
      state.open = false;
      state.failures = 0;
      console.log(`[circuit] ${key}: cooldown elapsed, circuit closed`);
      return false;
    }
    return true;
  }

  /** Record a failure. Returns true if the circuit just tripped open. */
  recordFailure(key: string): boolean {
    let state = this.circuits.get(key);
    if (!state) {
      state = { failures: 0, lastFailure: 0, open: false };
      this.circuits.set(key, state);
    }

    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= this.threshold && !state.open) {
      state.open = true;
      console.log(`[circuit] ${key}: OPEN after ${state.failures} consecutive failures (cooldown: ${this.cooldownMs / 60_000}min)`);
      return true;
    }
    return false;
  }

  /** Record a success — resets the failure counter. */
  recordSuccess(key: string): void {
    const state = this.circuits.get(key);
    if (state) {
      state.failures = 0;
      state.open = false;
    }
  }

  /** Get circuit status for diagnostics. */
  status(key: string): { failures: number; open: boolean; cooldownRemaining: number } {
    const state = this.circuits.get(key);
    if (!state) return { failures: 0, open: false, cooldownRemaining: 0 };
    const remaining = state.open ? Math.max(0, this.cooldownMs - (Date.now() - state.lastFailure)) : 0;
    return { failures: state.failures, open: state.open, cooldownRemaining: remaining };
  }
}

/** Shared circuit breaker for task execution. */
export const taskCircuitBreaker = new CircuitBreaker(3, 30 * 60_000);

// ---------------------------------------------------------------------------
// 3. SessionRegistry — track active sessions, prevent duplicates
// ---------------------------------------------------------------------------

const SESSIONS_DIR = resolve(KODA_HOME, "data/sessions");

interface SessionEntry {
  pid: number;
  taskName: string;
  startedAt: string;
  status: "running" | "completed" | "failed";
}

export class SessionRegistry {
  /** Register a new active session. Returns the session file path. */
  async register(taskName: string): Promise<string> {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const id = `${taskName}-${Date.now()}`;
    const entry: SessionEntry = {
      pid: process.pid,
      taskName,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    const filePath = resolve(SESSIONS_DIR, `${id}.json`);
    await writeFile(filePath, JSON.stringify(entry, null, 2));
    return filePath;
  }

  /** Check if a task is already running. */
  async isRunning(taskName: string): Promise<boolean> {
    try {
      const files = await readdir(SESSIONS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data: SessionEntry = JSON.parse(
            await readFile(resolve(SESSIONS_DIR, file), "utf-8"),
          );
          if (data.taskName === taskName && data.status === "running" && data.pid === process.pid) {
            return true;
          }
        } catch {
          // Corrupt file — skip
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
    return false;
  }

  /** Mark a session as completed or failed. */
  async complete(sessionPath: string, status: "completed" | "failed"): Promise<void> {
    try {
      const data: SessionEntry = JSON.parse(await readFile(sessionPath, "utf-8"));
      data.status = status;
      await writeFile(sessionPath, JSON.stringify(data, null, 2));
    } catch {
      // Session file may have been cleaned up
    }
  }

  /** Clean up stale sessions from this PID (e.g., after crash recovery). */
  async cleanupStale(): Promise<number> {
    let cleaned = 0;
    try {
      await mkdir(SESSIONS_DIR, { recursive: true });
      const files = await readdir(SESSIONS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data: SessionEntry = JSON.parse(
            await readFile(resolve(SESSIONS_DIR, file), "utf-8"),
          );
          // Clean up "running" sessions from our PID (leftover from crash)
          // or sessions older than 4 hours
          const age = Date.now() - new Date(data.startedAt).getTime();
          if (data.status === "running" && (data.pid === process.pid || age > 4 * 3600_000)) {
            await unlink(resolve(SESSIONS_DIR, file));
            cleaned++;
          }
        } catch {
          // Corrupt — remove it
          await unlink(resolve(SESSIONS_DIR, file)).catch(() => {});
          cleaned++;
        }
      }
    } catch {
      // No sessions dir
    }
    if (cleaned > 0) console.log(`[sessions] Cleaned up ${cleaned} stale sessions`);
    return cleaned;
  }
}

export const sessionRegistry = new SessionRegistry();
