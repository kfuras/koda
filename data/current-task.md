# Koda Agent — Current State (Updated 2026-04-05 19:30)

## Status: Live in Production (pm2 daemon, Koda#8323)

## NEXT SESSION: Move scripts and servers to ~/.koda/

The installed app should live entirely in ~/.koda/. Content-hub should only have Remotion video pipeline stuff.

### What to move from ~/code/content-hub/ to ~/.koda/:
- scripts/*.py → ~/.koda/scripts/ (post_x.py, scan_viral_tweets.py, publish.py, quote_tweet_web.py, search_reaction_clip.py, instagram_analytics.py, cta_reply.py, generate_image.py, generate_thumbnail.py, trending_topics.py, refresh_meta_token.py, research_topics.py, skool-airtable-sync.py)
- servers/*.py → ~/.koda/servers/ (content_hub_mcp_server.py, x_mcp_server.py)
- data/brand-voice-skill.md → ~/.koda/brand-voice-skill.md
- data/drafts/ → ~/.koda/data/drafts/
- data/analytics/ → ~/.koda/data/analytics/
- data/x-feed/ → ~/.koda/data/x-feed/
- data/voice-profile.json → ~/.koda/data/voice-profile.json

### What stays in ~/code/content-hub/:
- video/ (Remotion pipeline, compositions, builds)
- video skills/docs
- .gitignore, package.json for Remotion

### After moving:
- Update mcp-servers.json to point to ~/.koda/servers/
- Update manifests to point to ~/.koda/scripts/
- Update content_hub_mcp_server.py SCRIPTS_DIR
- Symlink .env is already in ~/.koda/.env
- Test everything still works

### Final structure:
```
~/.koda/                    ← the installed app
├── .env                    ← all API keys
├── config.json             ← agent config
├── soul.md, user.md        ← identity
├── learnings.md, goals.md  ← knowledge
├── brand-voice-skill.md    ← content voice rules
├── scripts/                ← Python automation scripts
├── servers/                ← MCP servers (Python)
├── manifests/              ← plugin manifests with tool docs
├── mcp-servers.json        ← MCP server registry
├── data/                   ← drafts, analytics, x-feed, observations, outcomes
└── logs/

~/code/koda/                ← source code repo (open-sourceable, no personal data)
├── src/                    ← TypeScript agent runtime
├── templates/              ← init templates for new users
└── package.json

~/code/content-hub/         ← Remotion video pipeline only
├── video/                  ← compositions, builds, assets
└── package.json
```

## Completed This Session (massive)
- Tick loop disabled ($58/day → $0)
- Reaction clips: YouTube + yt-dlp replacing GIPHY
- Brand voice: WRONG vs RIGHT examples, reader-focused, weekly learning
- X/Bluesky autonomous posting
- Skool content calendar (10 posts, self-replenishing)
- GSC → blog post ideas
- publish.py env vars fix
- Notipo fix (NOTIPO_API_KEY, NOTIPO_URL)
- Auto-recovery on max_turns
- Isolated task sessions with per-task limits
- Task retry with backoff
- Daily budget cap $50
- Context compaction every 50 turns
- Task chaining
- Health endpoint GET :3847/health
- Conversation memory task
- Plugin architecture (external MCP, auto-runtime, manifests)
- Notipo full API docs in manifest
- ~/.koda/ home directory (OpenClaw-style)
- Open-source ready (zero personal data in source)
- Single .env at ~/.koda/.env (symlinked from content-hub)
- koda init command
- Skool Airtable sync: full CSV data, churned marking
- 48 old Skool members marked Churned
- Koda GitHub repo created (private)
- OpenClaw analysis and architectural improvements

## Architecture
- Source: ~/code/koda/ (TypeScript, Agent SDK)
- Install: ~/.koda/ (config, state, manifests, .env)
- Content: ~/code/content-hub/ (scripts, servers — moving to ~/.koda/ next session)
- pm2 daemon, tick disabled
- Isolated task sessions, per-task limits, retry, $50/day budget
- Context compaction, auto-recovery
- Plugin manifests → system prompt
- 2 built-in SDK servers (agent-tools, gsc) + 7 external
- 20 scheduled tasks + dream cycle + heartbeat
- Health endpoint at :3847/health
