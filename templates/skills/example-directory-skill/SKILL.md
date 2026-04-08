---
name: example-directory-skill
description: Example of an AgentSkills-format skill (ClawHub-compatible directory layout). Replace this body with your own instructions.
when: Remove this skill once you understand the directory format — it's here as a reference only.
---

# Example directory-based skill

This skill demonstrates the **AgentSkills / ClawHub** format — a directory
containing a `SKILL.md` plus optional bundled files like `scripts/`,
`references/`, or `assets/`.

Koda loads this skill exactly the same way as a flat `.md` skill: the
markdown body is injected into the system prompt when the agent starts.

## Directory layout

```
~/.koda/skills/example-directory-skill/
├── SKILL.md       ← you're reading this
├── scripts/       ← optional: helper scripts the agent can run via Bash
│   └── helper.sh
└── references/    ← optional: longer reference docs the agent can read
    └── patterns.md
```

## Why use the directory format

- **Bundled scripts.** When your skill needs to run a specific Python or
  shell script, ship it alongside the SKILL.md so everything stays together.
- **Reference docs.** Longer reference material that would bloat the system
  prompt can live in `references/` — the agent reads it on demand via the
  Read tool, not every turn.
- **ClawHub compatibility.** The directory format matches what
  `clawhub.ai` publishes, so you can install ClawHub skills directly with
  `install_clawhub_skill` (via Discord) and they land in this same layout.

## Why use the flat format instead

- **Single-file skills** are easier to edit, version, and share as a gist.
- **No bundled code** means no audit burden — the agent sees everything in
  the markdown body.
- **Koda's own original skills** all use the flat format for simplicity.

Use directory format when you need bundled files, flat when you don't.

## Delete this skill

Once you understand the format, delete this directory or replace its body
with a real skill of your own:

```
rm -rf ~/.koda/skills/example-directory-skill
```
