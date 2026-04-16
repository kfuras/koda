/**
 * Strategy Evolution — self-improving agent behavior.
 *
 * Lightweight version of OpenClaw's GEP/Evolver pattern:
 * - Agents propose experiments (strategy variations)
 * - After check_after_days, the evolve task evaluates results
 * - KEEP: outperformed baseline → update baseline.json
 * - KILL: underperformed → revert, increment kill streak
 * - 3 consecutive KILLs → pause experiments for human review
 *
 * Data files:
 * - ~/.koda/data/strategy/baseline.json — current strategy + version
 * - ~/.koda/data/strategy/experiments.json — active/history + kill streak
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { KODA_HOME } from "../config.js";

const STRATEGY_DIR = `${KODA_HOME}/data/strategy`;
const EXPERIMENTS_FILE = `${STRATEGY_DIR}/experiments.json`;
const BASELINE_FILE = `${STRATEGY_DIR}/baseline.json`;

interface Experiment {
  id: string;
  domain: "social" | "content" | "youtube";
  hypothesis: string;
  mutation: string;        // what we're changing
  baseline_value: string;  // what it was before
  proposed_by: string;     // agent ID
  created: string;
  check_after_days: number;
  check_at: string;
  metric: string;          // what to measure
  status: "active" | "keep" | "kill" | "expired";
  result?: string;
  score_delta?: number;    // % change vs baseline
}

interface ExperimentsData {
  active: Experiment[];
  history: Experiment[];
  kill_streak: number;
  paused: boolean;
}

async function loadExperiments(): Promise<ExperimentsData> {
  try {
    return JSON.parse(await readFile(EXPERIMENTS_FILE, "utf-8"));
  } catch {
    return { active: [], history: [], kill_streak: 0, paused: false };
  }
}

async function saveExperiments(data: ExperimentsData): Promise<void> {
  await mkdir(STRATEGY_DIR, { recursive: true });
  await writeFile(EXPERIMENTS_FILE, JSON.stringify(data, null, 2));
}

// --- Propose experiment tool ---

const proposeExperiment = tool(
  "propose_experiment",
  "Propose a strategy experiment — a variation to test against the current baseline. " +
  "Use when you notice a pattern that MIGHT improve performance but hasn't been proven yet. " +
  "The experiment runs for check_after_days, then the evolve task evaluates it.\n\n" +
  "Examples:\n" +
  "- 'Question hooks get more replies than statement hooks' (social)\n" +
  "- 'Posts under 200 words get higher engagement' (social)\n" +
  "- 'Blog posts with code examples rank faster' (content)\n\n" +
  "Do NOT propose experiments when the system is paused (3 consecutive kills).",
  {
    domain: z.enum(["social", "content", "youtube"]),
    hypothesis: z.string().describe("What you think will happen"),
    mutation: z.string().describe("What to change — be specific"),
    baseline_value: z.string().describe("What the current approach is"),
    metric: z.string().describe("How to measure success (e.g., 'avg likes per tweet', 'blog CTR')"),
    check_after_days: z.number().min(3).max(14).default(7),
  },
  async ({ domain, hypothesis, mutation, baseline_value, metric, check_after_days }) => {
    const data = await loadExperiments();

    if (data.paused) {
      return {
        content: [{
          type: "text" as const,
          text: "PAUSED: 3 consecutive experiments failed. Human review required before proposing new experiments. " +
            "Ask the user to review ~/.koda/data/strategy/experiments.json and reset paused=false.",
        }],
      };
    }

    // Max 2 active experiments at a time
    if (data.active.length >= 2) {
      return {
        content: [{
          type: "text" as const,
          text: `Already ${data.active.length} active experiments. Wait for current experiments to be evaluated before proposing new ones.`,
        }],
      };
    }

    const checkAt = new Date(Date.now() + check_after_days * 86_400_000).toISOString().slice(0, 10);

    const experiment: Experiment = {
      id: `exp-${Date.now()}`,
      domain,
      hypothesis,
      mutation,
      baseline_value,
      proposed_by: "unknown", // filled by caller context
      created: new Date().toISOString().slice(0, 10),
      check_after_days,
      check_at: checkAt,
      metric,
      status: "active",
    };

    data.active.push(experiment);
    await saveExperiments(data);

    return {
      content: [{
        type: "text" as const,
        text: `Experiment proposed: ${experiment.id}\n` +
          `Domain: ${domain}\n` +
          `Hypothesis: ${hypothesis}\n` +
          `Mutation: ${mutation}\n` +
          `Baseline: ${baseline_value}\n` +
          `Metric: ${metric}\n` +
          `Check after: ${check_after_days} days (${checkAt})\n\n` +
          `Apply the mutation in your work starting now. The evolve task will evaluate on ${checkAt}.`,
      }],
    };
  },
);

// --- Check experiment results tool ---

const evaluateExperiment = tool(
  "evaluate_experiment",
  "Evaluate an active experiment by comparing its metric against baseline. " +
  "Called by the strategy_evolve scheduled task. Provide the experiment ID and " +
  "the measured result to trigger a KEEP or KILL verdict.",
  {
    experiment_id: z.string(),
    result_summary: z.string().describe("What happened — measured metric value and context"),
    score_delta_pct: z.number().describe("Percentage change vs baseline (positive = better, negative = worse)"),
    verdict: z.enum(["keep", "kill"]).describe("KEEP if outperformed baseline, KILL if not"),
  },
  async ({ experiment_id, result_summary, score_delta_pct, verdict }) => {
    const data = await loadExperiments();

    const idx = data.active.findIndex((e) => e.id === experiment_id);
    if (idx === -1) {
      return { content: [{ type: "text" as const, text: `Experiment ${experiment_id} not found in active list.` }] };
    }

    const experiment = data.active[idx];
    experiment.status = verdict;
    experiment.result = result_summary;
    experiment.score_delta = score_delta_pct;

    // Move from active to history
    data.active.splice(idx, 1);
    data.history.push(experiment);

    // Update kill streak
    if (verdict === "kill") {
      data.kill_streak++;
      if (data.kill_streak >= 3) {
        data.paused = true;
      }
    } else {
      data.kill_streak = 0; // reset on any KEEP
    }

    await saveExperiments(data);

    // If KEEP, update baseline
    if (verdict === "keep") {
      try {
        const baseline = JSON.parse(await readFile(BASELINE_FILE, "utf-8"));
        baseline.version++;
        baseline.updated = new Date().toISOString().slice(0, 10);

        // Update the relevant strategy field
        if (baseline.strategies[experiment.domain]) {
          // Add a note about the successful experiment
          baseline.strategies[experiment.domain][experiment.mutation.split(" ")[0].toLowerCase()] =
            experiment.mutation;
        }

        baseline.changelog.push({
          version: baseline.version,
          date: baseline.updated,
          note: `KEEP: ${experiment.hypothesis} (+${score_delta_pct}%) — ${experiment.mutation}`,
        });

        // Keep changelog under 20 entries
        if (baseline.changelog.length > 20) {
          baseline.changelog = baseline.changelog.slice(-20);
        }

        await writeFile(BASELINE_FILE, JSON.stringify(baseline, null, 2));
      } catch (err) {
        // Non-fatal — experiment was already recorded
        console.error("[evolve] Failed to update baseline:", err);
      }
    }

    const streakMsg = data.paused
      ? "\n\nCIRCUIT BREAKER: 3 consecutive KILLs. Experiments paused until human review."
      : data.kill_streak > 0
        ? `\nKill streak: ${data.kill_streak}/3`
        : "";

    return {
      content: [{
        type: "text" as const,
        text: `**${verdict.toUpperCase()}** — ${experiment.hypothesis}\n` +
          `Result: ${result_summary}\n` +
          `Score delta: ${score_delta_pct > 0 ? "+" : ""}${score_delta_pct}%` +
          (verdict === "keep" ? "\nBaseline updated." : "\nReverted to baseline.") +
          streakMsg,
      }],
    };
  },
);

export const evolveServer = createSdkMcpServer({
  name: "evolve",
  version: "0.1.0",
  tools: [proposeExperiment, evaluateExperiment],
});
