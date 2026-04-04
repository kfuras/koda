import cron from "node-cron";
import { writeFile, mkdir } from "node:fs/promises";
import { type KodaAgent } from "./agent.js";
import { type KodaBot } from "./bot.js";
import { CONTENT_HUB_DIR } from "./config.js";

// --- Types ---

interface TaskDef {
  prompt: string;
  cron: string;
  type: "silent" | "approval";
  timeout?: number;
}

// --- Task definitions ---
// Cron format: minute hour day-of-month month day-of-week
// Daily tasks staggered across the morning (07:00-09:30 Norway time)

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
      "Parse the JSON output. If there are new members, churned members, upgrades, or dowgrades, " +
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
      "node /Users/YOUR_USERNAME/code/content-hub/scripts/x-feed-scanner.js --limit 30 --json. " +
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
      "For each, draft a tactical quote tweet in Kjetil's voice (read data/brand-voice-skill.md): " +
      "- Use numbered lists (1-5 steps), not bullet dashes " +
      "- Lead with a bold claim, then tactical breakdown " +
      "- Every claim must be verifiable against our actual codebase — NO hallucinations " +
      "- End with a punchy one-liner " +
      "Save drafts to data/drafts/quote-tweet-drafts-{date}.md. " +
      "Report the top 3 drafts with original tweet URLs for approval. " +
      "DO NOT post without approval.",
    cron: "0 9 * * *",
    type: "approval",
    timeout: 600,
  },
  cta_replies: {
    prompt:
      "CTA REPLIES: Run: python3 scripts/cta_reply.py --min-likes 10 --dry-run. " +
      "This checks your recent tweets for any that got traction (10+ likes). " +
      "For qualifying tweets, it drafts CTA replies linking to Build & Automate " +
      "(https://go.kjetilfuras.com/build-automate-x) or Notipo (https://notipo.com). " +
      "The CTA should bridge the tweet topic to the product — not 'follow for more'. " +
      "Report drafts for approval. " +
      "If approved, run: python3 scripts/cta_reply.py --min-likes 10 --post",
    cron: "30 9 * * *",
    type: "approval",
  },

  // --- Every 3 days ---
  content_proposal: {
    prompt:
      "CONTENT PROPOSAL: Read GOALS.md to identify the biggest gap. Read LEARNINGS.md for " +
      "what content performs best. Search X/web for trending topics in your niche. " +
      "Also run: python3 scripts/trending_topics.py --save to scan YouTube for trending topics. " +
      "Use the trending data to inform your proposals — pick topics with proven view velocity. " +
      "Draft 2-3 content ideas (Short, social post, or Skool lesson) that move the needle " +
      "on the weakest goal. Report proposals with trending data backing each idea. " +
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
      "image for approval. DO NOT post without explicit approval.",
    cron: "0 11 2,5,8,11,14,17,20,23,26,29 * *",
    type: "approval",
  },
  skool_post: {
    prompt:
      "SKOOL COMMUNITY POST: Draft a community post for Build & Automate (skool.com/build-automate). " +
      "Topic should be based on recent work — what you built, what you learned, behind-the-scenes " +
      "of the daemon/pipeline. Match Kjetil's practitioner voice. Use the generate_image tool " +
      "(ALWAYS include an image). Report the draft + image for approval. " +
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

// --- Scheduler ---

export function startScheduler(agent: KodaAgent, bot: KodaBot): void {
  console.log(`Scheduling ${Object.keys(TASKS).length} tasks`);

  for (const [name, task] of Object.entries(TASKS)) {
    cron.schedule(task.cron, () => {
      void executeTask(name, task, agent, bot);
    }, {
      timezone: "Europe/Oslo",
    });
    console.log(`  ${name}: ${task.cron}`);
  }
}

async function executeTask(
  name: string,
  task: TaskDef,
  agent: KodaAgent,
  bot: KodaBot,
): Promise<void> {
  const date = today();
  console.log(`[${date}] Running task: ${name}`);

  const fullPrompt =
    `[SCHEDULED TASK: ${name}] ${task.prompt}\n\nToday's date: ${date}`;

  agent.send(fullPrompt, async (responseText, isError) => {
    await logToFile(name, `${isError ? "ERROR" : "OK"} — ${responseText.slice(0, 200)}`);

    if (task.type === "approval") {
      await bot.sendApproval(name, responseText);
    } else if (responseText.length > 10) {
      await bot.sendToChannel(`**[${name}]**\n\n${responseText}`);
    }
  });
}
