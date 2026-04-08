# GOALS.md — Measurable Targets

> The autonomous loop reads this every cycle. When a goal is behind, the
> agent proposes actions to close the biggest gap.
>
> Keep targets measurable and time-bounded. "Get more followers" is not a
> goal — "YouTube subscribers: 100 by April 30, 2026 (current: 49)" is.
>
> Update targets monthly. Delete goals that no longer matter.

## <Project / Channel 1> (by <target date>)

- Metric 1: <target value> (current: <current value>) — <notes>
- Metric 2: <target value> (current: <current value>)
- Metric 3: <target value> (current: <current value>)

## <Project / Channel 2> (by <target date>)

- Metric 1: <target value> (current: <current value>)
- Metric 2: <target value> (current: <current value>)

## <Project / Channel 3> (by <target date>)

- Metric 1: <target value> (current: <current value>)
- Metric 2: <target value> (current: <current value>)

---

**How to use this file:**

- Use `✅ MET` / `⚠️ AT RISK` / `❌ MISSED` markers next to metrics to flag
  status without the agent having to compute it.
- Add a `⚠️ BLOCKED: <reason>` line under a goal if external factors are
  preventing progress — the agent will stop proposing more work toward a
  blocked goal.
- Review monthly. Delete anything you no longer care about. The agent has
  limited context — every goal you keep costs tokens on every session.
