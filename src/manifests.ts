/**
 * Plugin manifest system — loads tool manifests at startup,
 * validates env vars, and generates system prompt context.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MANIFESTS_DIR = resolve(import.meta.dirname ?? ".", "..", "manifests");

export interface ToolManifest {
  name: string;
  description: string;
  risk?: string;
  usage?: string;
  requires_approval?: boolean;
}

export interface PluginManifest {
  name: string;
  description: string;
  command?: string;
  args?: string[];
  type?: string;
  env_required?: string[];
  env_optional?: string[];
  env_file?: string;
  tools?: ToolManifest[];
  notes?: string[];
  api?: {
    base_url?: string;
    auth_header?: string;
    endpoints?: string[];
  };
}

export function loadManifests(): PluginManifest[] {
  const manifests: PluginManifest[] = [];

  try {
    const files = readdirSync(MANIFESTS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(resolve(MANIFESTS_DIR, file), "utf-8");
        const manifest: PluginManifest = JSON.parse(raw);
        manifests.push(manifest);
      } catch (err) {
        console.error(`[manifests] Failed to load ${file}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch {
    console.error(`[manifests] Manifests directory not found: ${MANIFESTS_DIR}`);
  }

  return manifests;
}

export function validateManifests(manifests: PluginManifest[]): void {
  for (const m of manifests) {
    const missing = (m.env_required ?? []).filter(key => !process.env[key]);
    if (missing.length > 0) {
      console.warn(`[manifests] ${m.name}: missing required env vars: ${missing.join(", ")}`);
    } else {
      console.log(`[manifests] ${m.name}: OK (${m.tools?.length ?? 0} tools)`);
    }
  }
}

/**
 * Generate system prompt context from manifests.
 * This tells the agent what tools exist, how to use them, and where to find things.
 */
export function generateToolContext(manifests: PluginManifest[]): string {
  const sections: string[] = [];

  sections.push("## Available Tool Servers\n");

  for (const m of manifests) {
    let section = `### ${m.name}\n${m.description}\n`;

    if (m.tools && m.tools.length > 0) {
      section += "\nTools:\n";
      for (const t of m.tools) {
        section += `- **${t.name}**${t.risk === "high" ? " [HIGH RISK]" : ""}: ${t.description}\n`;
        if (t.usage) {
          section += `  Usage: \`${t.usage}\`\n`;
        }
        if (t.requires_approval) {
          section += `  ⚠️ Requires user approval before use.\n`;
        }
      }
    }

    if (m.api) {
      section += `\nAPI: ${m.api.base_url ?? ""}\n`;
      if (m.api.endpoints) {
        for (const ep of m.api.endpoints) {
          section += `- ${ep}\n`;
        }
      }
    }

    if (m.notes && m.notes.length > 0) {
      section += "\nNotes:\n";
      for (const note of m.notes) {
        section += `- ${note}\n`;
      }
    }

    sections.push(section);
  }

  return sections.join("\n");
}
