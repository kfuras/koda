# Koda — Personal AI Assistant

[![npm](https://img.shields.io/npm/v/koda-agent)](https://www.npmjs.com/package/koda-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Agent SDK](https://img.shields.io/badge/Claude_Agent_SDK-0.2.x-blueviolet)](https://docs.anthropic.com/en/docs/agents)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)

**Koda** is a personal AI assistant you run on your own machine. It drafts content, posts to X, scans for viral tweets, pulls SEO analytics, writes blog posts, manages your Skool community, and reports everything back to Discord — all on a cron schedule, 24/7, while you sleep.

It runs on the Claude Agent SDK with a Pro/Max subscription. No API costs. No cloud hosting. One laptop.

```
20 scheduled tasks · 13 MCP servers · 19 skills · 6-layer memory system
Discord control plane · Self-healing · Nightly dream cycle
```

[Install](#install) · [First Run](#first-run-setup) · [Architecture](#architecture) · [MCP Servers](#mcp-servers) · [Skills](#skills) · [Memory System](#memory-system) · [CLI](#cli-commands) · [Discord](#discord-commands) · [AGENTS.md](AGENTS.md)

---

## Install

```bash
npm install -g koda-agent
koda init
```

That's it. You now have a global `koda` command and `~/.koda/` with config, skills, and MCP servers ready to customize.

### Alternative: from source

```bash
git clone https://github.com/kfuras/koda.git
cd koda && npm install && npm run build && npm link
koda init
```

### Alternative: curl installer

```bash
curl -fsSL https://raw.githubusercontent.com/kfuras/koda/main/install.sh | bash
```

Installs prerequisites (Node, pm2), installs koda-agent from npm, runs `koda init` + `koda doctor`.

### Requirements

- Node.js 18+
- Claude Code CLI logged in (`claude login`) — or set `ANTHROPIC_API_KEY` in `~/.koda/.env`
- pm2 (`npm install -g pm2`)
- Python 3 (for MCP server scripts)

### Updating

```bash
npm update -g koda-agent    # update the CLI + daemon code
koda doctor                  # verify nothing broke
pm2 restart koda             # restart the daemon
```

### Uninstalling

```bash
npm uninstall -g koda-agent  # remove the binary
pm2 delete koda              # stop the daemon
rm -rf ~/.koda               # DESTRUCTIVE: remove all config, skills, memory
```

---

## Authenticating with Anthropic

Two paths:

### Path A — Pro/Max subscription (recommended)

```bash
npm install -g @anthropic-ai/claude-code
claude    # first run opens browser for OAuth
```

Koda reads the session from `~/.claude/` automatically. No API key needed.

### Path B — API key

```bash
# In ~/.koda/.env
ANTHROPIC_API_KEY=sk-ant-...
```

For headless servers or pay-per-use. The SDK uses `ANTHROPIC_API_KEY` if set, falls back to Claude Code login otherwise.

Koda uses the Agent SDK directly. Anthropic has explicitly confirmed that Agent SDK usage is allowed with Pro/Max subscriptions (Thariq Shihipar, The New Stack, April 2026).

---

## First-Run Setup

After `koda init`, your `~/.koda/` directory looks like:

```
~/.koda/
├── config.json         ← your name, model, budgets
├── soul.md             ← agent personality and boundaries
├── user.md             ← who you are, projects, audience
├── goals.md            ← measurable targets the agent tracks
├── learnings.md        ← grows as the agent runs
├── tasks.json          ← scheduled tasks (examples included)
├── mcp-servers.json    ← which MCP servers to connect
├── .env.example        ← copy to .env and fill in secrets
├── skills/             ← markdown playbooks (19 included)
└── servers/            ← MCP server scripts (7 included)
```

```bash
cp ~/.koda/.env.example ~/.koda/.env
# Edit ~/.koda/.env — only DISCORD_BOT_TOKEN is required to start

# Start the daemon
pm2 start $(npm root -g)/koda-agent/ecosystem.config.cjs

# Verify
koda status
```

---

## MCP Servers

Koda uses per-service MCP servers — each one is a local Python process communicating via JSON-RPC. You only need credentials for the services you use.

| Server | Tools | Required credentials |
|---|---|---|
| **x-mcp** | post_tweet, quote_tweet, scan_viral_tweets, publish_x_article, trending_topics, +4 more | X API keys |
| **bluesky-mcp** | create_post (text + image + **video**), delete_post, get_profile, get_timeline, get_my_posts | Bluesky app password |
| **content-tools** | generate_image (Gemini), generate_thumbnail, search_reaction_clip, voice_short, research_topics | GEMINI_API_KEY |
| **skool-tools** | get_community, get_posts, create_post, delete_post, pin_post, sync_members | Skool credentials |
| **instagram-tools** | analytics, upload | Meta access token |
| **meta-tools** | check_token, refresh_token | Meta access token + app secret |
| **publish-tools** | publish_video, devto_crosspost | Discord bot token, DEVTO_API_KEY |
| **youtube** | 30+ tools (analytics, upload, search, playlists) | Google OAuth ([setup guide](docs/google-oauth-setup.md)) |
| **gmail** | send, search, labels, calendar | Google OAuth ([setup guide](docs/google-oauth-setup.md)) |
| **airtable** | CRUD records, tables, bases | Airtable API key |
| **context7** | query-docs, resolve-library-id | None (free) |
| **agent-tools** *(built-in)* | observe, propose_task, track_outcome, ultraplan, check_health, restart_self | None |
| **gsc** *(built-in)* | search_analytics, inspect_url | Google OAuth ([setup guide](docs/google-oauth-setup.md)) |

**You only need `DISCORD_BOT_TOKEN` to start.** Add MCP servers one at a time as you need them.

See [`templates/servers/README.md`](templates/servers/README.md) for per-server setup instructions.

---

## CLI Commands

```bash
koda init       # set up ~/.koda/ (safe to re-run, never overwrites)
koda status     # daemon state, skills, memory freshness
koda update     # pull latest, rebuild, restart (from-source installs)
koda logs       # tail daemon logs
koda restart    # restart with an optional reason
koda doctor     # validate config against schema
koda skills     # list installed skills across all sources
koda health     # quick health check
koda --help     # full command list
```

---

## Discord Commands

| Command | What |
|---|---|
| `@Koda <message>` | Talk to the agent (or any message in allowed channels) |
| `!status` | Uptime, memory, PID |
| `!teleport [note]` | Transfer context to Claude Code CLI |
| `!join` / `!leave` | Voice channel (optional) |
| `+500k <message>` | Extended token budget (`+2M`, `use 1M tokens`) |
| React ✅/❌ | Approve or reject task proposals |

---

## Architecture

```
src/
├── index.ts           # Entry point — boots agent, bot, scheduler, webhooks
├── agent.ts           # Persistent streaming session + isolated task runner
│                        - Session resume across restarts
│                        - Plugin discovery via SDK plugins API
│                        - YOLO risk classifier (LOW/MEDIUM/HIGH)
│                        - Subagents: researcher, implementer, verifier
│                        - Context compaction (proactive every 50 turns)
│                        - Background memory extraction (every 3 turns)
├── bot.ts             # Discord bot
│                        - Reaction-based approval flow
│                        - Thread support, frustration detection
│                        - Proactive channel routing
│                        - Initiative status persistence
├── scheduler.ts       # Cron task scheduler
│                        - Self-healing (diagnose → fix → retry)
│                        - Circuit breaker, session registry
│                        - Missed task recovery on startup
│                        - Tick loop (Sonnet, silent, every 15 min)
├── dream.ts           # Nightly memory consolidation (3:07 AM)
├── patterns.ts        # Circuit breaker, async queue, session registry
├── teleport.ts        # Context transfer between CLI and Koda
├── config.ts          # Environment, system prompt, agent defaults
├── skills.ts          # Skill loading (~/.koda/skills/ → system prompt)
└── tools/
    ├── agent-tools.ts # observe, propose_task, track_outcome, ultraplan
    └── gsc.ts         # Google Search Console MCP server
```

### How it works

```
Discord message ─┐
GitHub webhook ───┤──→ persistent agent session ──→ responses → Discord
Voice channel ────┘    (Opus, stays alive)

Scheduled task ──→ isolated session (Opus, fresh context, budget-capped)
Tick loop ───────→ isolated session (Sonnet, cheaper, silent)
```

---

## Skills

Skills are markdown playbooks loaded into the system prompt at startup. They tell Koda how to handle specific tasks — step-by-step recipes instead of improvisation.

19 built-in skills ship with `koda init`. Add your own:

```markdown
---
name: my-skill
description: What this skill does
when: When to use it
---
Step-by-step instructions...
```

Save to `~/.koda/skills/my-skill.md`. Restart to load.

---

## Memory System

```
Agent works → observations.md (capped at 500 lines)
                    ↓
Dream cycle (3:07 AM) → Orient → Gather → Consolidate → Prune
                    ↓
              learnings.md (under 100 lines)

Background extraction (every 3 turns):
  Conversation → extractMemories → learnings.md
```

6 layers: bootstrap (soul/user/goals) → observations → dream cycle → daily logs → learnings → search. See [docs/memory-architecture.md](docs/memory-architecture.md).

---

## Scheduled Tasks

Tasks are defined in `~/.koda/tasks.json` (hot-reloaded on change).

**Daily:** YouTube analytics, Instagram analytics, Bluesky stats, learnings review, Skool sync, goal check, X feed scan, viral tweet scan, CTA replies

**Every 3 days:** Content proposal, social post, Skool post, X article, blog post

**Weekly:** Weekly report, lesson draft, voice profile refresh, Meta token check

**System:** Dream cycle (3:07 AM), daily digest (9 PM), tick loop (every 15 min), outcome checks (6h), initiative review (2h), heartbeat (60s)

---

## Environment Variables

Only `DISCORD_BOT_TOKEN` is required. Everything else is optional — add as you enable services.

See [`.env.example`](.env.example) for all 37 supported keys, grouped by service with inline documentation.

---

## Production Setup

```bash
npm install -g pm2 koda-agent
koda init

# Start daemon
pm2 start $(npm root -g)/koda-agent/ecosystem.config.cjs

# Persist across reboots
pm2 save
pm2 startup   # run the command it outputs
```

---

## Google Integrations

YouTube, Gmail, and Google Search Console require a one-time OAuth setup. See [docs/google-oauth-setup.md](docs/google-oauth-setup.md). These are optional.

---

## Contributing

See [AGENTS.md](AGENTS.md) for repo conventions, architecture decisions, and coding rules.
