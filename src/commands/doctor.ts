/**
 * koda doctor — check Koda configuration for drift against the schema.
 *
 * Inspired by `openclaw doctor`. Reads the expected .env schema from the
 * repo's .env.example, compares to ~/.koda/.env, and reports any missing
 * required fields. Also verifies ~/.koda/config.json has the required shape
 * and checks that the build artifacts + dependencies exist.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { findKodaRepoRoot } from "./_paths.js";

const KODA_HOME = process.env.KODA_HOME ?? resolve(homedir(), ".koda");

export const description = "Check Koda configuration for drift against the schema";

interface DoctorResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

export async function runDoctor(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: koda doctor [--fix]");
    console.log("  Checks ~/.koda/ configuration for drift against the schema");
    console.log("  expected by the current code. Reports missing required env");
    console.log("  vars, invalid config.json, and missing build artifacts.");
    return 0;
  }

  const fix = args.includes("--fix");
  const result: DoctorResult = { ok: true, errors: [], warnings: [], info: [] };

  // 1. KODA_HOME exists
  if (!existsSync(KODA_HOME)) {
    result.errors.push(`~/.koda/ does not exist at ${KODA_HOME}`);
    result.ok = false;
    return renderResult(result);
  }
  result.info.push(`~/.koda/ at ${KODA_HOME}`);

  // 2. Find repo root
  let repoRoot: string;
  try {
    repoRoot = findKodaRepoRoot();
    result.info.push(`Repo at ${repoRoot}`);
  } catch (err) {
    result.errors.push(`Cannot locate Koda repo: ${err instanceof Error ? err.message : err}`);
    result.ok = false;
    return renderResult(result);
  }

  // 3. .env schema check
  const envPath = resolve(KODA_HOME, ".env");
  const envExamplePath = resolve(repoRoot, ".env.example");

  if (!existsSync(envPath)) {
    result.errors.push(`~/.koda/.env is missing`);
    result.ok = false;
  } else if (existsSync(envExamplePath)) {
    const envContent = readFileSync(envPath, "utf-8");
    const exampleContent = readFileSync(envExamplePath, "utf-8");

    const envAllKeys = parseEnvKeys(envContent, false);
    const envActiveKeys = parseEnvKeys(envContent, true);
    const exampleActiveKeys = parseEnvKeys(exampleContent, true);
    const exampleAllKeys = parseEnvKeys(exampleContent, false);

    // Keys present in .env.example (as active defaults) but not in the
    // user's active .env. These are "suggested" — the daemon may have a
    // hardcoded default for them via `process.env.X ?? "fallback"` in
    // config.ts, so missing ones are warnings, not errors. Actually-
    // required env vars throw at daemon startup via `required()` and
    // would already have killed the process.
    const missingSuggested = exampleActiveKeys.filter(k => !envActiveKeys.includes(k));
    for (const k of missingSuggested) {
      result.warnings.push(`Suggested env var not set: ${k} (see .env.example)`);
    }

    // New optional vars in .env.example (commented) that user doesn't have
    // at all — not even commented in their .env.
    const newOptional = exampleAllKeys.filter(
      k => !envAllKeys.includes(k) && !exampleActiveKeys.includes(k),
    );
    for (const k of newOptional) {
      result.warnings.push(`New optional env var available: ${k}`);
    }

    result.info.push(`.env: ${envActiveKeys.length} active keys`);
  } else {
    result.warnings.push(`.env.example not found in repo — skipping schema check`);
  }

  // 4. config.json check
  const configPath = resolve(KODA_HOME, "config.json");
  if (!existsSync(configPath)) {
    result.errors.push(`~/.koda/config.json is missing`);
    result.ok = false;
  } else {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const requiredTop = ["agent", "paths", "social", "gsc", "discord"];
      for (const f of requiredTop) {
        if (!(f in cfg)) {
          result.errors.push(`config.json missing required field: ${f}`);
          result.ok = false;
        }
      }
      const agent = cfg.agent as Record<string, unknown> | undefined;
      if (agent) {
        for (const f of ["name", "owner", "model"]) {
          if (!(f in agent)) {
            result.errors.push(`config.json: agent.${f} missing`);
            result.ok = false;
          }
        }
      }
      result.info.push(`config.json: valid`);
    } catch (err) {
      result.errors.push(`config.json: invalid JSON — ${err instanceof Error ? err.message : err}`);
      result.ok = false;
    }
  }

  // 5. Key state directories
  for (const d of ["skills", "data"]) {
    if (!existsSync(resolve(KODA_HOME, d))) {
      result.warnings.push(`~/.koda/${d}/ does not exist (will be auto-created)`);
    }
  }

  // 6. Build artifacts
  if (!existsSync(resolve(repoRoot, "dist/index.js"))) {
    result.warnings.push(`dist/index.js not found — run 'npm run build' in the repo`);
  } else {
    result.info.push(`dist/ built`);
  }

  // 7. Critical dependency check
  if (!existsSync(resolve(repoRoot, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"))) {
    result.errors.push(`@anthropic-ai/claude-agent-sdk not installed — run 'npm install' in the repo`);
    result.ok = false;
  }

  if (fix) {
    result.info.push(`--fix is a no-op for now; the reported errors need manual attention`);
  }

  return renderResult(result);
}

function parseEnvKeys(content: string, activeOnly: boolean): string[] {
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const activeMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (activeMatch) {
      keys.add(activeMatch[1]);
      continue;
    }
    if (activeOnly) continue;
    const commentedMatch = trimmed.match(/^#\s*([A-Z_][A-Z0-9_]*)=/);
    if (commentedMatch) keys.add(commentedMatch[1]);
  }
  return Array.from(keys);
}

function renderResult(r: DoctorResult): number {
  console.log("");
  console.log("\x1b[1mKoda doctor\x1b[0m");
  console.log("");

  for (const i of r.info) {
    console.log(`  \x1b[32m✓\x1b[0m ${i}`);
  }
  if (r.info.length > 0) console.log("");

  for (const w of r.warnings) {
    console.log(`  \x1b[33m⚠\x1b[0m ${w}`);
  }
  if (r.warnings.length > 0) console.log("");

  for (const e of r.errors) {
    console.log(`  \x1b[31m✗\x1b[0m ${e}`);
  }
  if (r.errors.length > 0) console.log("");

  if (r.ok) {
    console.log("\x1b[32mhealthy\x1b[0m");
    console.log("");
    return 0;
  } else {
    console.log("\x1b[31merrors found — see above\x1b[0m");
    console.log("");
    return 1;
  }
}
