/**
 * Modes Extension
 *
 * A single Shift+Tab cycle over seven modes:
 *
 *   reading → plan → goal → hard-goal → auto → hard-auto → loop → reading → ...
 *
 *   reading    Full read-only exploration. edit/write disabled, bash restricted
 *              to a read-only allowlist.
 *   plan       Same restrictions as reading, but the agent is asked to produce a
 *              numbered plan under a "Plan:" header instead of making changes.
 *   goal       Full tool access. The agent is asked to keep moving toward the
 *              goal set with /goal.
 *   hard-goal  Like goal, but the safety-gate confirmation dialog is bypassed
 *              (dangerous commands run without asking; sudo is still blocked).
 *   auto       Full tool access, no extra instructions (the normal mode).
 *   hard-auto  Like auto, but the safety-gate confirmation dialog is bypassed.
 *   loop       Unattended iteration toward a goal (engine in loop.ts). The
 *              planning phase is read-only; the run phase bypasses the gate.
 *
 * Shift+Tab cycles the modes. /read, /plan, /goal, /auto and /loop jump directly.
 * Alt+T is left to pi's thinking-level cycle (see keybindings.json).
 *
 * State is persisted in the session and restored on resume/fork.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { isSafeCommand } from "../lib/safe-command.ts";
import { GOAL_MARKER, goalContext } from "../lib/goal.ts";

const MODES = ["reading", "plan", "goal", "hard-goal", "auto", "hard-auto", "loop"] as const;
export type Mode = (typeof MODES)[number];

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
const WRITE_TOOLS = new Set(["edit", "write"]);
const CONTEXT_MARKER = "[MODE ACTIVE]";

const MODE_INDICATOR: Record<Mode, { key: string; text: string }> = {
  reading: { key: "mode", text: "🔒 reading" },
  plan: { key: "mode", text: "📋 plan" },
  goal: { key: "mode", text: "🎯 goal" },
  "hard-goal": { key: "mode", text: "🔥 hard-goal" },
  auto: { key: "mode", text: "▶ auto" },
  "hard-auto": { key: "mode", text: "🔥 hard-auto" },
  loop: { key: "mode", text: "🔁 loop" },
};

const MODE_INSTRUCTION: Record<Exclude<Mode, "auto">, string> = {
  reading: `[MODE: READING]
You are in reading mode — a read-only mode for safe inspection.
- edit and write tools are disabled.
- bash is restricted to an allowlist of read-only commands.
Read and analyze only. Describe changes you would make instead of making them.`,
  plan: `[MODE: PLAN]
You are in plan mode — read-only exploration to produce a plan.
- edit and write tools are disabled.
- bash is restricted to an allowlist of read-only commands.
Investigate, then produce a numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description

Do NOT make changes — describe what you would do. Ask clarifying questions if needed.`,
  goal: `[MODE: GOAL]
You are in goal mode — full tool access, working toward the session goal.
Keep the goal above in mind and advance it every turn. Report progress toward it.`,
  "hard-goal": `[MODE: HARD-GOAL]
You are in hard-goal mode — full tool access toward the session goal, and the dangerous-command
confirmation gate is bypassed.
- Commands that would normally require confirmation (recursive delete, force push, file-overwrite
  redirects, dd/mkfs, curl|sh) run without asking. Do not stop to ask permission for them; just run them.
- The exception is sudo: it cannot run inside pi (no TTY). Hand sudo commands to the user to run in a
  real terminal.
Keep the goal above in mind and advance it every turn. Report progress toward it.`,
  "hard-auto": `[MODE: HARD-AUTO]
You are in hard-auto mode — full tool access, and the dangerous-command confirmation gate is bypassed.
- Commands that would normally require confirmation (recursive delete, force push, file-overwrite
  redirects, dd/mkfs, curl|sh) run without asking. Do not stop to ask permission for them; just run them.
- The exception is sudo: it cannot run inside pi (no TTY). Hand sudo commands to the user to run in a
  real terminal.`,
  loop: `[MODE: LOOP]
You are in loop mode — an unattended loop that iterates toward the goal above until it is done or
blocked. While the loop is running, the dangerous-command confirmation gate is bypassed (sudo is
still impossible: hand those commands to the user).

Phase 1 — planning (now, until the user replies "start"):
- Investigate the project (read files, run read-only commands). edit/write are blocked.
- Ask every clarifying question you have as plain text at the end of your reply.
- Then present a numbered plan under a "Plan:" header and ask the user to reply \`start\`.
- Do NOT implement anything during the planning phase.

Phase 2 — run (after "start"):
- The loop sends one [LOOP n] instruction per iteration. Do exactly that iteration, nothing more.
- Keep .pi/loop/PROGRESS.md updated, and keep test output small (tail/grep).
- End every reply with exactly one status line: \`STATUS: CONTINUE\`, \`STATUS: DONE\` or \`STATUS: BLOCKED\`.
- On STATUS: BLOCKED, list the questions the user must answer as plain text — never use a dialog.

After the planning phase, each iteration carries a git policy line in its [LOOP n] digest (commit/
push/PR are off by default and enabled by the user with /tools). Follow that line; never push or
open a PR unless the digest explicitly allows it.`,
};

interface ModesState {
  mode: Mode;
  toolsBefore?: string[];
  goal?: string;
}

/**
 * Loop phase, written by the loop extension. "idle" until the loop starts; only
 * "plan" restricts loop mode to read-only tools. Session entries are the shared
 * state channel between extensions (each extension is a separate module instance).
 */
function currentLoopPhase(ctx: ExtensionContext): string {
  const saved = ctx.sessionManager
    .getEntries()
    .filter(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "loop",
    )
    .pop() as { data?: { phase?: string } } | undefined;
  return saved?.data?.phase ?? "idle";
}

function toMode(value: unknown): Mode | undefined {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
    ? (value as Mode)
    : undefined;
}

export default function modesExtension(pi: ExtensionAPI): void {
  let mode: Mode = "auto";
  let toolsBefore: string[] | undefined;
  let goal: string | undefined;

  function unique(names: string[]): string[] {
    return [...new Set(names)];
  }

  /** Restrict tools to the read-only set, remembering the previous set. */
  function applyReadOnlyTools(): void {
    const current = pi.getActiveTools();
    if (toolsBefore === undefined) toolsBefore = current;
    const next = unique([...current.filter((name) => !WRITE_TOOLS.has(name)), ...READ_ONLY_TOOLS]);
    pi.setActiveTools(next);
  }

  /** Restore full access once no mode restricts tools. */
  function restoreTools(): void {
    pi.setActiveTools(
      toolsBefore ?? unique([...pi.getActiveTools(), ...WRITE_TOOLS]),
    );
    toolsBefore = undefined;
  }

  function updateIndicator(ctx: ExtensionContext): void {
    const indicator = MODE_INDICATOR[mode];
    const color = mode === "reading" ? "warning" : mode.startsWith("hard") ? "error" : "accent";
    const lines = [ctx.ui.theme.fg(color, indicator.text)];
    if ((mode === "goal" || mode === "hard-goal" || mode === "loop") && goal) {
      lines.push(ctx.ui.theme.fg("muted", `🎯 ${goal}`));
    }
    ctx.ui.setWidget(indicator.key, lines);
  }

  function persist(): void {
    const state: ModesState = { mode, toolsBefore, goal };
    pi.appendEntry("modes", state);
  }

  /** Switch to a mode, applying tools, indicator and persistence. */
  function setMode(next: Mode, ctx: ExtensionContext, notify = true): void {
    if (next === mode) {
      if (notify) ctx.ui.notify(`Already in ${next} mode.`, "info");
      return;
    }

    mode = next;

    if (mode === "reading" || mode === "plan") {
      applyReadOnlyTools();
    } else {
      restoreTools();
    }

    if (notify) {
      const notes: Record<Mode, string> = {
        reading: "Reading mode: edit/write disabled, bash limited to read-only.",
        plan: "Plan mode: edit/write disabled, bash limited to read-only.",
        goal: goal
          ? `Goal mode: full access. Goal: ${goal}`
          : "Goal mode: full access. Set a goal with /goal <text>.",
        "hard-goal": goal
          ? `Hard-goal mode: full access, confirmations bypassed. Goal: ${goal}`
          : "Hard-goal mode: full access, confirmations bypassed. Set a goal with /goal <text>.",
        auto: "Auto mode: full access restored.",
        "hard-auto": "Hard-auto mode: full access, confirmations bypassed.",
        loop: goal
          ? `Loop mode: planning phase (read-only). Goal: ${goal}`
          : "Loop mode: planning phase (read-only). Set a goal with /loop <goal>.",
      };
      ctx.ui.notify(notes[mode], "info");
    }

    updateIndicator(ctx);
    persist();
  }

  function cycle(ctx: ExtensionContext): void {
    const index = MODES.indexOf(mode);
    const next = MODES[(index + 1) % MODES.length]!;
    setMode(next, ctx);
  }

  pi.registerFlag("read", {
    description: "Start in reading mode (read-only)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("loop", {
    description: "Start in loop mode (unattended iteration toward a goal)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("mode", {
    description: "Show the current mode",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Mode: ${mode}${goal ? `\nGoal: ${goal}` : ""}`, "info");
    },
  });

  pi.registerCommand("read", {
    description: "Switch to reading mode (read-only)",
    handler: async (_args, ctx) => setMode("reading", ctx),
  });

  pi.registerCommand("plan", {
    description: "Switch to plan mode (read-only, produce a plan)",
    handler: async (_args, ctx) => setMode("plan", ctx),
  });

  pi.registerCommand("auto", {
    description: "Switch to auto mode (full access)",
    handler: async (_args, ctx) => setMode("auto", ctx),
  });

  pi.registerCommand("loop", {
    description: "Enter loop mode and start planning. Usage: /loop <goal>",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (text) goal = text;

      if (!goal) {
        ctx.ui.notify("No goal set. Usage: /loop <goal>", "info");
        return;
      }

      setMode("loop", ctx);
      updateIndicator(ctx);
      persist();

      // Kick off the planning phase with a hidden user-role message so the loop
      // does not need a second prompt from the user.
      pi.sendMessage(
        {
          customType: "loop-start",
          content:
            `Loop mode is enabled. Goal:\n${goal}\n\n` +
            "Start the loop's planning phase now: investigate the project, then either ask your " +
            'clarifying questions as plain text, or present a numbered plan under a "Plan:" header ' +
            "and ask the user to reply `start`. Do not implement anything yet.",
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("goal", {
    description: "Set/show/clear the goal (switches to goal mode)",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();

      if (text === "") {
        if (!goal) {
          ctx.ui.notify("No goal set. Usage: /goal <text>", "info");
          return;
        }
        ctx.ui.notify(`Goal: ${goal}\nClear it with /goal clear.`, "info");
        return;
      }

      if (text === "clear") {
        goal = undefined;
        ctx.ui.notify("Goal cleared.", "info");
        updateIndicator(ctx);
        persist();
        return;
      }

      goal = text;
      ctx.ui.notify(`Goal set: ${goal}`, "info");
      setMode(mode.startsWith("hard") ? "hard-goal" : "goal", ctx, false);
      updateIndicator(ctx);
      persist();
    },
  });

  pi.registerShortcut(Key.shift("tab"), {
    description: "Cycle modes (reading → plan → goal → hard-goal → auto → hard-auto → loop)",
    handler: async (ctx) => cycle(ctx),
  });

  // Defense in depth: block writes even if a write tool somehow stays active.
  // Loop mode is read-only only during its planning phase (the phase lives in
  // the loop extension's session entry), so this is evaluated per tool call.
  pi.on("tool_call", async (event, ctx) => {
    const restricted =
      mode === "reading" ||
      mode === "plan" ||
      (mode === "loop" && currentLoopPhase(ctx) === "plan");
    if (!restricted) return;

    if (WRITE_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `${mode} mode: ${event.toolName} is disabled. Shift+Tab or /auto to leave ${mode} mode.`,
      };
    }

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason:
            `${mode} mode: bash command blocked (not on the read-only allowlist). ` +
            `Shift+Tab or /auto to leave ${mode} mode.\nCommand: ${command}`,
        };
      }
    }
  });

  pi.on("before_agent_start", async () => {
    if (mode === "auto") return;

    let content = MODE_INSTRUCTION[mode];
    if (mode === "goal" || mode === "hard-goal") {
      content = `${goalContext(goal)}\n\n${content}`;
    } else if (mode === "loop" && goal) {
      // In loop mode an unset goal is not an error: the user's prompt is the goal
      // and loop.ts records it on the first turn, so never tell the model to
      // "set a goal with /goal".
      content = `${goalContext(goal)}\n\n${content}`;
    }

    return {
      message: {
        customType: "mode-context",
        content,
        display: false,
      },
    };
  });

  // Keep only the newest mode/goal context. before_agent_start re-injects the
  // block every turn, so without this it accumulates; in auto mode it is dropped
  // entirely.
  pi.on("context", async (event) => {
    const isModeMessage = (m: unknown): boolean => {
      const msg = m as AgentMessage & { customType?: string; content?: unknown };
      if (msg.customType === "mode-context") return true;
      if (msg.role !== "user") return false;

      const hasMarker = (t: string | undefined) =>
        t !== undefined && (t.includes(CONTEXT_MARKER) || t.includes(GOAL_MARKER));
      const content = msg.content;
      if (typeof content === "string") return hasMarker(content);
      if (Array.isArray(content)) {
        return content.some(
          (c) => c.type === "text" && hasMarker((c as TextContent).text),
        );
      }
      return false;
    };

    const indices = event.messages
      .map((m, i) => (isModeMessage(m) ? i : -1))
      .filter((i) => i >= 0);
    if (indices.length === 0) return;

    const drop = new Set(mode === "auto" ? indices : indices.slice(0, -1));
    if (drop.size === 0) return;

    return { messages: event.messages.filter((_m, i) => !drop.has(i)) };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("read") === true) mode = "reading";
    if (pi.getFlag("loop") === true || process.env.PI_HERNESS_MODE === "loop") mode = "loop";

    const entries = ctx.sessionManager.getEntries();
    const saved = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "modes",
      )
      .pop() as { data?: ModesState } | undefined;

    if (saved?.data) {
      mode = toMode(saved.data.mode) ?? mode;
      toolsBefore = saved.data.toolsBefore ?? toolsBefore;
      goal = saved.data.goal ?? goal;
    }

    if (mode === "reading" || mode === "plan") applyReadOnlyTools();

    // Other extensions read the mode from the "modes" session entry, so make
    // sure it exists even when this session has not switched modes yet (e.g. a
    // session started with --loop).
    if (saved?.data?.mode !== mode) persist();

    updateIndicator(ctx);
  });
}
