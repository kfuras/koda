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
  CONTENT_HUB_DIR,
} from "./config.js";
import { type KodaAgent } from "./agent.js";

const MAX_MESSAGE_LENGTH = 2000;
const THREAD_THRESHOLD = 2000; // Create thread if response exceeds this

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
      const fullPath = resolve(CONTENT_HUB_DIR, match[0]);
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
    });

    this.setupHandlers();
  }

  isUserIdle(): boolean {
    return Date.now() - this.lastUserActivity > this.userIdleThresholdMs;
  }

  async start(): Promise<void> {
    await this.client.login(DISCORD_BOT_TOKEN);
  }

  async sendStartupMessage(): Promise<void> {
    const channelId = DISCORD_ALLOWED_CHANNELS.values().next().value;
    if (!channelId) return;

    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel | null;
      if (channel) {
        await channel.send("Koda online. Ready for tasks.");
      }
    } catch (err) {
      console.error("Failed to send startup message:", err);
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

    // Track user activity for focus awareness
    this.lastUserActivity = Date.now();

    // Skip ! commands — handled by other listeners (voice, etc.)
    if (message.content.trim().startsWith("!")) return;

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

    // Frustration detection
    const frustrated = detectFrustration(content);

    // Build message with username context
    const username = message.author.displayName || message.author.username;
    const promptParts: string[] = [];

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
    reaction: { emoji: { name: string | null }; message: { id: string; fetch: () => Promise<Message> } },
    user: { bot: boolean },
  ): Promise<void> {
    if (user.bot) return;

    const taskName = this.approvalMessages.get(reaction.message.id);
    if (!taskName) return;

    const emoji = reaction.emoji.name;
    if (emoji !== "✅" && emoji !== "❌") return;

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
