import cron from "node-cron";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type KodaAgent } from "./agent.js";
import { type KodaBot } from "./bot.js";
import { CONTENT_HUB_DIR, TICK_INTERVAL_MS, DAILY_BUDGET_USD } from "./config.js";

const execFileAsync = promisify(execFile);

// --- Types ---

interface TaskDef {
  prompt: string;
  cron: string;
  type: "silent" | "approval";
  timeout?: number;
  /** Chain: run this task after successful completion, passing output as context */
  chain?: string;
}

interface TaskResult {
  status: "ok" | "failed" | "healed" | "exhausted";
  error?: string;
  timestamp: string;
}

const MAX_HEAL_ATTEMPTS = 2;
const RESULTS_DIR = `${CONTENT_HUB_DIR}/data/.task-results`;

// --- Daily cost tracking ---

let dailyCostUsd = 0;
let dailyCostDate = today();

export function getDailyCost(): { cost: number; date: string; budget: number } {
  return { cost: dailyCostUsd, date: dailyCostDate, budget: DAILY_BUDGET_USD };
}

function trackCost(cost: number): boolean {
  const now = today();
  if (now !== dailyCostDate) {
    dailyCostUsd = 0;
    dailyCostDate = now;
  }
  dailyCostUsd += cost;
  if (dailyCostUsd > DAILY_BUDGET_USD) {
    console.log(`[budget] Daily budget exceeded: $${dailyCostUsd.toFixed(2)} > $${DAILY_BUDGET_USD}`);
    return false; // over budget
  }
  return true; // within budget
}

// --- Task definitions ---

const TASKS: Record<string, TaskDef> = {
  // --- Daily ---
  youtube_analytics: {
    prompt:
      "Pull YouTube 7-day analytics (views, subs, watch time, likes). " +
      "Save snapshot to data/analytics/{date}.json. " +
      "If anything notable (milestone, big change), report it.",
    cron: "0 7 * * *",
    type: "silent",
  },
  gsc_analytics: {
    prompt:
      "Pull Google Search Console analytics for the last 7 days. " +
      "Use gsc_search_analytics for both sc-domain:notipo.com and https://kjetilfuras.com/. " +
      "Check top queries (clicks, impressions, CTR, position). " +
      "Log to data/analytics/{date}.json alongside other analytics. " +
      "Record observations about trending queries or ranking changes. " +
      "If any page dropped significantly in position or a new query appeared in top 10, report it. " +
      "SEO CONTENT OPPORTUNITIES: If you spot a query with high impressions but low CTR, " +
      "or a new query trending upward, or a keyword gap (no existing page ranking for a relevant query), " +
      "append a blog post idea to data/drafts/blog-content-ideas.md with: " +
      "the query, current metrics, and a suggested blog post title + angle. " +
      "These ideas should target kjetilfuras.com (automation/AI practitioner content).",
    cron: "45 8 * * *",
    type: "silent",
  },
  instagram_analytics: {
    prompt:
      "Pull Instagram analytics for @kjetilfuras. " +
      "Use the instagram_analytics tool with save=true. " +
      "Log follower count + top performing recent posts to data/autonomous-logs/{date}.log. " +
      "If any Reel got notable engagement (>50 plays or >5 likes), report it.",
    cron: "15 7 * * *",
    type: "silent",
  },
  bluesky_stats: {
    prompt:
      "BLUESKY + TRENDS: First call the Bluesky login MCP tool. Then pull recent posts " +
      "(handle: kjetilfuras.bsky.social) using the get-posts MCP tool. " +
      "Check likes, reposts, reply counts. Log stats to data/analytics/{date}.json alongside YouTube data. " +
      "If any post did notably well or poorly, report it. " +
      "Then check the Bluesky timeline (get-timeline, limit 20) for trending AI/automation/Claude topics. " +
      "Log findings to data/autonomous-logs/{date}.log. Only report if highly relevant. " +
      "IMPORTANT: If you get a rate limit error from Bluesky, skip it gracefully and log 'Bluesky rate limited' — do not retry.",
    cron: "30 7 * * *",
    type: "silent",
  },
  learnings_review: {
    prompt:
      "Read the last 3 daily logs and check if LEARNINGS.md needs updating. " +
      "Keep it under 100 lines.",
    cron: "45 7 * * *",
    type: "silent",
  },
  skool_member_sync: {
    prompt:
      "SKOOL MEMBER SYNC: Use the skool_airtable_sync tool. " +
      "Parse the JSON output. If there are new members, churned members, upgrades, or downgrades, " +
      "report a summary. If no changes, log silently to data/autonomous-logs/{date}.log. " +
      "If the tool fails (e.g. Skool login issue, Airtable error), report the error.",
    cron: "0 8 * * *",
    type: "silent",
  },
  goal_check: {
    prompt:
      "GOAL CHECK: Read GOALS.md. Check current YouTube sub count and recent view counts. " +
      "Identify which goal has the biggest gap. Log the assessment to data/autonomous-logs/{date}.log. " +
      "If a goal is significantly behind, include a brief note about what action could help " +
      "(but don't take action without approval).",
    cron: "15 8 * * *",
    type: "silent",
  },
  x_feed_scan: {
    prompt:
      "X FEED SCAN: Run the X feed scanner script: " +
      "node scripts/x-feed-scanner.js --limit 30 --json. " +
      "Read the results and create a digest with the top 3-5 most interesting posts " +
      "(highest engagement + most relevant to Build & Automate or Notipo). " +
      "Include: author, topic, engagement numbers, and one sentence on what we can learn from it. " +
      "If cookies expire, try: node scripts/export-x-cookies.js to re-export, then retry. " +
      "If Chrome has no valid X session, report that the user needs to log into x.com in Chrome.",
    cron: "30 8 * * *",
    type: "silent",
    timeout: 600,
  },
  viral_tweet_scan: {
    prompt:
      "VIRAL TWEET SCAN: Use the scan_viral_tweets tool with min_likes=100. " +
      "Pick the top 3-5 tweets with highest engagement. " +
      "IMPORTANT: Read data/brand-voice-skill.md FIRST — especially the 'How Kjetil Should Adapt This' section. " +
      "For each, draft a tactical quote tweet. CRITICAL RULES: " +
      "- NEVER write 'I built this' or talk about yourself — reframe for the READER as a business opportunity " +
      "- Use openers like 'the play:', 'the business hiding in this:', 'the move nobody will make:' " +
      "- Use numbered lists (3-5 steps), each step ONE line, actionable and specific " +
      "- Include dollar amounts ('$2K each', '$300/mo recurring') " +
      "- End with a punchy closer ('you're welcome.', 'stop overthinking it.') " +
      "- Every claim must be verifiable — NO hallucinations " +
      "For each draft, use search_reaction_clip to find a matching reaction clip. " +
      "Match the energy of the text: hype text = hype/celebration clip, tactical text = someone working intensely, " +
      "mind-blowing fact = mind blown clip. Search with a mood keyword, not the topic itself. " +
      "Save drafts to data/drafts/quote-tweet-drafts-{date}.md (include the clip path for each). " +
      "Pick the best draft and post it to X. Post to Bluesky too with the same text. " +
      "Report what you posted to #koda-proactive.",
    cron: "0 9 * * *",
    type: "silent",
    timeout: 600,
  },
  cta_replies: {
    prompt:
      "CTA REPLIES: Run: python3 scripts/cta_reply.py --min-likes 10 --dry-run. " +
      "This checks your recent tweets for any that got traction (10+ likes). " +
      "For qualifying tweets, it drafts CTA replies linking to Build & Automate " +
      "(https://go.kjetilfuras.com/build-automate-x) or Notipo (https://notipo.com). " +
      "The CTA should bridge the tweet topic to the product — not 'follow for more'. " +
      "Post the CTA replies directly: python3 scripts/cta_reply.py --min-likes 10 --post. " +
      "Report what you posted to #koda-proactive.",
    cron: "30 9 * * *",
    type: "silent",
  },

  // --- Every 3 days ---
  content_proposal: {
    prompt:
      "CONTENT PROPOSAL: Read GOALS.md to identify the biggest gap. Read LEARNINGS.md for " +
      "what content performs best. Search X/web for trending topics in your niche. " +
      "Also run: python3 scripts/trending_topics.py --save to scan YouTube for trending topics. " +
      "Also read data/drafts/blog-content-ideas.md for SEO-driven blog post ideas from GSC data. " +
      "Use the trending data to inform your proposals — pick topics with proven view velocity. " +
      "Draft 2-3 content ideas across these types: " +
      "- YouTube Short (growth) " +
      "- X/Bluesky social post (engagement) " +
      "- Skool lesson (community value) " +
      "- Blog post for kjetilfuras.com (SEO — target specific queries from GSC data) " +
      "IMPORTANT for blog posts: content must be UNIQUE from Skool posts. " +
      "Skool = behind-the-scenes how-I-built-it for members. " +
      "Blog = SEO-optimized tutorials and guides targeting search queries for public audience. " +
      "Same topic is OK but different angle and depth. " +
      "Report proposals with trending/GSC data backing each idea. " +
      "DO NOT create or publish anything without approval.",
    cron: "0 10 1,4,7,10,13,16,19,22,25,28 * *",
    type: "approval",
  },
  social_post: {
    prompt:
      "SOCIAL POST DRAFT: Read GOALS.md and LEARNINGS.md. Pick a product to promote " +
      "(rotate: Notipo, Build & Automate, daemon/Claude Code). Use a different angle than " +
      "last time (check data/drafts/ for recent posts). Draft the post matching Kjetil's voice " +
      "(see voice-reference.md). Use the generate_image tool if relevant. Report the draft + " +
      "image. Post to X and Bluesky. Report what you posted to #koda-proactive.",
    cron: "0 11 2,5,8,11,14,17,20,23,26,29 * *",
    type: "silent",
  },
  skool_post: {
    prompt:
      "SKOOL COMMUNITY POST: Draft a community post for Build & Automate (skool.com/build-automate). " +
      "Step 1: Read data/drafts/skool-content-calendar.md — pick the NEXT unposted topic. " +
      "Step 2: Check git log in ~/code/koda and ~/code/content-hub for real code related to that topic. " +
      "Step 3: Write a tactical post with real code snippets, actual commands, and concrete results. " +
      "Quality over quantity — show, don't tell. Match Kjetil's practitioner voice. " +
      "Use the generate_image tool (ALWAYS include an image — screenshots of real output preferred). " +
      "Step 4: After drafting, mark the topic as DONE in skool-content-calendar.md. " +
      "Step 5: Check if the backlog is getting thin (under 3 items). If so, scan git commits " +
      "for features/fixes NOT already covered by a DONE topic or existing backlog item, " +
      "and add 2-3 new topic ideas to the backlog section. " +
      "Report the draft + image for approval. " +
      "Label: General discussion. DO NOT post without explicit approval.",
    cron: "0 11 3,6,9,12,15,18,21,24,27,30 * *",
    type: "approval",
  },
  x_article: {
    prompt:
      "X ARTICLE: Write a new X Article. Process: " +
      "1. Read data/brand-voice-skill.md and LEARNINGS.md " +
      "2. Research trending: python3 scripts/research_topics.py 'ai agents automation' " +
      "3. Pick a topic showcasing what Kjetil built (daemon, video pipeline, quote tweets, etc.) " +
      "4. Write 700-1000 word tactical article in Kjetil's voice (Corey Ganim format): " +
      "   Hook intro, 5-8 numbered sections with headings, code blocks (real code), " +
      "   CTA to Build & Automate (https://go.kjetilfuras.com/build-automate-x) " +
      "5. Generate 7 headline options " +
      "6. Generate thumbnail: python3 scripts/generate_article_thumbnail.py --title 'TITLE' --output generated-images/article-thumbnail.png " +
      "7. Save to data/drafts/article-{date}-SLUG.md " +
      "8. Report headline options + article preview for approval " +
      "EVERY CLAIM must be verifiable against actual code. NO hallucinations.",
    cron: "0 10 3,6,9,12,15,18,21,24,27,30 * *",
    type: "approval",
    timeout: 900,
  },

  // --- Weekly ---
  weekly_report: {
    prompt:
      "WEEKLY REPORT: Compile YouTube stats (7-day views, subs, top videos, traffic sources). " +
      "Pull X post stats using get_my_tweets MCP tool (weekly only — X API burns credits). " +
      "Pull Bluesky post stats. Check Skool for fresh content this week. " +
      "Format as a summary (code blocks for stats, bold for highlights). Report it.",
    cron: "0 10 * * 1",
    type: "silent",
  },
  meta_token_check: {
    prompt:
      "META TOKEN CHECK: Run: python3 scripts/refresh_meta_token.py --check " +
      "If it exits with code 1 (token expiring soon), run without --check to refresh. " +
      "Log result to data/autonomous-logs/{date}.log. " +
      "If refresh fails, report that the Meta token needs manual renewal.",
    cron: "0 8 * * 0",
    type: "silent",
  },
  voice_profile_refresh: {
    prompt:
      "VOICE PROFILE REFRESH: Check if new blog posts exist on kjetilfuras.com that aren't in " +
      "data/voice-profile.json (compare blog_posts_analyzed list). Also pull latest X posts " +
      "(get_my_tweets, 5 most recent) and compare against real_examples in the profile. " +
      "If there are new posts to analyze, fetch and read them, then update data/voice-profile.json. " +
      "Keep existing structure — only add/update, don't remove working patterns. " +
      "Log what changed to data/autonomous-logs/{date}.log.",
    cron: "0 9 * * 6",
    type: "silent",
  },
  brand_voice_learn: {
    prompt:
      "BRAND VOICE LEARNING: Analyze what's working and update the brand voice file. " +
      "Step 1: Pull your last 20 X posts using get_my_tweets (count=20). " +
      "Step 2: Rank them by engagement (likes + retweets + bookmarks). " +
      "Step 3: For the top 5, identify the FORMAT patterns — opener style, numbered vs prose, " +
      "dollar amounts yes/no, closer style, self-focused vs reader-focused. " +
      "Step 4: For the bottom 5, identify what's different about the format. " +
      "Step 5: Also scan 10 viral tweets (scan_viral_tweets min_likes=500) and note " +
      "which FORMAT patterns the highest-engagement ones use. " +
      "Step 6: Read data/brand-voice-skill.md. Update ONLY the 'Rules Summary' and examples " +
      "if the data shows a clear pattern we're missing or a rule that's wrong. " +
      "DO NOT change rules that are already working. Only ADD new insights or REFINE existing ones. " +
      "Step 7: Report what you found and what you changed (or didn't change) to #koda-proactive.",
    cron: "0 11 * * 1",
    type: "silent",
    timeout: 600,
  },
  conversation_memory: {
    prompt:
      "CONVERSATION MEMORY: Extract and persist key decisions from recent conversations. " +
      "Step 1: Read data/autonomous-logs/{date}.log and the last few task results. " +
      "Step 2: Identify key DECISIONS, PREFERENCES, and FACTS learned today that would be " +
      "useful in future sessions (e.g., 'user prefers X over Y', 'tool Z needs config A'). " +
      "Step 3: Read LEARNINGS.md. Only add items that are NOT already there. " +
      "Step 4: If there are new learnings, append them to the appropriate section in LEARNINGS.md. " +
      "Step 5: If LEARNINGS.md is over 100 lines, consolidate older entries. " +
      "Keep it concise. Only save things that help future sessions — not task logs.",
    cron: "0 20 * * *",
    type: "silent",
    timeout: 300,
  },
  lesson_draft: {
    prompt:
      "SKOOL LESSON DRAFT: Draft a classroom lesson for Build & Automate based on what was " +
      "built this week. Write in ProseMirror format (see Skool skill). Include code blocks, " +
      "step-by-step instructions, and practical examples. Save draft to data/drafts/. " +
      "Report outline for approval before pushing to Skool. Set level 1 access. " +
      "DO NOT push without explicit approval.",
    cron: "0 11 * * 5",
    type: "approval",
  },
};

// --- Task result tracking ---

async function loadResults(date: string): Promise<Record<string, TaskResult>> {
  await mkdir(RESULTS_DIR, { recursive: true });
  try {
    const data = await readFile(`${RESULTS_DIR}/${date}.json`, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveResult(
  date: string,
  taskId: string,
  result: TaskResult,
): Promise<void> {
  const results = await loadResults(date);
  results[taskId] = result;
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    `${RESULTS_DIR}/${date}.json`,
    JSON.stringify(results, null, 2),
  );
}

// --- Helpers ---

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function logToFile(taskName: string, text: string): Promise<void> {
  const dir = `${CONTENT_HUB_DIR}/data/autonomous-logs`;
  await mkdir(dir, { recursive: true });
  const line = `[${new Date().toISOString()}] [${taskName}] ${text}\n`;
  await writeFile(`${dir}/${today()}.log`, line, { flag: "a" });
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

// --- Self-healing ---

const HEAL_PROMPT = `You are the self-healing agent. A scheduled task just failed.
Your job is to diagnose the root cause, fix the broken script/config, and re-run the task.
You have full bash and MCP tool access.
Read the relevant source files to understand what went wrong.
Make minimal, targeted fixes — don't rewrite entire scripts.
Log what you fixed to data/daily-logs/{date}.md.
After fixing files, commit your changes to git with a descriptive message (prefix with 'fix:').
If you can't fix it autonomously (needs human action like logging into a website),
explain exactly what the user needs to do.`;

async function selfHeal(
  taskName: string,
  task: TaskDef,
  errorText: string,
  agent: KodaAgent,
  bot: KodaBot,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    console.log(`[${taskName}] Self-heal attempt ${attempt}/${MAX_HEAL_ATTEMPTS}`);

    const healPrompt =
      `${HEAL_PROMPT}\n\n` +
      `FAILED TASK: ${taskName}\n` +
      `TASK DESCRIPTION: ${task.prompt}\n\n` +
      `ERROR OUTPUT (last 2000 chars):\n\`\`\`\n${errorText.slice(-2000)}\n\`\`\`\n\n` +
      `INSTRUCTIONS:\n` +
      `1. Read the error and diagnose the root cause\n` +
      `2. Read the relevant source files\n` +
      `3. Fix the issue\n` +
      `4. Re-run the original task to verify\n` +
      `5. If you can't fix it, explain what the user needs to do\n\n` +
      `Today's date: ${today()}`;

    const healed = await new Promise<boolean>((resolve) => {
      agent.send(healPrompt, async (responseText, isError) => {
        if (!isError && !responseText.toLowerCase().includes("could not fix")) {
          await saveResult(today(), taskName, {
            status: "healed",
            timestamp: timestamp(),
          });
          await logToFile(taskName, `HEALED on attempt ${attempt}`);
          console.log(`[${taskName}] Self-healed on attempt ${attempt}`);
          resolve(true);
        } else {
          errorText = responseText;
          resolve(false);
        }
      });
    });

    if (healed) return true;
  }

  // All attempts exhausted
  await saveResult(today(), taskName, {
    status: "exhausted",
    error: errorText.slice(0, 2000),
    timestamp: timestamp(),
  });
  await logToFile(taskName, `EXHAUSTED after ${MAX_HEAL_ATTEMPTS} heal attempts`);
  await bot.sendToChannel(
    `**[HEAL FAILED]** ${taskName}\n\n` +
    `Self-healing failed after ${MAX_HEAL_ATTEMPTS} attempts.\n` +
    `Last error: ${errorText.slice(0, 1500)}`,
  );
  return false;
}

// --- Outcome checker ---

async function checkOutcomes(agent: KodaAgent): Promise<void> {
  const dir = `${CONTENT_HUB_DIR}/data/outcomes`;
  const now = new Date();

  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir).catch(() => [] as string[]);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const data = JSON.parse(await readFile(`${dir}/${file}`, "utf-8"));
      const unchecked = data.filter(
        (o: { checked: boolean; check_at: string }) =>
          !o.checked && new Date(o.check_at) <= now,
      );

      if (unchecked.length === 0) continue;

      for (const outcome of unchecked) {
        console.log(`[outcomes] Checking: ${outcome.content_type} — ${outcome.description}`);
        agent.send(
          `[OUTCOME CHECK] Check performance of this ${outcome.content_type} posted on ${outcome.posted_at}:\n` +
          `Description: ${outcome.description}\n` +
          `ID/URL: ${outcome.content_id}\n\n` +
          `Pull the current metrics (likes, views, engagement). Compare to typical performance.\n` +
          `Record your findings using the observe() tool.\n` +
          `If it performed unusually well or poorly, note WHY you think that happened.`,
          async () => {
            outcome.checked = true;
          },
        );
      }

      await writeFile(`${dir}/${file}`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error("[outcomes] Check failed:", err);
  }
}

// --- Initiative review ---

async function reviewInitiatives(agent: KodaAgent, bot: KodaBot): Promise<void> {
  const file = `${CONTENT_HUB_DIR}/data/.agent-initiatives.json`;
  try {
    const data = JSON.parse(await readFile(file, "utf-8"));
    const pending = data.filter((i: { status: string; priority: string }) =>
      i.status === "pending" && (i.priority === "medium" || i.priority === "high"),
    );

    for (const initiative of pending) {
      await bot.sendApproval(
        `initiative:${initiative.id}`,
        `**Self-initiated task (${initiative.priority}):**\n${initiative.description}\n\n**Reason:** ${initiative.reason}`,
      );
    }
  } catch {
    // No initiatives file yet
  }
}

// --- Heartbeat ---

const HEARTBEAT_FILE = `${CONTENT_HUB_DIR}/data/.koda-heartbeat`;

function startHeartbeat(): NodeJS.Timeout {
  const beat = async () => {
    try {
      await writeFile(
        HEARTBEAT_FILE,
        `${Date.now()}\n${process.pid}\nkoda-agent\n`,
      );
    } catch {
      // Silently ignore
    }
  };
  void beat();
  return setInterval(() => void beat(), 60_000);
}

// --- Tick-based autonomous loop ---

function startTickLoop(agent: KodaAgent, bot: KodaBot): NodeJS.Timeout {
  const tick = () => {
    const userIdle = bot.isUserIdle();
    const date = today();
    const hour = new Date().getHours();

    // Only tick during waking hours (7 AM - 11 PM Norway time)
    if (hour < 7 || hour > 23) return;

    const tickPrompt =
      `[TICK] Quick check-in. User is ${userIdle ? "IDLE/OFFLINE" : "ACTIVE"}.` +
      ` Date: ${date}, time: ${new Date().toTimeString().slice(0, 5)}.` +
      `\n\nThis is a LIGHTWEIGHT check. Do NOT execute tasks. Do NOT read files unless critical.` +
      `\n\nQuickly assess from memory:` +
      `\n1. Any approved initiatives you haven't started yet?` +
      `\n2. Anything urgent that needs immediate attention?` +
      `\n\nIf something needs doing, use propose_task() to queue it — do NOT do it now.` +
      `\nIf nothing needs attention, respond with just "tick ok".` +
      `\nKeep this under 3 tool calls.`;

    agent.send(tickPrompt, async (responseText) => {
      // Only send to proactive channel if the agent actually did something
      if (responseText && !responseText.toLowerCase().includes("tick ok")) {
        await bot.sendProactive(`**[tick]** ${responseText}`);
      }
    });
  };

  if (TICK_INTERVAL_MS <= 0) {
    console.log("  tick_loop: DISABLED (TICK_INTERVAL_MS=0)");
    return undefined as unknown as ReturnType<typeof setInterval>;
  }
  return setInterval(tick, TICK_INTERVAL_MS);
}

// --- Dream cycle ---

async function runDreamCycle(bot: KodaBot): Promise<void> {
  console.log("[dream] Starting dream cycle...");

  try {
    const { stdout, stderr } = await execFileAsync(
      "/bin/bash",
      [`${CONTENT_HUB_DIR}/scripts/dream-cycle.sh`],
      {
        cwd: CONTENT_HUB_DIR,
        timeout: 60_000,
      },
    );

    const output = stdout || stderr || "No output";
    console.log(`[dream] ${output}`);
    await logToFile("dream_cycle", output);

    // Only notify Discord if something was promoted or archived
    if (output.includes("Promoted") || output.includes("Archived")) {
      await bot.sendToChannel(`**[dream_cycle]**\n\n${output}`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[dream] Failed:", errorMsg);
    await logToFile("dream_cycle", `FAILED: ${errorMsg}`);
  }
}

// --- Daily digest ---

async function sendDailyDigest(agent: KodaAgent, bot: KodaBot): Promise<void> {
  const date = today();
  console.log(`[digest] Generating daily digest for ${date}`);

  agent.send(
    `[DAILY DIGEST] Summarize what you did today (${date}). Check:\n` +
    `- data/autonomous-logs/${date}.log for task results\n` +
    `- data/.task-results/${date}.json for success/failure counts\n` +
    `- data/observations.md for observations recorded today\n` +
    `- data/.agent-initiatives.json for proposed tasks\n\n` +
    `Today's API spend: $${dailyCostUsd.toFixed(2)} / $${DAILY_BUDGET_USD} daily budget.\n\n` +
    `Format as a concise evening report. Include: tasks completed, tasks failed, ` +
    `observations recorded, content drafted, API spend, and anything that needs attention tomorrow.\n` +
    `Keep it under 1500 characters.`,
    async (responseText) => {
      await bot.sendProactive(`**[Daily Digest — ${date}]**\n\n${responseText}`);
    },
  );
}

// --- Auto-backup ---

async function autoBackup(): Promise<void> {
  console.log("[backup] Auto-committing agent data...");

  try {
    // Stage observation/learnings/task data (ignore missing paths)
    await execFileAsync("git", [
      "add", "--ignore-errors",
      "data/observations.md",
      "data/observations-archive.md",
      "data/LEARNINGS.md",
      "data/.task-results/",
      "data/outcomes/",
      "data/autonomous-logs/",
      "data/daily-logs/",
      "data/plans/",
    ], { cwd: CONTENT_HUB_DIR }).catch(() => {});

    // Check if there's anything to commit
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: CONTENT_HUB_DIR,
    });

    if (!status.trim()) {
      console.log("[backup] Nothing to commit");
      return;
    }

    await execFileAsync("git", [
      "commit", "-m", `ci: auto-backup agent data ${today()}`,
    ], { cwd: CONTENT_HUB_DIR });

    console.log("[backup] Committed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[backup] Failed:", msg);
  }
}

// --- Scheduler ---

export function startScheduler(agent: KodaAgent, bot: KodaBot): void {
  console.log(`Scheduling ${Object.keys(TASKS).length} tasks + dream cycle`);

  for (const [name, task] of Object.entries(TASKS)) {
    cron.schedule(task.cron, () => {
      void executeTask(name, task, agent, bot);
    }, {
      timezone: "Europe/Oslo",
    });
    console.log(`  ${name}: ${task.cron}`);
  }

  // Daily digest — 21:00 every evening
  cron.schedule("0 21 * * *", () => {
    void sendDailyDigest(agent, bot);
  }, {
    timezone: "Europe/Oslo",
  });
  console.log(`  daily_digest: 0 21 * * *`);

  // Dream cycle — 3:07 AM daily (matching old daemon)
  cron.schedule("7 3 * * *", () => {
    void runDreamCycle(bot);
    // Auto-backup after dream cycle consolidation
    setTimeout(() => void autoBackup(), 60_000);
  }, {
    timezone: "Europe/Oslo",
  });
  console.log(`  dream_cycle + auto_backup: 7 3 * * *`);

  // Outcome checks — every 6 hours
  cron.schedule("0 */6 * * *", () => {
    void checkOutcomes(agent);
  }, {
    timezone: "Europe/Oslo",
  });
  console.log(`  outcome_check: 0 */6 * * *`);

  // Initiative review — send pending initiatives to Discord every 2 hours
  cron.schedule("0 */2 * * *", () => {
    void reviewInitiatives(agent, bot);
  }, {
    timezone: "Europe/Oslo",
  });
  console.log(`  initiative_review: 0 */2 * * *`);

  // Heartbeat — every 60 seconds
  startHeartbeat();
  console.log(`  heartbeat: every 60s`);

  // Tick-based autonomous loop
  startTickLoop(agent, bot);
  console.log(`  tick_loop: every ${TICK_INTERVAL_MS / 1000}s`);
}

const MAX_TASK_RETRIES = 2;
const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

async function executeTask(
  name: string,
  task: TaskDef,
  agent: KodaAgent,
  bot: KodaBot,
  retryCount = 0,
): Promise<void> {
  const date = today();

  // Skip if already succeeded today
  const results = await loadResults(date);
  if (results[name]?.status === "ok" || results[name]?.status === "healed") {
    console.log(`[${date}] Skipping ${name} — already completed today`);
    return;
  }

  // Check daily budget
  if (!trackCost(0)) {
    console.log(`[${date}] Skipping ${name} — daily budget exceeded ($${dailyCostUsd.toFixed(2)})`);
    await logToFile(name, `SKIPPED — daily budget exceeded ($${dailyCostUsd.toFixed(2)}/$${DAILY_BUDGET_USD})`);
    return;
  }

  console.log(`[${date}] Running task: ${name} (isolated, attempt ${retryCount + 1}/${MAX_TASK_RETRIES + 1})`);

  const fullPrompt =
    `[SCHEDULED TASK: ${name}] ${task.prompt}\n\nToday's date: ${date}`;

  // Run in isolated session — separate context, per-task turn/budget limits
  const result = await agent.runIsolatedTask(name, fullPrompt);

  // Track cost
  trackCost(result.cost);

  if (!result.isError) {
    // Success
    await saveResult(date, name, { status: "ok", timestamp: timestamp() });
    await logToFile(name, `OK ($${result.cost.toFixed(2)}, ${result.turns}t) — ${result.text.slice(0, 200)}`);

    if (task.type === "approval") {
      await bot.sendApproval(name, result.text);
    } else if (result.text.length > 10) {
      await bot.sendToChannel(`**[${name}]**\n\n${result.text}`);
    }

    // Chain: run next task with output as context
    if (task.chain && TASKS[task.chain]) {
      const nextTask = TASKS[task.chain];
      const chainPrompt = `${nextTask.prompt}\n\n[CONTEXT FROM ${name}]:\n${result.text.slice(0, 3000)}`;
      console.log(`[chain] ${name} → ${task.chain}`);
      await logToFile(name, `CHAIN → ${task.chain}`);
      void executeTask(task.chain, { ...nextTask, prompt: chainPrompt }, agent, bot);
    }
  } else {
    // Failed
    await saveResult(date, name, {
      status: "failed",
      error: result.text.slice(0, 2000),
      timestamp: timestamp(),
    });
    await logToFile(name, `FAILED ($${result.cost.toFixed(2)}, ${result.turns}t) — ${result.text.slice(0, 200)}`);

    // Retry with backoff
    if (retryCount < MAX_TASK_RETRIES) {
      const delayMs = RETRY_DELAY_MS * (retryCount + 1); // 5min, 10min
      console.log(`[${name}] Retrying in ${delayMs / 60000} minutes...`);
      await logToFile(name, `RETRY scheduled in ${delayMs / 60000}min`);
      setTimeout(() => {
        void executeTask(name, task, agent, bot, retryCount + 1);
      }, delayMs);
    } else {
      // All retries exhausted — try self-heal as last resort
      console.log(`[${name}] All retries exhausted, attempting self-heal...`);
      await selfHeal(name, task, result.text, agent, bot);
    }
  }
}
