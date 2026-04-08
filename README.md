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
- Claude Agent SDK 0.2.x (`@anthropic-ai/claude-agent-sdk`)
- Python 3 (for scripts in `~/.koda/scripts/`)
- ffmpeg, whisper, edge-tts (for voice channel support)
- pm2 (`npm install -g pm2`) for daemon mode

## Environment Variables

All API keys are loaded from `~/.koda/.env` automatically. The koda `.env` only needs:

```
DISCORD_BOT_TOKEN=              # Discord bot token
DISCORD_ALLOWED_CHANNELS=       # Comma-separated channel IDs for conversations
DISCORD_PROACTIVE_CHANNEL=      # Channel ID for agent-initiated messages (optional)
DISCORD_MENTION_ONLY=false      # Only respond when @mentioned
WEBHOOK_PORT=3847               # GitHub webhook listener port
WEBHOOK_SECRET=                 # GitHub webhook secret (optional)
TICK_INTERVAL_MS=900000         # Autonomous tick interval (recommended 15 min; set 0 to disable)
```

## Architecture

```
src/
├── index.ts           # Entry point — boots agent, bot, scheduler, webhooks, voice
│                        - Hot-reload file watcher (tasks.json, mcp-servers.json)
│                        - Incoming teleport check on startup
│                        - Memory freshness warnings on startup
├── cli.ts             # Terminal mode entry point
├── agent.ts           # Persistent streaming agent session
│                        - Session resume across restarts (preserves context)
│                        - YOLO risk classifier (LOW/MEDIUM/HIGH tool calls)
│                        - Coordinator subagents (researcher/implementer/verifier)
│                        - Context compaction (proactive every 50 turns)
│                        - Memory extraction after conversations
│                          · Cursor tracking (every 3 turns)
│                          · Coalescing (stash-and-trail pattern)
│                          · Mutual exclusion with main agent writes
│                        - Auto-recovery: compaction + resume, not session nuke
│                        - 30s progress summaries for long-running tasks
├── bot.ts             # Discord bot
│                        - Message → agent → reply
│                        - Image input (base64) and file output (attachments)
│                        - Thread support for long responses
│                        - Reaction-based approval flow (approve/reject)
│                        - Mention-only mode
│                        - Frustration detection (adapts tone)
│                        - User presence tracking (idle/active)
│                        - Proactive channel routing
│                        - Token budget syntax (+500k, use 2M tokens)
│                        - !teleport — context transfer to CLI
│                        - !status — agent health info
├── voice.ts           # Discord voice channel
│                        - !join / !leave commands
│                        - Speech-to-text (Whisper)
│                        - Text-to-speech (Edge TTS, Andrew voice)
│                        - Transcripts posted to text channel
├── scheduler.ts       # Cron task scheduler
│                        - 20 scheduled tasks (daily/3-day/weekly)
│                        - Self-healing (diagnose → fix → retry, max 2 attempts)
│                        - Circuit breaker (3 failures → 30min cooldown)
│                        - Missed task detection on startup (max 3, staggered)
│                        - Session registry (prevents duplicate execution)
│                        - Task result tracking (skip already-completed tasks)
│                        - Tick-based autonomous loop (every 5 min)
│                        - Outcome checker (every 6h)
│                        - Initiative review (every 2h)
│                        - Heartbeat (every 60s)
├── dream.ts           # LLM-driven memory consolidation (3:07 AM)
│                        - 4-phase: Orient → Gather → Consolidate → Prune
│                        - Forked as isolated task ($3 budget, 20 turns)
│                        - PID-based lock with stale detection
│                        - Tool-constrained (read-only bash, memory-dir writes)
├── patterns.ts        # Reusable reliability patterns
│                        - AsyncQueue — sequential execution for shared state
│                        - CircuitBreaker — stop after N consecutive failures
│                        - SessionRegistry — track active sessions, prevent dupes
├── teleport.ts        # Context transfer between CLI and Koda
│                        - Save: !teleport in Discord → ~/.koda/data/teleport.json
│                        - Load: CLI reads file, Koda checks on startup
├── runtime.ts         # Automatic runtime behaviors
│                        - Auto-observe task results
│                        - Auto-track outcomes after publishing
│                        - Memory freshness warnings
│                        - Observations capped at 500 lines
├── webhooks.ts        # GitHub webhook listener
│                        - PR opened → agent reviews
│                        - Issue opened → agent triages
│                        - Push to main → agent checks impact
├── config.ts          # Environment, system prompt, agent defaults
├── manifests.ts       # Plugin manifest loading (~/.koda/manifests/*.json)
├── skills.ts          # Skill loading (~/.koda/skills/*.md → system prompt)
└── tools/
    ├── gsc.ts         # Google Search Console MCP server
    └── agent-tools.ts # 6 autonomous agent tools
                         - observe() — record patterns/facts for dream cycle
                         - propose_task() — self-initiate work
                         - track_outcome() — schedule content performance checks
                         - ultraplan() — structured multi-phase planning
                         - check_health() — pm2 status, logs, error summary
                         - restart_self() — restart own pm2 process
```

## How It Works

### Persistent Session

Koda runs as a single persistent agent session using the Agent SDK's streaming input mode. Discord messages and GitHub webhooks feed into the same session, which maintains context across messages and survives restarts via session resume. Scheduled tasks and the tick loop run as **isolated** one-shot sessions with their own budget caps, so they don't bloat the persistent session's context.

```
Discord message ─┐
GitHub webhook ───┤──→ persistent agent session ──→ responses → Discord
Voice channel ────┘    (Opus, stays alive)

Scheduled task ──→ isolated session (Opus, fresh context, budget-capped)
Tick loop ───────→ isolated session (Sonnet, cheaper, silent)
```

### Autonomous Behavior

Every 15 minutes (configurable via `TICK_INTERVAL_MS`), the tick loop runs a silent lightweight check on Sonnet 4.6:
- Pending initiatives (self-proposed tasks)
- Goals falling behind (reads goals.md)
- Observations that need action
- Content outcomes to check

The tick is **silent by default** — no Discord output for normal operation. If the tick finds something, it calls `propose_task()` which routes through the existing approval flow. A circuit breaker surfaces only tick **failures** (after 3 consecutive) and recovery, so a broken tick loop doesn't stay silent, but a working one doesn't make noise.

When the user is **idle** (no Discord activity for 15 min), autonomy increases — low/medium priority tasks execute without approval. When **active**, the agent asks first.

### Memory System

```
Agent works → records observations → data/observations.md (capped at 500 lines)
                                          ↓
Dream cycle (3:07 AM, LLM-driven) ──→ Phase 1: Orient (read learnings, goals, soul)
                                     → Phase 2: Gather (grep observations, task results, logs)
                                     → Phase 3: Consolidate (merge into learnings.md)
                                     → Phase 4: Prune (TTL expiry, dedup, archive old)
                                          ↓
                                     ~/.koda/learnings.md (under 100 lines)

Background extraction (every 3 turns):
  Conversation → extractMemories agent → append to learnings.md
  - Cursor tracking, coalescing, mutual exclusion with main agent
  - Tool-constrained (read-only + learnings.md writes only)
```

### Reliability Patterns

- **Circuit breaker** — after 3 consecutive failures on the same task, stops retrying for 30 minutes
- **Sequential queue** — shared state file writes (task results, observations) go through FIFO queue
- **Session registry** — tracks active task sessions, prevents duplicate execution
- **Missed task recovery** — on startup, recovers up to 3 most recent missed tasks, staggered 1 minute apart
- **Auto-recovery** — on max_turns, compacts and resumes session (doesn't nuke context). On stream errors, tries resume before creating fresh session

### Self-Healing

When a scheduled task fails:
1. Error is captured and logged
2. Circuit breaker checks — if 3+ consecutive failures, stops for 30 minutes
3. Retries up to 2 times with exponential backoff (5min, 10min)
4. If all retries fail, a heal prompt is sent to the agent with the error output
5. Agent diagnoses, fixes scripts/configs, and retries
6. Max 2 heal attempts before escalating to Discord

The agent can also self-diagnose using built-in tools:
- `check_health` — pm2 status, restart count, uptime, recent errors from log
- `restart_self` — restart own pm2 process with a 2s delay for clean shutdown
- `self-heal` skill — step-by-step recipe: diagnose → identify failure type → fix → verify → report

### Skills

Skills are markdown files at `~/.koda/skills/*.md` loaded into the system prompt at startup. They give Koda step-by-step recipes for common workflows so it follows a known path instead of improvising.

Built-in skills:
- `delete-wordpress-post` — Notipo API flow to safely delete a post
- `publish-blog-post` — GSC keyword research → draft → user approval → Notipo CLI publish
- `brand-voice-social` — voice guide for X and Bluesky posts
- `self-heal` — diagnostic recipe for errors and crashes

To add a skill, create `~/.koda/skills/my-skill.md` with frontmatter:
```markdown
---
name: my-skill
description: What this skill does
when: When to use it
---
Step-by-step instructions...
```

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

All agent data lives in `~/.koda/`:

| Path | What |
|---|---|
| `config.json` | Agent configuration (model, owner, social accounts) |
| `tasks.json` | Scheduled task definitions (hot-reloaded on change) |
| `mcp-servers.json` | External MCP server definitions |
| `soul.md` | Agent personality and boundaries |
| `user.md` | User profile |
| `learnings.md` | Consolidated patterns (read at session start) |
| `goals.md` | Active objectives |
| `manifests/` | Plugin tool manifests (JSON, loaded into system prompt) |
| `skills/` | Workflow skill files (Markdown, loaded into system prompt) |
| `scripts/` | Helper scripts (dream-cycle.sh legacy fallback) |
| `data/observations.md` | Raw observations (capped at 500 lines) |
| `data/observations-archive.md` | Expired observations |
| `data/autonomous-logs/YYYY-MM-DD.log` | Daily task execution logs |
| `data/.task-results/YYYY-MM-DD.json` | Per-task success/failure tracking |
| `data/.agent-initiatives.json` | Self-proposed tasks |
| `data/outcomes/YYYY-MM-DD.json` | Content performance tracking |
| `data/plans/plan-*.json` | ULTRAPLAN execution plans |
| `data/sessions/` | Active session registry (prevents duplicates) |
| `data/teleport.json` | Context transfer between CLI and Koda |
| `data/.koda-session-id` | Session ID for resume |
| `data/.koda-heartbeat` | Health monitoring (PID + timestamp) |
| `data/.dream-lock` | Dream cycle lock (PID-based) |
| `logs/koda-out.log` | pm2 stdout log |
| `logs/koda-error.log` | pm2 stderr log |

Conversation history is stored automatically by the Agent SDK in `~/.claude/` as JSONL session files.

## Discord Commands

| Command | What |
|---|---|
| `@Koda <message>` | Talk to the agent (or any message in allowed channels) |
| `!status` | Show uptime, memory, PID |
| `!teleport [note]` | Save agent context to `~/.koda/data/teleport.json` for CLI pickup |
| `!join` / `!leave` | Voice channel |
| `+500k <message>` | Extended token budget hint (also: `+2M`, `use 1M tokens`) |
| React ✅/❌ | Approve or reject task proposals |

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
- Dream cycle (LLM-driven): 3:07 AM daily ($3 budget cap)
- Daily digest: 9 PM
- Auto-backup: 3:08 AM (rsync to ~/.koda/backups/)
- Outcome check: every 6 hours
- Initiative review: every 2 hours
- Tick loop: every 15 minutes (silent Sonnet isolated session, `TICK_INTERVAL_MS=0` to disable)
- Heartbeat: every 60 seconds
- Memory extraction: background, every 3 conversation turns

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
