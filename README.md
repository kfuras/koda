# Koda — Personal AI Assistant

[![npm](https://img.shields.io/npm/v/koda-agent)](https://www.npmjs.com/package/koda-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.x-blueviolet)](https://docs.anthropic.com/en/docs/agents)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)

**Koda** is a personal AI assistant you run on your own machine. It drafts content, posts to X, scans for viral tweets, pulls SEO analytics, writes blog posts, manages your Skool community, and reports everything back to Discord — all on a cron schedule, 24/7, while you sleep.

It runs on the Claude Agent SDK with a Pro/Max subscription. No API costs. No cloud hosting. One laptop.

```
20 scheduled tasks · 13 MCP servers · 18 skills · 6-layer memory system
Discord control plane · Self-healing · Nightly dream cycle
```

[Getting Started](#install) · [Architecture](#architecture) · [CLI Commands](#cli-commands) · [Skills](#skills) · [MCP Servers](#mcp-servers) · [Memory System](#memory-system) · [Discord Commands](#discord-commands) · [AGENTS.md](AGENTS.md)

---

## Install

### npm (recommended)

```bash
npm install -g koda-agent
koda init
```

That's it. You now have a global `koda` command and `~/.koda/` with all config, skills, and MCP servers ready to customize.

### From source

If you prefer to work from the repo:

```bash
git clone https://github.com/kfuras/koda.git
cd koda
npm install && npm run build && npm link
koda init
```

### curl installer (alternative)

```bash
cd ~/code   # or wherever you want the repo
curl -fsSL https://raw.githubusercontent.com/kfuras/koda/main/install.sh | bash
```

Installs prerequisites (Node, pm2, git), clones, builds, links, and runs `koda doctor`.

### What the install script does

Before running `curl | bash`, read what the script will do to your system. The full source is at [`install.sh`](install.sh) — audit it before piping to bash if you want.

The script will:

1. **Detect your OS** (macOS or Linux; fails on Windows)
2. **Install missing prerequisites** (see the next section for the exact commands)
3. **Clone `kfuras/koda`** to `$PWD/koda` (or pull if already cloned)
4. **Run `npm install`**
5. **Run `npm run build`** (compiles TypeScript to `dist/`)
6. **Run `npm link`** (creates a global `koda` binary)
7. **Run `koda doctor`** to validate the install
8. **Restart the Koda daemon** if it was already running via pm2

The script will **NOT**:

- Modify your shell rc files (`.zshrc`, `.bashrc`, etc.)
- Run `sudo` on macOS
- Touch `~/.koda/` (your config and state stay untouched on install or reinstall)
- Install to `/usr/local/bin` directly (uses `npm link` which respects your npm prefix)

### Prerequisites the script will install if missing

**macOS** (via Homebrew):
```bash
# Homebrew itself (if missing)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js 22 (if node missing or <18)
brew install node@22 && brew link --force --overwrite node@22

# Git (if missing)
brew install git

# pm2 (if missing)
npm install -g pm2
```

**Linux** (via package manager):
```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y nodejs npm git
sudo npm install -g pm2

# Fedora/RHEL
sudo dnf install -y nodejs npm git
sudo npm install -g pm2
```

### Install flags

```bash
./install.sh --dry-run        # show what would happen, make no changes
./install.sh --skip-prereqs   # assume tools are already installed
./install.sh --no-onboard     # skip `koda doctor` (for CI/automation)
./install.sh --help           # show full help
```

### Manual install (no script)

If you'd rather not run a shell script from the internet:

```bash
# 1. Install prerequisites yourself (Node 18+, git, pm2)
brew install node@22 git
npm install -g pm2

# 2. Clone to wherever you want
git clone https://github.com/kfuras/koda.git ~/your/chosen/path
cd ~/your/chosen/path

# 3. Build and link
npm install
npm run build
npm link

# 4. Verify
koda --version
koda doctor
```

### What gets created where

```
<wherever-you-cloned>/koda/    ← code repo (you choose this path)
  ├── src/                     ← TypeScript source
  ├── dist/                    ← compiled output
  │   └── koda.js              ← CLI entry point (symlinked by npm link)
  ├── install.sh               ← the installer
  └── package.json

$(npm config get prefix)/bin/koda   ← global symlink
  (on macOS with Homebrew: /opt/homebrew/bin/koda,
   on older Macs or Linux: /usr/local/bin/koda)

~/.koda/                       ← user state/config (NOT touched by install)
  ├── .env                     ← API keys, Discord tokens, channel IDs
  ├── config.json              ← agent config (name, model, budgets)
  ├── soul.md                  ← identity
  ├── user.md                  ← who you are
  ├── goals.md, learnings.md   ← memory layers 1 & 5
  ├── skills/                  ← skills (native + ClawHub installs)
  ├── data/                    ← observations, drafts, daily logs, sessions
  └── logs/                    ← daemon logs
```

### Updating an existing install

```bash
koda update              # pull + install + build + doctor + restart
koda update --dry-run    # preview what would change
```

See `koda --help` for all commands.

### Uninstalling

```bash
# Unlink the global binary
cd <wherever-you-cloned>/koda && npm unlink

# Stop the daemon
pm2 delete koda

# Remove the code (optional)
rm -rf <wherever-you-cloned>/koda

# DESTRUCTIVE: remove user state (wipes config, skills, memory, logs)
# Only do this if you're absolutely done with Koda.
rm -rf ~/.koda
```

## Requirements

- Node.js 18+ (script can install Node 22 via Homebrew on macOS, package manager on Linux)
- Claude Code CLI logged in (see "Authenticating with Anthropic" below)
- Claude Agent SDK 0.2.x (`@anthropic-ai/claude-agent-sdk`)
- Python 3 (for scripts in `~/.koda/scripts/`)
- ffmpeg, whisper, edge-tts (for voice channel support — optional)
- pm2 (script auto-installs via `npm install -g pm2`)

## Authenticating with Anthropic

Koda uses the Claude Agent SDK, which authenticates one of two ways:

### Path A — Max subscription (recommended for solo operators)

Install Claude Code CLI and log in once. Koda reads the credentials automatically.

```bash
# Install Claude Code CLI (separate from Koda)
npm install -g @anthropic-ai/claude-code

# Log in with your Max subscription
claude
# (first run opens a browser for OAuth)

# Verify you're logged in
claude --version
```

That's it — Koda picks up the session from `~/.claude/` transparently. **No `ANTHROPIC_API_KEY` needed.**

### Path B — API key (for servers / non-interactive / pay-per-use)

If you don't have (or don't want to use) a Max subscription, set an API key in `~/.koda/.env`:

```bash
# In ~/.koda/.env
ANTHROPIC_API_KEY=sk-ant-...
```

The Agent SDK picks up `ANTHROPIC_API_KEY` if set, falling back to Claude Code CLI login otherwise. Useful for headless servers where you can't run an interactive OAuth flow.

### Important: Max + Koda is allowed

As of April 2026, Anthropic blocks Claude subscriptions from powering certain third-party "harnesses" (like OpenClaw). **Koda is not in that category** — it uses the Agent SDK directly rather than wrapping Claude Code. Anthropic has explicitly confirmed that "nothing is changing about how you can use the Agent SDK and MAX subscriptions" (Anthropic engineer Thariq Shihipar, The New Stack, April 2026).

So if you're using Max sub with Koda, you're on the explicitly-blessed path.

## First-run setup

After running the install script (or cloning manually), initialize `~/.koda/`:

```bash
koda init
```

This copies template files from the repo into `~/.koda/`:

```
~/.koda/
├── config.json           ← edit: your name, social handles, model choice
├── soul.md               ← edit: agent personality, tone, hard limits
├── user.md               ← edit: who you are, projects, voice, audience
├── goals.md              ← edit: measurable targets the agent tracks
├── learnings.md          ← starts empty, grows as the agent runs
├── tasks.json            ← edit: scheduled tasks (5 examples included)
├── mcp-servers.json      ← edit: MCP servers to connect
├── .env.example          ← copy to .env and fill in secrets
└── skills/               ← example skills to learn the format
    ├── self-heal.md      (flat format)
    └── example-directory-skill/
        └── SKILL.md      (directory format, ClawHub-compatible)
```

**Nothing gets overwritten.** `koda init` is safe to re-run — it only creates files that don't already exist. The `*.example.*` versions in `~/.koda/` are refreshed every run so you can always see the current template.

After editing the config files, start the daemon:

```bash
# Set up your .env file first
cp ~/.koda/.env.example ~/.koda/.env
# edit ~/.koda/.env with your Discord token and API keys

# Start the daemon
cd <your koda repo> && pm2 start ecosystem.config.cjs

# Verify
koda status
```

## CLI commands

```bash
koda init       # set up ~/.koda/ on first install (safe to re-run)
koda status     # show daemon state, skills, memory freshness
koda update     # pull latest code, rebuild, restart
koda logs       # tail the daemon logs
koda restart    # restart with an optional reason
koda doctor     # check configuration for drift against the schema
koda skills     # list installed skills across all sources
koda health     # health check
koda --help     # full command list
```

See `koda <command> --help` for command-specific options.

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
