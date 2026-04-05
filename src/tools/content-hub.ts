import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SCRIPTS_DIR, CONTENT_HUB_DIR } from "../config.js";

const execFileAsync = promisify(execFile);

const PYTHON = "python3";

async function run(
  script: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(PYTHON, [`${SCRIPTS_DIR}/${script}`, ...args], {
    cwd: CONTENT_HUB_DIR,
    timeout: 600_000,
    env: { ...process.env },
  });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string, retryable: boolean) {
  return {
    content: [{ type: "text" as const, text: `ERROR (retryable=${retryable}): ${text}` }],
    isError: true,
  };
}

async function runSafe(
  script: string,
  args: string[] = [],
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const { stdout } = await run(script, args);
    return textResult(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Classify retryability
    const retryable = !msg.includes("No such file") &&
      !msg.includes("invalid argument") &&
      !msg.includes("permission denied");
    return errorResult(msg, retryable);
  }
}

// --- Tools ---

const postTweet = tool(
  "post_tweet",
  "Post a tweet to X. Returns the tweet URL. Follow brand-voice-skill.md format.",
  { text: z.string().max(25000), image_path: z.string().optional() },
  async ({ text, image_path }) => {
    const args = [text];
    if (image_path) args.push(image_path);
    const { stdout } = await run("post_x.py", args);
    return textResult(stdout);
  },
);

const publishVideo = tool(
  "publish_video",
  "Publish a video to YouTube/Instagram via Discord approval flow. NEVER call without user approval.",
  {
    video_path: z.string(),
    title: z.string(),
    description: z.string(),
    platforms: z.string().default("youtube,instagram"),
    skip_approval: z.boolean().default(false),
  },
  async ({ video_path, title, description, platforms, skip_approval }) => {
    const args = [video_path, "--title", title, "--description", description, "--platforms", platforms];
    if (skip_approval) args.push("--skip-approval");
    const { stdout } = await run("publish.py", args);
    return textResult(stdout);
  },
);

const generateImage = tool(
  "generate_image",
  "Generate an image using Google Gemini from a text prompt. Returns the saved file path.",
  {
    prompt: z.string(),
    output_path: z.string().optional(),
  },
  async ({ prompt, output_path }) => {
    const args = [prompt];
    if (output_path) args.push(output_path);
    const { stdout } = await run("generate_image.py", args);
    return textResult(stdout);
  },
);

const instagramAnalytics = tool(
  "instagram_analytics",
  "Pull Instagram analytics. Returns follower count, engagement, top posts.",
  {
    save: z.boolean().default(true),
    json: z.boolean().default(true),
    limit: z.number().default(10),
  },
  async ({ save, json, limit }) => {
    const args: string[] = [];
    if (save) args.push("--save");
    if (json) args.push("--json");
    args.push("--limit", String(limit));
    const { stdout } = await run("instagram_analytics.py", args);
    return textResult(stdout);
  },
);

const quoteTweet = tool(
  "quote_tweet",
  "Post a quote tweet via browser automation. Follow brand-voice-skill.md format.",
  {
    url: z.string().url(),
    text: z.string().max(25000),
    dry_run: z.boolean().default(false),
  },
  async ({ url, text, dry_run }) => {
    const args = ["--url", url, "--text", text];
    if (dry_run) args.push("--dry-run");
    const { stdout } = await run("quote_tweet_web.py", args);
    return textResult(stdout);
  },
);

const scanViralTweets = tool(
  "scan_viral_tweets",
  "Scan X for viral tweets in the AI/automation space. Returns top tweets with engagement metrics.",
  {
    query: z.string().optional(),
    min_likes: z.number().default(100),
    min_bookmarks: z.number().default(0),
    limit: z.number().default(10),
  },
  async ({ query, min_likes, min_bookmarks, limit }) => {
    const args: string[] = [];
    if (query) args.push("--query", query);
    args.push("--min-likes", String(min_likes));
    args.push("--min-bookmarks", String(min_bookmarks));
    args.push("--limit", String(limit));
    const { stdout } = await run("scan_viral_tweets.py", args);
    return textResult(stdout);
  },
);

const searchReactionClip = tool(
  "search_reaction_clip",
  "Search YouTube for a short reaction clip (MP4) to attach to a quote tweet. Pass a mood/energy like 'mind blown', 'coach hype', 'celebration'. Downloads HD MP4 clipped to 7-12 seconds. Returns the file path ready for post_tweet.",
  {
    query: z.string().describe("Mood or energy to search for, e.g. 'mind blown reaction', 'coach hype celebration', 'someone working intensely'"),
    limit: z.number().default(5),
    download: z.boolean().default(true).describe("Download the top result as MP4"),
    download_index: z.number().default(0).describe("Which result to download (0-based)"),
    max_duration: z.number().default(12).describe("Max clip duration in seconds"),
  },
  async ({ query, limit, download, download_index, max_duration }) => {
    const args = [query, "--limit", String(limit), "--max-duration", String(max_duration)];
    if (download) {
      args.push("--download", "--download-index", String(download_index));
    }
    return runSafe("search_reaction_clip.py", args);
  },
);

const skoolAirtableSync = tool(
  "skool_airtable_sync",
  "Sync Skool members to Airtable. Returns JSON with new/churned/upgraded members.",
  {
    dry_run: z.boolean().default(false),
    export_only: z.boolean().default(false),
  },
  async ({ dry_run, export_only }) => {
    const args: string[] = [];
    if (dry_run) args.push("--dry-run");
    if (export_only) args.push("--export");
    const { stdout } = await execFileAsync(PYTHON, [
      process.env.SKOOL_SYNC_PATH ?? "skool-airtable-sync.py",
      ...args,
    ], {
      cwd: CONTENT_HUB_DIR,
      timeout: 300_000,
      env: { ...process.env },
    });
    return textResult(stdout);
  },
);

// --- MCP Server ---

export const contentHubServer = createSdkMcpServer({
  name: "content-hub",
  version: "0.1.0",
  tools: [
    postTweet,
    publishVideo,
    generateImage,
    instagramAnalytics,
    quoteTweet,
    scanViralTweets,
    searchReactionClip,
    skoolAirtableSync,
  ],
});
