# Koda Memory Architecture

Koda's memory is a **6-layer consolidation pipeline**. Raw signals from daily operation are distilled, layer by layer, into durable knowledge the agent can act on in future sessions. Each layer has a specific purpose, a specific update cadence, and a specific consumer.

This document exists because the architecture is the most principled part of Koda's design and the primary axis on which it differs from other autonomous-agent frameworks.

## The pipeline at a glance

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: bootstrap       soul.md, user.md, goals.md,        │
│  (static identity)         skills/*.md, config.json          │
│                            Loaded at startup. Rarely changes.│
└──────────────────────────────┬───────────────────────────────┘
                               │ inform
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 2: observations    data/observations.md               │
│  (raw signal)              Auto-distilled event stream.      │
│                            Appended continuously by the      │
│                            running agent. Tagged [event],    │
│                            [habit], [goal], [fact].          │
│                            Capped at ~500 lines; overflow    │
│                            archived to observations-archive. │
└──────────────────────────────┬───────────────────────────────┘
                               │ consolidated nightly by
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: dream cycle     src/dream.ts                       │
│  (nightly consolidation)   4-phase LLM-driven process        │
│                            at 03:07 daily. Orient, signal,   │
│                            consolidate, prune.               │
│                            Writes back to observations.md    │
│                            and feeds Layer 4 / 5 updates.    │
└──────────────────────────────┬───────────────────────────────┘
                               │ narrative recap
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 4: daily logs      data/daily-logs/{date}.md          │
│  (narrative middle tier)   Produced at 21:00 by the          │
│                            daily_digest task (sent to        │
│                            Discord AND persisted to disk).   │
│                            One file per day. The story of    │
│                            what happened, in prose.          │
└──────────────────────────────┬───────────────────────────────┘
                               │ read by morning
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 5: learnings       learnings.md                       │
│  (curated wisdom)          Updated at 07:45 by the           │
│                            learnings_review task, which      │
│                            reads the last 3 daily logs and   │
│                            extracts durable patterns.        │
│                            Long-term memory the agent        │
│                            brings to every new session.      │
└──────────────────────────────┬───────────────────────────────┘
                               │ queryable via
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 6: search          scripts/search-memory.sh           │
│  (retrieval)               grep across all layers:           │
│                            LEARNINGS, observations,          │
│                            daily-logs, transcripts,          │
│                            observations-archive.             │
└──────────────────────────────────────────────────────────────┘
```

## Layer 1 — Bootstrap (identity)

**Files**: `soul.md`, `user.md`, `goals.md`, `skills/*.md`, `config.json`
**Cadence**: static; updated manually or by occasional agent writes
**Purpose**: Give the agent a stable identity, understanding of the operator, current objectives, and capability inventory.

These files are loaded into every session's system prompt. They do not grow during operation. Think of them as the agent's *constitution* — slow-changing, foundational, and deliberately edited.

## Layer 2 — Observations (raw signal)

**File**: `data/observations.md` (capped at ~500 lines), `data/observations-archive.md` (overflow)
**Cadence**: continuous, appended during normal agent operation
**Format**: tagged lines — `[event]`, `[habit]`, `[goal]`, `[fact]`

Observations are the **raw sensor stream**. When the agent notices something during a task — a pattern, a result, a contradiction, a new fact — it appends a single tagged line. These are not curated. They are not summaries. They are the firehose of what the agent saw while working.

Consumed by Layer 3 (dream cycle). Archived when the file exceeds cap so the working set stays small enough to fit in context.

**Rationale**: most "agent memory" implementations conflate raw events with learned patterns. Keeping them separate means the learning layer has a clean feedstock and the raw layer has no editorial pressure.

## Layer 3 — Dream cycle (nightly consolidation)

**Code**: `src/dream.ts`
**Cadence**: 03:07 AM daily
**Process**: 4-phase LLM-driven consolidation

The dream cycle runs when the operator is asleep and Koda's load is low. It reads observations, identifies patterns worth promoting, and writes updates across the other layers. The 4 phases are:

1. **Orient** — re-read soul, user, goals, learnings to establish current context.
2. **Signal** — scan new observations for patterns, anomalies, contradictions.
3. **Consolidate** — distill signal into durable form: update learnings, write daily log summary, promote noteworthy observations.
4. **Prune** — archive old observations, clean stale state, reduce working-set size.

**Rationale**: consolidation is expensive (it reads a lot of context and generates a lot of text). Doing it in the background at night keeps the interactive path fast and concentrates the "expensive thinking" in a window where latency doesn't matter.

## Layer 4 — Daily logs (narrative middle tier)

**Directory**: `data/daily-logs/{YYYY-MM-DD}.md`
**Cadence**: 21:00 daily (written by the `daily_digest` task)
**Purpose**: narrative record of what happened each day, bridging raw observations and curated learnings

Each evening at 21:00, Koda summarizes what it did that day — tasks completed, tasks failed, observations recorded, content drafted, API spend, anything needing attention tomorrow. The summary is sent to Discord (for the operator to read) **and persisted to disk** as `data/daily-logs/{date}.md`.

**Why a middle tier exists**: observations are too granular to extract patterns from directly ("video posted", "53 views", "1 comment" — flat events). Learnings are too distilled to preserve context ("physics content gets early algorithmic boost"). Daily logs are the **narrative** in between: "Published neutron star Short today. Got 53 views in 3 hours — unusual. Comment suggests algorithm is starting to like physics content." That narrative is what the next layer distills patterns from.

**Consumed by** the `learnings_review` task at 07:45 the next morning, which reads the last 3 daily logs and updates `learnings.md`.

**Historical note**: Layer 4 was broken from April 5 (the TypeScript rewrite of Koda) until it was restored alongside this document. In between, the `daily_digest` task was generating exactly the right content and then discarding it after sending to Discord, while `learnings_review` was reading stale frozen files every morning and concluding there was nothing to learn. Restoring the disk write reconnected the pipeline end-to-end.

## Layer 5 — Learnings (curated wisdom)

**File**: `learnings.md`
**Cadence**: updated at 07:45 daily by the `learnings_review` task
**Format**: short bulleted patterns, grouped by topic

Learnings are the **durable, portable** part of Koda's memory. They survive context compaction, session restarts, and dream cycles unchanged. When Koda starts a new session tomorrow, it won't remember yesterday's observations or daily log directly — but it *will* carry forward whatever pattern was promoted to `learnings.md`.

The learning loop: raw observations (Layer 2) → narrative digest (Layer 4) → pattern extraction (Layer 5). By the time something lands in learnings, it has been filtered through at least two layers of review and one night of consolidation.

**Rationale**: most long-running agents get worse over time as their context bloats. A clean learnings file that grows slowly and deliberately is the antidote — the agent brings 100 lines of curated wisdom to every session, not 10,000 lines of raw history.

## Layer 6 — Search (retrieval)

**Script**: `scripts/search-memory.sh`
**Cadence**: on demand
**Scope**: grep across all preceding layers

When the operator or the agent needs to find something — "when did I last try approach X", "what was the outcome of Y experiment", "which tutorial did I render three weeks ago" — search bridges the gap between short-term context and long-term archive. It greps `LEARNINGS.md`, `observations.md`, `observations-archive.md`, `daily-logs/`, and `transcripts/` in one pass.

**Rationale**: keeping the consolidation pipeline lean means old detail ends up in archive files, not in active context. Search is how the system remains queryable without bloating the hot path.

## Design invariants

Three rules that hold across the pipeline:

1. **Signal flows upward; distillation happens in scheduled batches.** Raw events flow into observations continuously. Consolidation happens at specific times (dream cycle at 03:07, daily digest at 21:00, learnings review at 07:45). The interactive path is never blocked by consolidation work.

2. **Each layer has exactly one producer and a small number of consumers.** Observations are written by the running agent. Dream cycle is written by the 03:07 scheduled task. Daily logs are written by the 21:00 digest. Learnings are written by the 07:45 review. Clear ownership means you can always answer "who wrote this?" — which matters for debugging and for trust.

3. **Archive, don't delete.** When working sets exceed caps, data moves to archive files (`observations-archive.md`, old `daily-logs/` entries). Nothing is destroyed. Search can still reach it. This preserves the full history while keeping the active working set small enough to fit in context windows.

## Comparison to other agent memory models

| System | Memory model |
|---|---|
| Koda | 6 layers: bootstrap → observations → dream → daily logs → learnings → search |
| Claude Code | `autoDream` 4-step cycle: orient → gather signals → consolidate → prune |

Production agents converge on the "consolidate raw signals into durable memory" pattern. Koda's pipeline is the most explicit, with each layer individually inspectable on disk.

## Where to look in the code

| Concern | File | Key line |
|---|---|---|
| Observation writes | `src/runtime.ts`, `src/agent.ts` | grep for `observations.md` |
| Dream cycle | `src/dream.ts` | entire file |
| Daily digest → daily log write | `src/scheduler.ts` | `sendDailyDigest()` |
| Learnings review schedule | `~/.koda/tasks.json` | task `learnings_review`, cron `45 7 * * *` |
| Search across layers | `~/.koda/scripts/search-memory.sh` | entire file |
| Init of memory dirs | `src/init.ts` | `data/` dir creation list |

## Operational cadence summary

```
03:07  dream cycle       consolidate observations → daily log hints, learnings candidates, pruning
07:45  learnings review  read last 3 daily logs → update learnings.md
(all day) observations   continuous append to observations.md
21:00  daily digest      generate summary → write data/daily-logs/{date}.md → send to Discord
(hourly) backup          rsync data/ → backups/{date}/
```

The operator's day begins with Koda having already distilled yesterday's events into actionable patterns, and ends with Koda summarizing today before it sleeps. The pipeline runs itself.
