/**
 * Deterministic binding-based message routing.
 *
 * Borrows from OpenClaw's binding system: messages are routed to agents
 * based on channel/channelId/userId matches, not LLM decisions.
 * Most-specific binding wins; falls back to the default agent.
 */

export interface Binding {
  agentId: string;
  match: {
    channel?: string;       // "discord", "webhook", etc.
    channelId?: string;     // Discord channel/thread ID
    userId?: string;        // Discord user ID
  };
}

/**
 * Resolve which agent should handle a message.
 * Priority (most-specific wins):
 *   1. Exact channelId + userId match
 *   2. Exact channelId match
 *   3. userId match
 *   4. Channel-wide match
 *   5. Default agent
 */
export function resolveAgent(
  bindings: Binding[],
  defaultAgentId: string,
  context: { channel?: string; channelId?: string; userId?: string },
): string {
  let bestMatch: string | null = null;
  let bestSpecificity = 0;

  for (const binding of bindings) {
    const m = binding.match;
    let specificity = 0;
    let matches = true;

    // Each matching field adds specificity; any mismatch disqualifies
    if (m.channelId) {
      if (m.channelId === context.channelId) {
        specificity += 10;
      } else {
        matches = false;
      }
    }

    if (m.userId) {
      if (m.userId === context.userId) {
        specificity += 5;
      } else {
        matches = false;
      }
    }

    if (m.channel) {
      if (m.channel === context.channel) {
        specificity += 1;
      } else {
        matches = false;
      }
    }

    if (matches && specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestMatch = binding.agentId;
    }
  }

  return bestMatch ?? defaultAgentId;
}
