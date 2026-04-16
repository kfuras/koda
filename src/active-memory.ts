/**
 * Active Memory — pre-reply memory search.
 *
 * From OpenClaw: a blocking search that runs BEFORE every interactive reply,
 * querying past memories for relevant context. Solves the "I forgot" problem.
 *
 * Searches learnings.md + observations.md + crossfeed/digest.md for keywords
 * from the incoming message. Returns matching lines as context to prepend.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KODA_HOME } from "./config.js";

// Common words to skip when extracting search terms
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "me", "my", "you", "your", "we", "our", "they", "them", "their",
  "it", "its", "this", "that", "these", "those", "what", "which", "who",
  "how", "when", "where", "why", "all", "each", "every", "both", "few",
  "more", "most", "some", "any", "no", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "above", "after", "again",
  "also", "and", "but", "for", "from", "get", "got", "here", "if", "in",
  "into", "of", "off", "on", "or", "out", "over", "then", "to", "up",
  "with", "check", "please", "can", "want", "make", "tell", "show",
  "give", "let", "look", "see", "know", "think", "help", "try",
]);

/** Extract meaningful search terms from a user message. */
function extractTerms(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 8); // cap at 8 terms to avoid over-searching
}

/** Search a file for lines matching any of the given terms. */
async function searchFile(filePath: string, terms: string[]): Promise<string[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const matches: string[] = [];

    for (const line of lines) {
      const lower = line.toLowerCase();
      // Skip headers, empty lines, and meta lines
      if (!line.trim() || line.startsWith("#") || line.startsWith(">")) continue;

      const hitCount = terms.filter((t) => lower.includes(t)).length;
      if (hitCount >= 1) {
        matches.push(line.trim());
      }
    }

    // Sort by relevance (more term hits = more relevant)
    return matches
      .sort((a, b) => {
        const aHits = terms.filter((t) => a.toLowerCase().includes(t)).length;
        const bHits = terms.filter((t) => b.toLowerCase().includes(t)).length;
        return bHits - aHits;
      })
      .slice(0, 5); // max 5 matches per file
  } catch {
    return [];
  }
}

/**
 * Search memory files for context relevant to the user's message.
 * Returns a formatted string to prepend to the prompt, or null if nothing found.
 *
 * Searches: learnings.md, observations.md, crossfeed/digest.md, shared/preferences.md
 */
export async function recallMemories(userMessage: string): Promise<string | null> {
  const terms = extractTerms(userMessage);
  if (terms.length === 0) return null;

  const files = [
    { path: resolve(KODA_HOME, "learnings.md"), label: "learnings" },
    { path: resolve(KODA_HOME, "data/observations.md"), label: "observations" },
    { path: resolve(KODA_HOME, "crossfeed/digest.md"), label: "crossfeed" },
  ];

  const allMatches: string[] = [];

  for (const { path, label } of files) {
    const matches = await searchFile(path, terms);
    for (const match of matches) {
      allMatches.push(`[${label}] ${match}`);
    }
  }

  if (allMatches.length === 0) return null;

  // Cap total context at ~800 chars to avoid bloating the prompt
  let context = "";
  for (const match of allMatches) {
    if (context.length + match.length > 800) break;
    context += match + "\n";
  }

  return `[RECALLED MEMORIES — relevant context from past observations and learnings]\n${context.trim()}\n[END RECALLED MEMORIES]`;
}
