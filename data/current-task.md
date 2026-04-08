# Koda Agent — Current State (Updated 2026-04-06 00:15)

## Status: Live in Production (pm2 daemon, Koda#8323)

## NEXT SESSION: Add skills system to Koda

Use the Claude Code skill creator skill to create Koda skills.
Skills = step-by-step workflow instructions in markdown files at ~/.koda/skills/
Loaded into system prompt like manifests. Koda follows the recipe instead of improvising.

### Skills to create:
1. delete-wordpress-post — use Notipo API to get WP credentials, then WP REST API to delete
2. publish-blog-post — GSC keyword research → draft → Notipo CLI to publish
3. Any other common operations where Koda improvises instead of following a known path

### Reference:
- Claude Code skills spec: ~/code/claurst/spec/11_special_systems.md (line 997+)
- Skill format: markdown with frontmatter (name, description, when-to-use, allowed-tools)
- Manifests system (existing): src/manifests.ts — similar pattern to follow

## Completed this session

### 10 Claude Code patterns
- Sequential queue, circuit breaker, missed task detection, session registry
- Memory extraction (cursor, coalescing, mutual exclusion)
- Token budget syntax, hot-reload, progress summaries, teleport

### Dream cycle rewrite
- Bash+python → LLM-driven TypeScript (src/dream.ts)
- 4-phase: Orient → Gather → Consolidate → Prune

### Audit fixes (verified against leaked source + Claurst specs)
- Auto-recovery preserves session (no more nuking context)
- extractMemories with cursor, coalescing, mutual exclusion
- Tool permission constraints on extractMemories and dream
- Freshness warnings, memory feedback, mutual exclusion with main agent

### Bug fixes
- SDK update 0.1.77 → 0.2.92 (fixed startup crashes)
- Compaction loop fix (num_turns was cumulative, not per-response)
- Credential redaction in YOLO logger
- Missed task recovery: cap at 3, approval tasks first, staggered
- System prompt guardrails: use configured keys first, never hunt credentials

### New features
- !tasks command (shows schedule + today's status)
- blog_post task (SEO, GSC keyword targeting, every 3 days)
- Git history restored (42 commits, no personal data)

### Analysis
- Claurst: Rust port with detailed specs at ~/code/claurst/spec/
- Claw Code: Different Rust port with recovery recipes + policy engine
- Claude Code leak: yasasbanukaofficial/claude-code — authoritative source
- Compared all Koda implementations against leak, fixed what was wrong

## Architecture
- Source: ~/code/koda/ (TypeScript, runs via npx tsx)
- Install: ~/.koda/ (config, state, scripts, servers, manifests, tasks, .env)
- pm2 daemon, 42 git commits
- New files: src/patterns.ts, src/dream.ts, src/teleport.ts
- SDK: @anthropic-ai/claude-agent-sdk 0.2.92 + zod 4
