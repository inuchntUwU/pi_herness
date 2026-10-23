/**
 * Goal helpers shared by the modes extension.
 *
 * A goal is a free-form statement of what the session should achieve. It is
 * persisted in the session and injected into the agent context while goal mode
 * is active, so the model keeps steering toward it.
 */

export const GOAL_MARKER = "[SESSION GOAL]";

/** Normalize raw /goal arguments into a stored goal. */
export function extractGoal(raw: string): string | undefined {
  const text = raw.trim();
  if (text === "" || text === "clear") return undefined;
  return text;
}

/** Human-readable one-liner for notifications and widgets. */
export function formatGoal(goal: string | undefined): string {
  return goal ? `🎯 ${goal}` : "🎯 (no goal set)";
}

/** Context block injected at the top of the goal-mode instruction. */
export function goalContext(goal: string | undefined): string {
  if (!goal) {
    return `${GOAL_MARKER}
No goal is set yet. Ask the user to set one with /goal <text> before proposing changes.`;
  }
  return `${GOAL_MARKER}
The session goal is:

${goal}

Keep advancing this goal. If the current request conflicts with it, say so before proceeding.`;
}
