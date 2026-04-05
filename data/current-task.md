# Koda Agent — Current State (Updated 2026-04-05 18:30)

## Status: Live in Production (pm2 daemon, Koda#8323)

## Next Session Tasks (Priority Order)
1. **OpenAI fallback** — when Claude hits rate limit, fall back to GPT-4o via OpenAI API. Needs agent core changes to detect rate limit errors and switch providers. Add OPENAI_API_KEY to env.
2. **Monitor autonomous posts** — check first few X/Bluesky posts for brand voice compliance
3. **Fix video pipeline** (content-hub CLI session):
   - Generic images don't match narration — need scene-specific Gemini prompts
   - Subtitle word-breaking ("CONVE CT S") — broken split logic
   - Duration enforcement — hard check <60s for Shorts
4. **GSC MCP** — auth done, tools built, needs testing in a real task
5. **MCP health checks** — manifests declare health checks, run at startup

## Completed This Session
- Tick loop DISABLED ($58/day → $0)
- Reaction clips: YouTube + yt-dlp (HD MP4), replaced GIPHY
- Brand voice: WRONG vs RIGHT examples, reader-focused reframing, Corey Ganim format
- X/Bluesky posts now autonomous — no approval needed
- Weekly brand_voice_learn task — analyzes performance, evolves voice
- Skool content calendar: 10 posts from git history, self-replenishing backlog
- GSC analytics → blog post ideas pipeline
- Content proposals include blog posts with SEO angles
- publish.py: all hardcoded paths → env vars, uses pip-installed youtube_mcp
- Notipo fixed: NOTIPO_API_KEY (was NOTIPO_API), added NOTIPO_URL
- Auto-recovery on max_turns/errors — wipes session, restarts fresh
- **Isolated task sessions** — each scheduled task gets own query(), no context pollution
- **Per-task turn limits + budget caps** — analytics 5-10t/$1-3, articles 25-30t/$8-10
- **Task retry with backoff** — 2 retries (5min, 10min) before self-heal
- **Daily budget cap** — $50/day, tasks skip when exceeded
- **Context compaction** — auto-compacts every 50 turns
- **Task chaining** — tasks can trigger follow-up tasks with output as context
- **Health endpoint** — GET :3847/health (uptime, cost, task stats, memory)
- **Conversation memory** — daily 20:00, extracts key decisions into LEARNINGS.md
- **External MCP servers** — mcp-servers.json, add/remove without rebuild
- **Plugin architecture Phase 1** — content-hub extracted to standalone Python MCP server
- **Plugin architecture Phase 2** — auto-observe/track after every task (runtime, not tool calls)
- **Plugin architecture Phase 3** — manifest system with tool docs, env vars, usage examples
- **Notipo manifest** — full API docs, CLI commands, npm package, all endpoints
- Skool Airtable sync: full CSV data, churned marking, LTV/Joined/Invited By fields
- 48 old Skool members marked Churned in Airtable
- Koda GitHub repo created (private, git@github.com:kfuras/koda.git)

## Architecture
- pm2 daemon, tick disabled
- Isolated task sessions, per-task limits, retry, $50/day budget
- Context compaction every 50 turns, auto-recovery on errors
- Plugin manifests in manifests/ → injected into system prompt
- 2 built-in SDK servers (agent-tools, gsc) + 7 external (mcp-servers.json)
- 20 scheduled tasks + dream cycle + heartbeat
- Health endpoint at :3847/health
- Discord: #koda, #koda-proactive, #publish

## Channels
- #koda (1490053624225730680) — conversations
- #koda-proactive (1490088126666772570) — agent-initiated
- #publish (1486656837867540630) — video publishing
