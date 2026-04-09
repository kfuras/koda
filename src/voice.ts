import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  type VoiceChannel,
  type GuildMember,
  ChannelType,
  type Message,
  type TextChannel,
} from "discord.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type KodaAgent } from "./agent.js";
import { type KodaBot } from "./bot.js";
import { KODA_HOME } from "./config.js";
import { Transform } from "node:stream";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpusEncoder } = require("@discordjs/opus") as { OpusEncoder: new (rate: number, channels: number) => { decode: (buf: Buffer) => Buffer } };

const execFileAsync = promisify(execFile);
const TMP_DIR = resolve(KODA_HOME, "data/.voice-tmp");

// --- Opus to PCM decoder ---

class OpusDecodingStream extends Transform {
  private encoder: InstanceType<typeof OpusEncoder>;

  constructor() {
    super();
    this.encoder = new OpusEncoder(48000, 1);
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null, data?: Buffer) => void,
  ) {
    try {
      const decoded = this.encoder.decode(chunk);
      callback(null, decoded);
    } catch {
      callback();
    }
  }
}

// --- Speech-to-Text via Whisper CLI ---

async function transcribe(audioPath: string): Promise<string> {
  try {
    // Use OpenAI Whisper CLI (pip install openai-whisper)
    const { stdout } = await execFileAsync(
      "whisper",
      [audioPath, "--model", "base", "--output_format", "txt", "--output_dir", TMP_DIR, "--language", "en"],
      { timeout: 30_000 },
    );
    // Read the transcript file
    const txtPath = audioPath.replace(/\.\w+$/, ".txt");
    const text = await readFile(txtPath, "utf-8").catch(() => stdout);
    await unlink(txtPath).catch(() => {});
    return text.trim();
  } catch (err) {
    console.error("[voice] Transcription failed:", err);
    return "";
  }
}

// --- Text-to-Speech via Edge TTS ---

async function synthesize(text: string, outputPath: string): Promise<void> {
  await execFileAsync(
    "edge-tts",
    ["--voice", "en-US-AndrewNeural", "--text", text, "--write-media", outputPath],
    { timeout: 30_000 },
  );
}

// --- Voice handler ---

let activeConnection: VoiceConnection | null = null;

export function setupVoiceCommands(bot: KodaBot, agent: KodaAgent): void {
  const client = bot.getClient();

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;
    const content = message.content.toLowerCase().trim();

    if (content === "!join" || content === "!voice") {
      const member = message.member as GuildMember | null;
      const voiceChannel = member?.voice.channel;

      if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        await message.reply("Join a voice channel first, then type `!join`.");
        return;
      }

      try {
        await joinAndListen(voiceChannel as VoiceChannel, agent, bot, message.channel as TextChannel);
        await message.reply(`Joined **${voiceChannel.name}**. Listening...`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[voice] Failed to join:", msg);
        await message.reply(`Failed to join voice: ${msg.slice(0, 200)}`);
      }
    }

    if (content === "!leave") {
      if (activeConnection) {
        activeConnection.destroy();
        activeConnection = null;
        await message.reply("Left voice channel.");
      }
    }
  });
}

async function joinAndListen(
  channel: VoiceChannel,
  agent: KodaAgent,
  bot: KodaBot,
  textChannel: TextChannel,
): Promise<void> {
  await mkdir(TMP_DIR, { recursive: true });

  // Leave existing connection
  if (activeConnection) {
    activeConnection.destroy();
  }

  console.log(`[voice] Attempting to join ${channel.name} (${channel.id}) in guild ${channel.guild.id}`);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  activeConnection = connection;

  connection.on("stateChange", (oldState, newState) => {
    console.log(`[voice] Connection: ${oldState.status} → ${newState.status}`);
  });

  connection.on("error", (err) => {
    console.error("[voice] Connection error:", err.message);
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  console.log(`[voice] Joined ${channel.name}`);

  const player = createAudioPlayer();
  connection.subscribe(player);

  // Listen for users speaking
  const receiver = connection.receiver;

  receiver.speaking.on("start", (userId: string) => {
    // Record audio from this user
    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1500, // 1.5s silence = end of speech
      },
    });

    const chunks: Buffer[] = [];
    const decoder = new OpusDecodingStream();

    audioStream.pipe(decoder);

    decoder.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    decoder.on("end", () => {
      void handleSpeech(chunks, userId, agent, player, connection, textChannel);
    });
  });
}

async function handleSpeech(
  chunks: Buffer[],
  userId: string,
  agent: KodaAgent,
  player: ReturnType<typeof createAudioPlayer>,
  connection: VoiceConnection,
  textChannel: TextChannel,
): Promise<void> {
  if (chunks.length === 0) return;

  const pcmData = Buffer.concat(chunks);

  // Skip very short audio (< 0.5s at 48kHz 16-bit mono)
  if (pcmData.length < 48000) return;

  const audioPath = resolve(TMP_DIR, `${Date.now()}-${userId}.pcm`);
  const wavPath = audioPath.replace(".pcm", ".wav");
  const responsePath = resolve(TMP_DIR, `${Date.now()}-response.mp3`);

  try {
    // Save PCM and convert to WAV for Whisper
    await writeFile(audioPath, pcmData);
    await execFileAsync("ffmpeg", [
      "-y", "-f", "s16le", "-ar", "48000", "-ac", "1",
      "-i", audioPath, wavPath,
    ], { timeout: 10_000 });

    // Transcribe
    const text = await transcribe(wavPath);
    if (!text || text.length < 2) {
      await cleanup(audioPath, wavPath);
      return;
    }

    console.log(`[voice] Heard: "${text}"`);

    // Send to agent
    agent.send(`[VOICE from user ${userId}] ${text}`, async (responseText) => {
      console.log(`[voice] Response: "${responseText.slice(0, 100)}"`);

      // Also post to text channel for reference
      await textChannel.send(`**Voice:** ${text}\n**Koda:** ${responseText.slice(0, 1900)}`).catch(() => {});

      try {
        // Synthesize response
        await synthesize(responseText.slice(0, 500), responsePath);

        // Play in voice channel
        const resource = createAudioResource(responsePath);
        player.play(resource);

        await entersState(player, AudioPlayerStatus.Idle, 60_000).catch(() => {});
      } catch (err) {
        console.error("[voice] TTS failed:", err);
      }

      await cleanup(audioPath, wavPath, responsePath);
    });
  } catch (err) {
    console.error("[voice] Processing failed:", err);
    await cleanup(audioPath, wavPath, responsePath);
  }
}

async function cleanup(...paths: string[]): Promise<void> {
  for (const p of paths) {
    await unlink(p).catch(() => {});
  }
}
