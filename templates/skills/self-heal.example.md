---
name: self-heal
description: Diagnose and recover from errors, crashes, or degraded state
when: Something is broken, tasks are failing repeatedly, user reports Koda isn't responding, or you detect an error pattern
---

## Steps

### Phase 1: Diagnose

1. **Run health check first:**
   Use the `check_health` tool — it returns pm2 status, restart count, uptime, and recent errors.

2. **Check recent errors in the log:**
   ```
   tail -n 50 ~/.koda/logs/koda-error.log
   ```

3. **Check stdout for context:**
   ```
   tail -n 100 ~/.koda/logs/koda-out.log
   ```

4. **Identify the failing component:**
   - MCP server connection errors → external service issue
   - Claude Agent SDK errors → check subscription/API quota
   - Scheduled task errors → check the specific task's prompt and tools
   - Process restart loops → configuration or dependency issue

### Phase 2: Recover

1. **If an MCP server is failing**, check its env vars in `~/.koda/.env` and the command path in `~/.koda/mcp-servers.json`. Try running the MCP server manually to see the real error.

2. **If Claude is rate-limited or quota-exhausted**, stop autonomous tasks for 1 hour and notify the user via Discord.

3. **If a scheduled task is broken**, read the task's prompt in `~/.koda/tasks.json` and check the tools it references. If the tool is gone, remove or rewrite the task.

4. **If the process itself is crashing**, use the `restart_self` tool with a clear reason. Do not loop — if it fails to stay up after 2 restarts, escalate to Discord and stop.

### Phase 3: Report

After recovery (or giving up), post to Discord:
- What was broken
- What you did to fix it
- Whether it's fully recovered or still degraded
- Any action the user needs to take

Do not post noise during diagnosis — only report when you have a conclusion.

## Hard rules

- Never restart more than 2 times in a row without user intervention.
- Never modify ~/.koda/config.json without explicit user approval.
- Never push git changes during recovery.
- Always log what you did to the daily log for Layer 4 memory.
