# Koda Agent

Autonomous marketing and operations agent built on Anthropic's Claude Agent SDK. Replaces the old `claude-daemon.py` with a proper autonomous loop: gather context, think, act, observe, repeat.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and fill in your env vars
cp .env.example .env

# Development (foreground, stops when terminal closes)
npm run dev

# CLI mode (terminal conversation, works over SSH)
npm run cli

# Production daemon (background, survives reboots)
npm run daemon
```

## Requirements

- Node.js 18+
- Claude CLI logged in (Max subscription — no API key needed)
- Python 3 (for content-hub scripts)
- ffmpeg, whisper, edge-tts (for voice channel support)
- pm2 (`npm install -g pm2`) for daemon mode

## Environment Variables

All API keys are loaded from `~/code/content-hub/.env` automatically. The koda `.env` only needs:

```
DISCORD_BOT_TOKEN=              # Discord bot token
DISCORD_ALLOWED_CHANNELS=       # Comma-separated channel IDs for conversations
DISCORD_PROACTIVE_CHANNEL=      # Channel ID for agent-initiated messages (optional)
DISCORD_MENTION_ONLY=false      # Only respond when @mentioned
WEBHOOK_PORT=3847               # GitHub webhook listener port
WEBHOOK_SECRET=                 # GitHub webhook secret (optional)
TICK_INTERVAL_MS=300000         # Autonomous tick interval (default 5 min)
```

## Architecture

```
src/
├── index.ts           # Entry point — boots agent, bot, scheduler, webhooks, voice
├── cli.ts             # Terminal mode entry point
├── agent.ts           # Persistent streaming agent session
│                        - Session resume across restarts
│                        - YOLO risk classifier (LOW/MEDIUM/HIGH tool calls)
│                        - Coordinator subagents (researcher/implementer/verifier)
│                        - Context compaction detection
├── bot.ts             # Discord bot
│                        - Message → agent → reply
│                        - Image input (base64) and file output (attachments)
│                        - Thread support for long responses
│                        - Reaction-based approval flow (approve/reject)
│                        - Mention-only mode
│                        - Frustration detection (adapts tone)
│                        - User presence tracking (idle/active)
│                        - Proactive channel routing
├── voice.ts           # Discord voice channel
│                        - !join / !leave commands
│                        - Speech-to-text (Whisper)
│                        - Text-to-speech (Edge TTS, Andrew voice)
│                        - Transcripts posted to text channel
├── scheduler.ts       # Cron task scheduler
│                        - 17 scheduled tasks (daily/3-day/weekly)
│                        - Self-healing (diagnose → fix → retry, max 2 attempts)
│                        - Task result tracking (skip already-completed tasks)
│                        - Dream cycle (3:07 AM memory consolidation)
│                        - Tick-based autonomous loop (every 5 min)
│                        - Outcome checker (every 6h)
│                        - Initiative review (every 2h)
│                        - Heartbeat (every 60s)
├── webhooks.ts        # GitHub webhook listener
│                        - PR opened → agent reviews
│                        - Issue opened → agent triages
│                        - Push to main → agent checks impact
├── config.ts          # Environment, system prompt, agent defaults
└── tools/
    ├── content-hub.ts # 7 typed MCP tools wrapping Python scripts
    │                    - post_tweet, publish_video, generate_image
    │                    - instagram_analytics, quote_tweet
    │                    - scan_viral_tweets, skool_airtable_sync
    └── agent-tools.ts # 4 autonomous agent tools
                         - observe() — record patterns/facts for dream cycle
                         - propose_task() — self-initiate work
                         - track_outcome() — schedule content performance checks
                         - ultraplan() — structured multi-phase planning
```

## How It Works

### Persistent Session

Koda runs as a single persistent agent session using the Agent SDK's streaming input mode. Discord messages, scheduled tasks, and the tick loop all feed into the same session. The agent maintains context across messages and survives restarts via session resume.

```
Discord message ─┐
Scheduled task ───┤──→ persistent agent session ──→ responses → Discord
Tick loop ────────┤    (stays alive)
GitHub webhook ───┘
Voice channel ────┘
```

### Autonomous Behavior

Every 5 minutes, the tick loop evaluates:
- Pending initiatives (self-proposed tasks)
- Goals falling behind (reads GOALS.md)
- Observations that need action
- Content outcomes to check

When the user is **idle** (no Discord activity for 15 min), autonomy increases — low/medium priority tasks execute without approval. When **active**, the agent asks first.

### Memory System

```
Agent works → records observations → data/observations.md
                                          ↓
Dream cycle (3:07 AM) → consolidate → promote patterns → data/LEARNINGS.md
                       → expire old     → prune to 100 lines
                       → deduplicate    → resolve contradictions
                       → archive        → data/observations-archive.md
```

### Self-Healing

When a scheduled task fails:
1. Error is captured and logged
2. A heal prompt is sent to the agent with the error output
3. Agent diagnoses, fixes scripts/configs, and retries
4. Max 2 heal attempts before escalating to Discord

### ULTRAPLAN

For complex multi-step tasks, the agent creates a structured plan:
1. Agent calls `ultraplan()` with phases, risks, and success criteria
2. Plan is saved to `data/plans/` and sent to Discord
3. User approves or rejects via reactions
4. On approval, agent executes phases using coordinator subagents

### Coordinator Mode

Three subagents for parallel work:
- **researcher** (Sonnet) — gathers info, scans trends, reads docs
- **implementer** (Opus) — writes code, edits files, runs scripts
- **verifier** (Sonnet) — checks work, runs tests, validates output

## Data Locations

All data lives in `~/code/content-hub/data/`:

| Path | What |
|---|---|
| `observations.md` | Raw observations recorded by the agent |
| `observations-archive.md` | Expired observations |
| `LEARNINGS.md` | Consolidated patterns (read at session start) |
| `autonomous-logs/YYYY-MM-DD.log` | Daily task execution logs |
| `daily-logs/YYYY-MM-DD.md` | Daily activity summaries |
| `.task-results/YYYY-MM-DD.json` | Per-task success/failure tracking |
| `.agent-initiatives.json` | Self-proposed tasks |
| `outcomes/YYYY-MM-DD.json` | Content performance tracking |
| `plans/plan-*.json` | ULTRAPLAN execution plans |
| `drafts/` | Content drafts (tweets, articles, posts) |
| `analytics/` | YouTube/Instagram/Bluesky snapshots |
| `.koda-session-id` | Session ID for resume |
| `.koda-heartbeat` | Health monitoring (PID + timestamp) |
| `logs/koda-out.log` | pm2 stdout log |
| `logs/koda-error.log` | pm2 stderr log |

Conversation history is stored automatically by the Agent SDK in `~/.claude/` as JSONL session files.

## Scheduled Tasks

### Daily (07:00-09:30, Europe/Oslo)
- YouTube analytics, Instagram analytics, Bluesky stats
- Learnings review, Skool member sync, goal check
- X feed scan, viral tweet scan, CTA replies

### Every 3 Days
- Content proposal, social post draft, Skool post, X article

### Weekly
- Weekly report (Mon), lesson draft (Fri), voice profile refresh (Sat), Meta token check (Sun)

### System
- Dream cycle: 3:07 AM daily
- Outcome check: every 6 hours
- Initiative review: every 2 hours
- Tick loop: every 5 minutes
- Heartbeat: every 60 seconds

## Commands

### Discord
- Regular messages → agent responds
- `!join` — bot joins your voice channel
- `!leave` — bot leaves voice channel
- React with approve/reject on approval messages

### Terminal
```bash
npm run dev              # Development mode (foreground)
npm run cli              # CLI conversation mode
npm run daemon           # Start as background daemon
npm run daemon:stop      # Stop daemon
npm run daemon:restart   # Restart daemon
npm run daemon:logs      # Tail daemon logs
npm run daemon:status    # Check daemon status
```

## GitHub Webhooks

To receive repo events, configure a webhook in your GitHub repo:
1. Settings → Webhooks → Add webhook
2. Payload URL: `http://your-ip:3847/webhook/github`
3. Content type: `application/json`
4. Secret: match your `WEBHOOK_SECRET` env var
5. Events: Pull requests, Issues, Pushes

## Production Setup

```bash
# Install pm2 globally
npm install -g pm2

# Start Koda as daemon
npm run daemon

# Save process list for auto-restart
pm2 save

# Enable startup on boot (run the command it outputs with sudo)
pm2 startup
```
