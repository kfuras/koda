import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
  type ThreadChannel,
  AttachmentBuilder,
  ChannelType,
} from "discord.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DISCORD_BOT_TOKEN,
  DISCORD_ALLOWED_CHANNELS,
  DISCORD_MENTION_ONLY,
  DISCORD_PROACTIVE_CHANNEL,
  DISCORD_ALLOWED_USERS,
  RATE_LIMIT_MS,
  KODA_HOME,
} from "./config.js";
import { type KodaAgent } from "./agent.js";
import { teleportSave } from "./teleport.js";

const MAX_MESSAGE_LENGTH = 2000;
const THREAD_THRESHOLD = 2000; // Create thread if response exceeds this

// --- Token budget inline syntax ---
// Parses "+500k", "+2M", "use 1M tokens" from message start/end.
// Returns { cleanText, tokenBudget } where tokenBudget is the parsed number or undefined.

const TOKEN_BUDGET_PATTERN = /(?:^|\s)\+(\d+(?:\.\d+)?)\s*([kmb])\b/i;
const TOKEN_BUDGET_VERBOSE = /\buse\s+(\d+(?:\.\d+)?)\s*([kmb])\s*(?:tokens?)?\b/i;

function parseTokenBudget(text: string): { cleanText: string; tokenBudget: number | undefined } {
  const match = text.match(TOKEN_BUDGET_PATTERN) ?? text.match(TOKEN_BUDGET_VERBOSE);
  if (!match) return { cleanText: text, tokenBudget: undefined };

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1_000_000_000;
  const tokenBudget = Math.round(value * multiplier);

  // Strip the budget syntax from the message
  const cleanText = text.replace(match[0], "").trim();
  return { cleanText, tokenBudget };
}

// --- Frustration detection ---

const FRUSTRATION_PATTERNS = [
  /\bwtf\b/i, /\bwth\b/i, /\bomg\b/i,
  /\bbroken\b/i, /\bdoesn'?t work/i, /\bnot working/i,
  /\bstill broken/i, /\bstill not/i, /\bagain\?/i,
  /\bwhy (won'?t|can'?t|isn'?t|doesn'?t)/i,
  /\bthis (sucks|is terrible|is awful|is garbage)/i,
  /\bffs\b/i, /\bjfc\b/i, /\bugh\b/i,
  /\bseriously\?/i, /\bcome on\b/i,
  /\bi (said|told you|already)/i,
  /[!?]{3,}/, // Multiple !!! or ???
  /\b(stupid|useless|terrible|awful|horrible)\b/i,
];

function detectFrustration(text: string): boolean {
  return FRUSTRATION_PATTERNS.some((p) => p.test(text));
}

// --- Message chunking ---

function chunkMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// --- File detection in agent responses ---

const FILE_PATTERNS = [
  /generated-images\/[\w.-]+\.(png|jpg|jpeg|gif|webp)/g,
  /data\/drafts\/[\w.-]+/g,
];

function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  for (const pattern of FILE_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern));
    for (const match of matches) {
      const fullPath = resolve(KODA_HOME, match[0]);
      if (existsSync(fullPath)) {
        paths.push(fullPath);
      }
    }
  }
  return [...new Set(paths)];
}

// --- Image download from Discord ---

async function downloadAttachmentAsBase64(
  url: string,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "image/png";
    return {
      data: buffer.toString("base64"),
      mediaType: contentType,
    };
  } catch {
    return null;
  }
}

// --- Bot ---

export class KodaBot {
  private client: Client;
  private agent: KodaAgent;
  private approvalMessages = new Map<string, string>(); // messageId → taskName
  private lastUserActivity = 0; // timestamp of last user message
  private userIdleThresholdMs = 15 * 60_000; // 15 min = idle
  private lastMessageTime = new Map<string, number>(); // userId → timestamp (rate limiting)
  private startTime = Date.now();

  constructor(agent: KodaAgent) {
    this.agent = agent;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [2, 3], // Partials.Message = 2, Partials.Reaction = 3
    });

    this.setupHandlers();
  }

  isUserIdle(): boolean {
    return Date.now() - this.lastUserActivity > this.userIdleThresholdMs;
  }

  async start(): Promise<void> {
    await this.client.login(DISCORD_BOT_TOKEN);
  }

  async sendStartupMessage(reason?: string): Promise<void> {
    // Fall through the same channel hierarchy as sendProactive so that
    // startup messages reach wherever the operator expects announcements.
    // If nothing resolves, log loudly instead of silently returning —
    // silent failure is what hid this bug in the first place.
    const channelId =
      DISCORD_PROACTIVE_CHANNEL ||
      DISCORD_ALLOWED_CHANNELS.values().next().value;
    if (!channelId) {
      console.error(
        "[startup] No channel configured. Set DISCORD_PROACTIVE_CHANNEL or " +
        "DISCORD_ALLOWED_CHANNELS in ~/.koda/.env. Startup message NOT sent.",
      );
      return;
    }

    // Count skills from ~/.koda/skills/ for the status line
    let skillCount = 0;
    try {
      const { readdirSync, statSync, existsSync: exists } = await import("node:fs");
      const skillsDir = resolve(KODA_HOME, "skills");
      if (exists(skillsDir)) {
        const entries = readdirSync(skillsDir);
        for (const entry of entries) {
          const full = resolve(skillsDir, entry);
          const st = statSync(full);
          if (st.isFile() && entry.endsWith(".md")) {
            skillCount++;
          } else if (st.isDirectory() && exists(resolve(full, "SKILL.md"))) {
            skillCount++;
          }
        }
      }
    } catch {
      // Skill counting is best-effort — don't block the startup message on it
    }

    // Build the message
    const lines: string[] = [];
    lines.push("**Koda online.**");
    if (reason) {
      lines.push(`Reason: ${reason}`);
    }
    lines.push(`${skillCount} skills loaded. Ready for tasks.`);

    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel | null;
      if (channel) {
        await channel.send(lines.join("\n"));
      } else {
        console.error(
          `[startup] Channel ${channelId} not found or not text-based. ` +
          `Check DISCORD_PROACTIVE_CHANNEL / DISCORD_ALLOWED_CHANNELS.`,
        );
      }
    } catch (err) {
      console.error("[startup] Failed to send startup message:", err);
    }
  }

  async sendProactive(text: string, files?: string[]): Promise<void> {
    const channelId = DISCORD_PROACTIVE_CHANNEL || DISCORD_ALLOWED_CHANNELS.values().next().value;
    if (!channelId) return;

    const channel = await this.client.channels.fetch(channelId) as TextChannel | null;
    if (!channel) return;

    const attachments = await this.buildAttachments(files ?? []);
    const chunks = chunkMessage(text);

    for (let i = 0; i < chunks.length; i++) {
      await channel.send({
        content: chunks[i],
        files: i === 0 ? attachments : undefined,
      });
    }
  }

  async sendToChannel(text: string, files?: string[]): Promise<void> {
    const channelId = DISCORD_ALLOWED_CHANNELS.values().next().value;
    if (!channelId) return;

    const channel = await this.client.channels.fetch(channelId) as TextChannel | null;
    if (!channel) return;

    const attachments = await this.buildAttachments(files ?? []);
    const chunks = chunkMessage(text);

    for (let i = 0; i < chunks.length; i++) {
      await channel.send({
        content: chunks[i],
        files: i === 0 ? attachments : undefined,
      });
    }
  }

  async sendApproval(taskName: string, text: string): Promise<void> {
    const channelId = DISCORD_ALLOWED_CHANNELS.values().next().value;
    if (!channelId) return;

    const channel = await this.client.channels.fetch(channelId) as TextChannel | null;
    if (!channel) return;

    const content = `**[APPROVAL NEEDED]** ${taskName}\n\n${text}`;
    const chunks = chunkMessage(content);

    const firstMsg = await channel.send(chunks[0]);
    await firstMsg.react("✅");
    await firstMsg.react("❌");
    this.approvalMessages.set(firstMsg.id, taskName);

    for (let i = 1; i < chunks.length; i++) {
      await channel.send(chunks[i]);
    }
  }

  getClient(): Client {
    return this.client;
  }

  private async sendStatus(message: Message): Promise<void> {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const mem = process.memoryUsage();
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);

    const status = [
      "```",
      `Koda Agent Status`,
      `─────────────────`,
      `Uptime:    ${hours}h ${minutes}m`,
      `PID:       ${process.pid}`,
      `Memory:    ${heapMB} MB heap / ${rssMB} MB RSS`,
      `User idle: ${this.isUserIdle() ? "yes" : "no"}`,
      `Session:   persistent streaming`,
      `Node:      ${process.version}`,
      "```",
    ].join("\n");

    await message.reply({ content: status, allowedMentions: { repliedUser: false } });
  }

  private async sendTaskList(message: Message): Promise<void> {
    try {
      const tasksFile = resolve(KODA_HOME, "tasks.json");
      const raw = await readFile(tasksFile, "utf-8");
      const tasks = JSON.parse(raw) as Record<string, { cron: string; type: string; prompt: string }>;

      // Also load today's results to show status
      const today = new Date().toISOString().slice(0, 10);
      let results: Record<string, { status: string }> = {};
      try {
        const resultsFile = resolve(KODA_HOME, `data/.task-results/${today}.json`);
        results = JSON.parse(await readFile(resultsFile, "utf-8"));
      } catch { /* no results yet */ }

      const lines = Object.entries(tasks).map(([name, task]) => {
        const status = results[name]?.status;
        const icon = status === "ok" ? "✅" : status === "failed" ? "❌" : status === "healed" ? "🔧" : "⏳";
        return `${icon} ${name.padEnd(24)} ${task.cron.padEnd(18)} ${task.type}`;
      });

      const output = [
        "```",
        `Scheduled Tasks (${Object.keys(tasks).length}) — ${today}`,
        `─────────────────────────────────────────────────────`,
        `   Name                     Cron               Type`,
        ...lines,
        "```",
      ].join("\n");

      const chunks = chunkMessage(output);
      for (const chunk of chunks) {
        await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
      }
    } catch (err) {
      await message.reply({
        content: `Failed to load tasks: ${err instanceof Error ? err.message : String(err)}`,
        allowedMentions: { repliedUser: false },
      });
    }
  }

  private async handleTeleport(message: Message): Promise<void> {
    const summary = message.content.replace(/^!teleport\s*/i, "").trim() || "Current conversation context";

    // Ask the agent to summarize its current context
    this.agent.send(
      `[TELEPORT REQUEST] Summarize your current working context for transfer to Claude Code CLI. ` +
      `Include: what you're working on, key decisions made, files involved, and next steps. ` +
      `Be thorough but concise — this will be loaded into a fresh CLI session.\n` +
      `User note: ${summary}`,
      async (responseText) => {
        const path = await teleportSave(undefined, summary, responseText);
        await message.reply({
          content: `Context saved to \`${path}\`.\nIn Claude Code CLI, run: \`read ~/.koda/data/teleport.json\``,
          allowedMentions: { repliedUser: false },
        });
      },
    );
  }

  private setupHandlers(): void {
    this.client.once("ready", () => {
      console.log(`Discord bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on("messageCreate", (msg) => void this.handleMessage(msg));
    this.client.on("messageReactionAdd", (reaction, user) => {
      void this.handleReaction(reaction, user);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (
      DISCORD_ALLOWED_CHANNELS.size > 0 &&
      !DISCORD_ALLOWED_CHANNELS.has(message.channelId)
    ) {
      return;
    }

    // Allowed users check
    if (DISCORD_ALLOWED_USERS.size > 0 && !DISCORD_ALLOWED_USERS.has(message.author.id)) {
      return;
    }

    // Track user activity for focus awareness
    this.lastUserActivity = Date.now();

    // Handle ! commands
    const trimmed = message.content.trim().toLowerCase();
    if (trimmed === "!status") {
      await this.sendStatus(message);
      return;
    }
    if (trimmed === "!tasks") {
      await this.sendTaskList(message);
      return;
    }
    if (trimmed === "!teleport" || trimmed.startsWith("!teleport ")) {
      await this.handleTeleport(message);
      return;
    }
    if (trimmed.startsWith("!")) return; // other ! commands (voice, etc.)

    // Rate limiting
    const now = Date.now();
    const lastMsg = this.lastMessageTime.get(message.author.id) ?? 0;
    if (now - lastMsg < RATE_LIMIT_MS) {
      return; // silently ignore
    }
    this.lastMessageTime.set(message.author.id, now);

    let content = message.content.trim();

    // Mention-only mode: skip if not mentioned
    if (DISCORD_MENTION_ONLY && this.client.user) {
      const mentionPattern = new RegExp(`<@!?${this.client.user.id}>`);
      if (!mentionPattern.test(content)) return;
      // Strip the mention from the message
      content = content.replace(mentionPattern, "").trim();
    }

    if (!content && message.attachments.size === 0) return;

    // Show typing
    const channel = message.channel as TextChannel;
    const typing = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 5_000);
    await channel.sendTyping().catch(() => {});

    // Token budget parsing
    const { cleanText: budgetCleanText, tokenBudget } = parseTokenBudget(content);
    content = budgetCleanText;

    // Frustration detection
    const frustrated = detectFrustration(content);

    // Build message with username context
    const username = message.author.displayName || message.author.username;
    const promptParts: string[] = [];

    if (tokenBudget) {
      promptParts.push(
        `[SYSTEM: User requested extended token budget: ${tokenBudget.toLocaleString()} tokens. ` +
        `Take more time and be more thorough in your response. Do deep research if needed.]`,
      );
    }

    if (frustrated) {
      promptParts.push(
        "[SYSTEM: User seems frustrated. Acknowledge their frustration briefly. " +
        "Be extra careful and precise. Ask clarifying questions if unsure. " +
        "Don't be defensive — focus on solving the problem.]",
      );
    }

    if (content) {
      promptParts.push(`[${username}] ${content}`);
    }

    // Handle image attachments
    const imageContents: Array<{
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }> = [];

    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith("image/")) {
        const img = await downloadAttachmentAsBase64(attachment.url);
        if (img) {
          imageContents.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType,
              data: img.data,
            },
          });
        }
      }
    }

    // Send to agent
    if (imageContents.length > 0) {
      // Multi-modal message with images
      const messageContent: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
      > = [];

      if (promptParts.length > 0) {
        messageContent.push({ type: "text", text: promptParts.join("\n") });
      }
      messageContent.push(...imageContents);

      this.agent.sendRaw(
        {
          role: "user",
          content: messageContent,
        },
        async (responseText, isError) => {
          clearInterval(typing);
          await this.sendReply(message, responseText, isError);
        },
      );
    } else {
      this.agent.send(
        promptParts.join("\n"),
        async (responseText, isError) => {
          clearInterval(typing);
          await this.sendReply(message, responseText, isError);
        },
      );
    }
  }

  private async sendReply(
    message: Message,
    text: string,
    _isError: boolean,
  ): Promise<void> {
    const reply = text || "(no response)";

    // Extract file paths from response
    const filePaths = extractFilePaths(reply);
    const attachments = await this.buildAttachments(filePaths);

    // Short response: reply directly
    if (reply.length <= THREAD_THRESHOLD) {
      try {
        await message.reply({
          content: reply,
          files: attachments,
          allowedMentions: { repliedUser: false },
        });
      } catch (err) {
        console.error("Discord reply error:", err);
      }
      return;
    }

    // Long response: create thread
    try {
      const channel = message.channel as TextChannel;
      if (!channel.threads) throw new Error("Channel does not support threads");
      const thread = await channel.threads.create({
        name: `Koda — ${message.content.slice(0, 50)}`,
        type: ChannelType.PublicThread,
        startMessage: message,
      });

      const chunks = chunkMessage(reply);
      for (let i = 0; i < chunks.length; i++) {
        await thread.send({
          content: chunks[i],
          files: i === 0 ? attachments : undefined,
        });
      }
    } catch (err) {
      // Fallback: reply with chunks in channel
      console.error("Thread creation failed, falling back:", err);
      const chunks = chunkMessage(reply);
      for (const chunk of chunks) {
        await message.reply({
          content: chunk,
          allowedMentions: { repliedUser: false },
        }).catch(() => {});
      }
    }
  }

  private async handleReaction(
    reaction: { partial?: boolean; emoji: { name: string | null }; message: { partial?: boolean; id: string; content?: string | null; fetch: () => Promise<Message> } },
    user: { bot: boolean },
  ): Promise<void> {
    if (user.bot) return;

    // Fetch partial reaction/message if needed (for reactions on older messages)
    try {
      if (reaction.partial) await (reaction as unknown as { fetch: () => Promise<unknown> }).fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch {
      return;
    }

    const emoji = reaction.emoji.name;
    if (emoji !== "✅" && emoji !== "❌") return;

    // Check in-memory map first
    let taskName = this.approvalMessages.get(reaction.message.id);

    // If not in map (e.g., after restart), check message content for [APPROVAL NEEDED]
    if (!taskName) {
      const content = reaction.message.content ?? "";
      const match = content.match(/\*\*\[APPROVAL NEEDED\]\*\*\s*(\S+)/);
      if (match) {
        taskName = match[1];
      } else {
        return;
      }
    }

    this.approvalMessages.delete(reaction.message.id);

    if (emoji === "✅") {
      console.log(`[approval] ${taskName}: APPROVED`);
      this.agent.send(
        `[APPROVAL] Task "${taskName}" has been APPROVED by the user. Execute it now.`,
        async (responseText) => {
          await this.sendToChannel(responseText);
        },
      );
    } else {
      console.log(`[approval] ${taskName}: REJECTED`);
      this.agent.send(
        `[APPROVAL] Task "${taskName}" has been REJECTED by the user. Do not execute. Acknowledge briefly.`,
        async (responseText) => {
          await this.sendToChannel(responseText);
        },
      );
    }
  }

  private async buildAttachments(
    filePaths: string[],
  ): Promise<AttachmentBuilder[]> {
    const attachments: AttachmentBuilder[] = [];
    for (const fp of filePaths.slice(0, 5)) {
      try {
        const data = await readFile(fp);
        const name = fp.split("/").pop() ?? "file";
        attachments.push(new AttachmentBuilder(data, { name }));
      } catch {
        // File doesn't exist or can't be read — skip
      }
    }
    return attachments;
  }
}
