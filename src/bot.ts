import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from "discord.js";
import { DISCORD_BOT_TOKEN, DISCORD_ALLOWED_CHANNELS } from "./config.js";
import { runAgent } from "./agent.js";

const MAX_MESSAGE_LENGTH = 2000;

function chunkMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      // No good newline — split at space
      splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      // No good space — hard split
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export function createBot(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("ready", () => {
    console.log(`Discord bot logged in as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message: Message) => {
    // Ignore bots and messages outside allowed channels
    if (message.author.bot) return;
    if (
      DISCORD_ALLOWED_CHANNELS.size > 0 &&
      !DISCORD_ALLOWED_CHANNELS.has(message.channelId)
    ) {
      return;
    }

    const content = message.content.trim();
    if (!content) return;

    // Show typing while agent works
    const channel = message.channel as TextChannel;
    const typing = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 5_000);
    await channel.sendTyping().catch(() => {});

    try {
      const result = await runAgent(content);
      clearInterval(typing);

      const reply = result.text || "(no response)";
      const chunks = chunkMessage(reply);

      for (const chunk of chunks) {
        await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
      }
    } catch (err) {
      clearInterval(typing);
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Agent error:", errorMsg);
      await message
        .reply({ content: `Agent error: ${errorMsg.slice(0, 1900)}`, allowedMentions: { repliedUser: false } })
        .catch(() => {});
    }
  });

  return client;
}

export async function startBot(): Promise<Client> {
  const client = createBot();
  await client.login(DISCORD_BOT_TOKEN);
  return client;
}
