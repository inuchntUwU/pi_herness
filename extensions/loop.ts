/**
 * Loop Extension
 *
 * Turns pi into an unattended loop: plan once with the user, then iterate
 * toward the goal until the work is finished or a human decision is needed.
 *
 * The switch lives in modes.ts (the `loop` mode, `/loop <goal>`, `--loop`).
 * This file owns the loop state and the driving, and every handler here returns
 * early unless the current mode is "loop" — no other mode changes behaviour.
 *
 * Phases (kept in `.pi/loop/state.json` and the "loop" session entry):
 *   plan     Planning with the user. modes.ts keeps loop mode read-only while
 *            the phase is "plan" (edit/write blocked, bash allowlisted).
 *   run      Unattended iteration. safety-gate.ts stops asking before dangerous
 *            commands (sudo stays blocked everywhere).
 *   waiting  Parked: the loop asked the user something and is not driving.
 *   stopped  Finished (done, stopped by the user, or stalled).
 *
 * Asking the user, never with a dialog: questions are written to
 * `.pi/loop/QUESTIONS.md`, and the loop stops driving until a normal text
 * message arrives (the user is often away and can only reply in text).
 *
 * Compaction: the plan and progress live on disk, and every iteration starts
 * from a small `[LOOP n]` digest, so nothing important lives only in the
 * context. At the configured context threshold (herness.json `loop.compactPercent`,
 * default 80%) the loop compacts first and then starts the next iteration from
 * the digest.
 *
 * Git policy: commit/push/PR are OFF by default and only enabled by the user
 * (`/tools loop.commit on`, etc). The per-iteration digest is the single source
 * of truth for what the loop may do. When commits are enabled, `diffHash` mixes
 * in the HEAD commit id so a commit still counts as progress for stall detection.
 *
 * Artifacts, all under `.pi/loop/`: PLAN.md, PROGRESS.md, QUESTIONS.md,
 * REPORT.md, state.json, events.jsonl, and STOP (create it to stop the loop).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig, type HernessConfig } from "../lib/config.ts";

type Phase = "idle" | "plan" | "waiting" | "run" | "stopped";
type LoopStatus = "CONTINUE" | "DONE" | "BLOCKED";

interface LoopState {
  phase: Phase;
  goal?: string;
  iteration: number;
  stopReason?: string;
  lastStatus?: LoopStatus;
  stallCount: number;
  lastDiffHash?: string;
  /** `git stash create`/HEAD at loop start, for the user's rollback. */
  baselineRef?: string;
  startedAt?: string;
  updatedAt?: string;
}

const LOOP_DIR = ".pi/loop";
const PLAN_FILE = "PLAN.md";
const PROGRESS_FILE = "PROGRESS.md";
const QUESTIONS_FILE = "QUESTIONS.md";
const REPORT_FILE = "REPORT.md";
const STATE_FILE = "state.json";
const EVENTS_FILE = "events.jsonl";
const STOP_FILE = "STOP";

const START_TYPE = "loop-start";
const ITERATION_TYPE = "loop-iteration";

/** Compact before pi's automatic threshold so the loop re-anchors on its terms. */
/** Consecutive iterations with an unchanged working tree before parking. */
const STALL_LIMIT = 3;
const MAX_PLAN_CHARS = 1400;
const MAX_PROGRESS_CHARS = 900;
const MAX_GOAL_CHARS = 400;
const MAX_UNTRACKED_BYTES = 64 * 1024;

const COMPACT_INSTRUCTIONS =
  "This is a loop-mode iteration boundary. Keep the session goal, the approved plan, the " +
  "progress so far (done/undone steps, files touched, test results), the current failing " +
  "tests, and the next concrete step. Drop tool output details: the plan and progress files " +
  "on disk and the [LOOP n] digests carry the details forward.";

function freshState(): LoopState {
  return { phase: "idle", iteration: 0, stallCount: 0 };
}

interface MessageEntryLike {
  type?: string;
  message?: { role?: string; content?: unknown; usage?: { cost?: { total?: number } } };
}

export default function loopExtension(pi: ExtensionAPI): void {
  let state: LoopState = freshState();
  /** Re-entrancy guard for the settle driver. */
  let driving = false;
  /** True while a proactive compaction is in flight. */
  let compacting = false;
  let autoApprove = false;
  /** Whether the "no git repo, stall detection off" note was already logged. */
  let stallNoteLogged = false;

  // ---------------------------------------------------------------- paths ----

  const dir = (ctx: ExtensionContext): string => path.join(ctx.cwd, LOOP_DIR);
  const file = (ctx: ExtensionContext, name: string): string => path.join(dir(ctx), name);

  function ensureDir(ctx: ExtensionContext): void {
    try {
      fs.mkdirSync(dir(ctx), { recursive: true });
    } catch {
      /* best effort */
    }
  }

  function readText(ctx: ExtensionContext, name: string): string | undefined {
    try {
      return fs.readFileSync(file(ctx, name), "utf8");
    } catch {
      return undefined;
    }
  }

  function writeText(ctx: ExtensionContext, name: string, body: string): void {
    ensureDir(ctx);
    try {
      fs.writeFileSync(file(ctx, name), body);
    } catch {
      /* best effort */
    }
  }

  function log(ctx: ExtensionContext, event: Record<string, unknown>): void {
    ensureDir(ctx);
    try {
      fs.appendFileSync(
        file(ctx, EVENTS_FILE),
        `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
      );
    } catch {
      /* best effort */
    }
  }

  // ---------------------------------------------------------------- state ----

  function persist(ctx: ExtensionContext): void {
    state.updatedAt = new Date().toISOString();
    pi.appendEntry("loop", { ...state });
    ensureDir(ctx);
    try {
      fs.writeFileSync(file(ctx, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      /* best effort */
    }
    updateWidget(ctx);
  }

  /** Latest "loop" session entry, else the state file, else a fresh state. */
  function restore(ctx: ExtensionContext): void {
    const saved = ctx.sessionManager
      .getEntries()
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "loop",
      )
      .pop() as { data?: Partial<LoopState> } | undefined;

    if (saved?.data?.phase) {
      state = { ...freshState(), ...saved.data } as LoopState;
      return;
    }

    const raw = readText(ctx, STATE_FILE);
    if (!raw) return;
    try {
      state = { ...freshState(), ...(JSON.parse(raw) as Partial<LoopState>) } as LoopState;
    } catch {
      /* ignore a corrupt state file */
    }
  }

  /** The mode extension's current mode (session entries are the shared channel). */
  function currentMode(ctx: ExtensionContext): string {
    const saved = ctx.sessionManager
      .getEntries()
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "modes",
      )
      .pop() as { data?: { mode?: string } } | undefined;
    return saved?.data?.mode ?? "auto";
  }

  /**
   * Goal recorded by the mode extension (/loop <goal>, /goal), if any. The
   * interactive kickoff message is not the goal, so prefer this over the prompt.
   */
  function currentGoal(ctx: ExtensionContext): string | undefined {
    const saved = ctx.sessionManager
      .getEntries()
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "modes",
      )
      .pop() as { data?: { goal?: string } } | undefined;
    return saved?.data?.goal;
  }

  const active = (ctx: ExtensionContext): boolean => currentMode(ctx) === "loop";

  // ------------------------------------------------------------- session -----

  function lastAssistantText(ctx: ExtensionContext): string {
    const entries = ctx.sessionManager.getBranch() as unknown as MessageEntryLike[];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
      const text = textOf(entry.message.content);
      if (text.trim()) return text;
    }
    return "";
  }

  function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) =>
        part && (part as { type?: string }).type === "text"
          ? String((part as { text?: string }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }

  function sessionCost(ctx: ExtensionContext): number {
    let total = 0;
    for (const entry of ctx.sessionManager.getEntries() as unknown as MessageEntryLike[]) {
      if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
      const cost = entry.message.usage?.cost?.total;
      if (typeof cost === "number") total += cost;
    }
    return total;
  }

  function parseStatus(text: string): LoopStatus | undefined {
    const matches = text.slice(-4000).match(/STATUS:\s*(DONE|BLOCKED|CONTINUE)/gi);
    if (!matches?.length) return undefined;
    const last = matches[matches.length - 1]!.replace(/STATUS:\s*/i, "").toUpperCase();
    return last as LoopStatus;
  }

  function clip(text: string, max: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, max)}\n… [truncated ${trimmed.length - max} chars]`;
  }

  // --------------------------------------------------------------- widget ----

  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      if (state.phase === "idle" || state.phase === "stopped") {
        ctx.ui.setWidget("loop", undefined);
        return;
      }
      const percent = ctx.getContextUsage()?.percent;
      const label =
        state.phase === "run"
          ? `🔁 loop ${state.iteration}`
          : state.phase === "plan"
            ? "🔁 loop (planning)"
            : "🔁 loop (paused — waiting for you)";
      const detail = [state.goal ? `🎯 ${clip(state.goal, 60)}` : "", percent != null ? `${percent}% ctx` : ""]
        .filter(Boolean)
        .join(" · ");
      ctx.ui.setWidget("loop", [
        ctx.ui.theme.fg("accent", label),
        ...(detail ? [ctx.ui.theme.fg("muted", detail)] : []),
      ]);
    } catch {
      /* UI is optional */
    }
  }

  // ------------------------------------------------------------ artifacts ----

  function planDigest(ctx: ExtensionContext): string {
    const plan = readText(ctx, PLAN_FILE);
    const progress = readText(ctx, PROGRESS_FILE);
    return [
      `Goal: ${clip(state.goal ?? "(not recorded)", MAX_GOAL_CHARS)}`,
      "",
      `Approved plan (${LOOP_DIR}/${PLAN_FILE}):`,
      plan ? clip(plan, MAX_PLAN_CHARS) : "(file is missing — restate the plan in PROGRESS.md)",
      "",
      `Progress (${LOOP_DIR}/${PROGRESS_FILE}):`,
      progress
        ? clip(progress, MAX_PROGRESS_CHARS)
        : "(no progress file yet — create it and keep it up to date)",
    ].join("\n");
  }

  function iterationDigest(ctx: ExtensionContext): string {
    const cfg = resolveConfig(ctx.cwd);
    return [
      `[LOOP ${state.iteration}]`,
      planDigest(ctx),
      "",
      "Do exactly one iteration now: the next unchecked step of the plan. Then:",
      "- run the relevant tests/checks and keep the output small (tail / grep, not full logs);",
      `- update ${LOOP_DIR}/${PROGRESS_FILE} (steps done, decisions, files touched, failing tests);`,
      gitPolicyLine(cfg),
      "- if you need a decision only the user can make, stop and write the questions as plain",
      "  text, then end your reply with exactly: STATUS: BLOCKED",
      "- when the whole plan is finished and verified, end with exactly: STATUS: DONE",
      "- otherwise end with exactly: STATUS: CONTINUE",
    ].join("\n");
  }

  /**
   * What the loop may do with git, derived from the /tools settings. All off by
   * default (cross-agent rule: commit/push/PR are the human's job unless enabled).
   */
  function gitPolicyLine(cfg: HernessConfig): string {
    if (cfg.loop.pr) {
      return (
        "- git: commit each iteration with a clear message, push the working branch, and open a PR " +
        "with `gh pr create` (record the URL in PROGRESS.md). Never amend or force-push, and never " +
        "open a PR from the default branch. If `gh` is missing or there is no remote, skip the PR " +
        "and say so in PROGRESS.md."
      );
    }
    if (cfg.loop.push) {
      return (
        "- git: commit each iteration with a clear message and push the working branch. " +
        "Never amend or force-push."
      );
    }
    if (cfg.loop.commit) {
      return "- git: commit each iteration with a clear message. Never amend, push or open a PR.";
    }
    return "- never commit, amend, push or open a PR — leave the working tree for the user;";
  }

  function ensureProgressFile(ctx: ExtensionContext): void {
    if (readText(ctx, PROGRESS_FILE) !== undefined) return;
    writeText(
      ctx,
      PROGRESS_FILE,
      [
        `# Loop progress`,
        "",
        `Goal: ${state.goal ?? "(unset)"}`,
        "",
        "## Steps",
        "",
        "- [ ] (the loop appends the plan steps and checks them off)",
        "",
        "## Decisions",
        "",
        "## Failing tests / blockers",
        "",
      ].join("\n"),
    );
  }

  async function diffHash(ctx: ExtensionContext): Promise<string | undefined> {
    const opts = { cwd: ctx.cwd, signal: ctx.signal };
    const inside = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], opts);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      if (!stallNoteLogged) {
        stallNoteLogged = true;
        log(ctx, { event: "stall-detection-off", reason: "not a git repository" });
      }
      return undefined;
    }

    const diff = await pi.exec("git", ["diff", "HEAD"], opts);
    const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], opts);
    if (diff.code !== 0) return undefined;

    // Mix in the HEAD commit id so a commit counts as progress even though
    // `git diff HEAD` is empty right after it (otherwise the loop would park as
    // "stalled" while it is actually committing every iteration).
    const head = await pi.exec("git", ["rev-parse", "HEAD"], opts);
    const headId = head.code === 0 ? head.stdout.trim() : "no-head";

    let extra = "";
    let budget = MAX_UNTRACKED_BYTES;
    for (const name of untracked.stdout.split("\n").filter(Boolean).slice(0, 50)) {
      if (name.startsWith(".pi/loop/")) continue;
      try {
        const body = fs.readFileSync(path.join(ctx.cwd, name), "utf8").slice(0, budget);
        budget -= body.length;
        extra += `${name}\n${body}`;
      } catch {
        extra += name;
      }
      if (budget <= 0) break;
    }

    return createHash("sha1").update(headId).update(diff.stdout).update(extra).digest("hex").slice(0, 12);
  }

  /** `git stash create` (or HEAD) at loop start: the user's rollback anchor. */
  async function baselineRef(ctx: ExtensionContext): Promise<string | undefined> {
    const opts = { cwd: ctx.cwd, signal: ctx.signal };
    const stash = await pi.exec("git", ["stash", "create"], opts);
    if (stash.code !== 0) return undefined;
    if (stash.stdout.trim()) return stash.stdout.trim();
    const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], opts);
    return head.code === 0 ? head.stdout.trim() : undefined;
  }

  // ---------------------------------------------------------------- phases ---

  async function approvePlan(ctx: ExtensionContext, plan: string, edits?: string): Promise<void> {
    ensureDir(ctx);
    writeText(
      ctx,
      PLAN_FILE,
      [
        "# Approved loop plan",
        "",
        `Goal: ${state.goal ?? "(unset)"}`,
        `Approved: ${new Date().toISOString()}`,
        "",
        plan.trim() || "(the planning phase produced no text — restate the plan as you go)",
        ...(edits ? ["", "## Adjustments from the user", "", edits.trim()] : []),
      ].join("\n"),
    );

    state.phase = "run";
    state.iteration = 0;
    state.stallCount = 0;
    state.stopReason = undefined;
    state.startedAt = state.startedAt ?? new Date().toISOString();
    state.lastDiffHash = await diffHash(ctx);
    state.baselineRef = await baselineRef(ctx);
    persist(ctx);
    ensureProgressFile(ctx);
    log(ctx, { event: "approved", baselineRef: state.baselineRef });

    if (ctx.hasUI) {
      ctx.ui.notify("Loop approved: the run phase starts now (confirmations bypassed).", "info");
    }
  }

  async function injectNextIteration(ctx: ExtensionContext): Promise<void> {
    state.iteration += 1;
    persist(ctx);
    ensureProgressFile(ctx);
    log(ctx, { event: "iteration", iteration: state.iteration });
    await pi.sendMessage(
      { customType: ITERATION_TYPE, content: iterationDigest(ctx), display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  function finish(ctx: ExtensionContext, reason: string, note?: string): void {
    const previous = state.phase;
    state.phase = "stopped";
    state.stopReason = reason;
    persist(ctx);
    writeReport(ctx, reason, note);
    try {
      fs.rmSync(file(ctx, STOP_FILE), { force: true });
    } catch {
      /* best effort */
    }
    log(ctx, { event: "stopped", reason, from: previous, iteration: state.iteration });
    if (ctx.hasUI) {
      ctx.ui.notify(`🔁 Loop stopped (${reason}). Report: ${LOOP_DIR}/${REPORT_FILE}`, "info");
    }
  }

  function park(ctx: ExtensionContext, reason: string, questions: string): void {
    state.phase = "waiting";
    state.stopReason = reason;
    persist(ctx);
    writeText(
      ctx,
      QUESTIONS_FILE,
      [
        `# Loop paused — needs you (${reason})`,
        `Written: ${new Date().toISOString()}`,
        `Iteration: ${state.iteration}`,
        `Goal: ${state.goal ?? "(unset)"}`,
        "",
        "Reply in plain text to continue the loop. (No dialog is shown on purpose:",
        "you may be away from the terminal. `/loop-resume` also resumes.)",
        "",
        questions.trim() || "(the loop did not leave a question — read the last reply in the session)",
        "",
      ].join("\n"),
    );
    log(ctx, { event: "paused", reason, iteration: state.iteration });

    if (ctx.hasUI) {
      ctx.ui.notify(
        `🔁 Loop paused (${reason}). Questions: ${LOOP_DIR}/${QUESTIONS_FILE}`,
        "warning",
      );
    }
    // Visible in the transcript without starting a turn (no dialogs, no extra LLM call).
    try {
      pi.appendEntry("loop-paused", { reason, iteration: state.iteration });
    } catch {
      /* best effort */
    }
  }

  function writeReport(ctx: ExtensionContext, reason: string, note?: string): void {
    const cost = sessionCost(ctx);
    const progress = readText(ctx, PROGRESS_FILE);
    writeText(
      ctx,
      REPORT_FILE,
      [
        "# Loop report",
        "",
        `- Goal: ${state.goal ?? "(unset)"}`,
        `- Started: ${state.startedAt ?? "(unknown)"}`,
        `- Finished: ${new Date().toISOString()}`,
        `- Iterations: ${state.iteration}`,
        `- Stopped because: ${reason}${note ? ` — ${note}` : ""}`,
        `- Last status: ${state.lastStatus ?? "(none)"}`,
        `- Baseline for rollback: ${state.baselineRef ?? "(no git ref)"}`,
        `- Session cost so far: $${cost.toFixed(4)}`,
        "",
        `## Progress (${LOOP_DIR}/${PROGRESS_FILE})`,
        "",
        progress?.trim() || "(no progress file)",
        "",
      ].join("\n"),
    );
    ensureDir(ctx);
    return;
  }

  /** True when the working tree has been unchanged for STALL_LIMIT iterations. */
  async function stalled(ctx: ExtensionContext): Promise<boolean> {
    const hash = await diffHash(ctx);
    if (hash === undefined) return false;
    if (hash === state.lastDiffHash) {
      state.stallCount += 1;
    } else {
      state.stallCount = 0;
      state.lastDiffHash = hash;
    }
    persist(ctx);
    if (state.stallCount >= STALL_LIMIT) {
      log(ctx, { event: "stall", stallCount: state.stallCount, hash });
      return true;
    }
    return false;
  }

  function startStopRequested(ctx: ExtensionContext): boolean {
    try {
      return fs.existsSync(file(ctx, STOP_FILE));
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- driver ---

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active(ctx) || driving) return;
    if (state.phase !== "plan" && state.phase !== "run") return;

    driving = true;
    try {
      const text = lastAssistantText(ctx);

      if (state.phase === "plan") {
        // Headless runs (`--loop --loop-yes`): approve the plan the agent just
        // presented, then start the run phase. Interactively the user replies
        // "start" and before_agent_start does this instead.
        if (!autoApprove) return;
        await approvePlan(ctx, text);
        await injectNextIteration(ctx);
        return;
      }

      const status = parseStatus(text);
      if (status) {
        state.lastStatus = status;
        persist(ctx);
      }

      if (status === "DONE") {
        finish(ctx, "done");
        return;
      }
      if (status === "BLOCKED") {
        park(ctx, "blocked", text);
        return;
      }
      if (startStopRequested(ctx)) {
        finish(ctx, "stop-file", `${LOOP_DIR}/${STOP_FILE} was created`);
        return;
      }
      if (await stalled(ctx)) {
        park(
          ctx,
          "stalled",
          `The working tree has not changed for ${STALL_LIMIT} iterations ` +
            `(last STATUS: ${status ?? "none"}). Tell me how to proceed, or reply "stop".`,
        );
        return;
      }

      // Re-anchor before the window gets tight: compact first, then continue.
      const percent = ctx.getContextUsage()?.percent;
      const compactPercent = resolveConfig(ctx.cwd).loop.compactPercent;
      if (percent != null && percent >= compactPercent && !compacting) {
        compacting = true;
        log(ctx, { event: "compact-start", percent, iteration: state.iteration });
        const resume = (): void => {
          compacting = false;
          void (async () => {
            if (!active(ctx) || state.phase !== "run") return;
            try {
              await injectNextIteration(ctx);
            } finally {
              /* the next settle drives on */
            }
          })();
        };
        ctx.compact({
          customInstructions: COMPACT_INSTRUCTIONS,
          onComplete: resume,
          onError: (error: Error) => {
            log(ctx, { event: "compact-failed", message: String(error) });
            resume();
          },
        });
        return;
      }

      await injectNextIteration(ctx);
    } finally {
      driving = false;
    }
  });

  // User replies: "start" approves the plan, any message while parked resumes,
  // "stop" ends the loop. All detection is scoped to loop mode.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!active(ctx)) return;

    if (state.phase === "idle") {
      state.phase = "plan";
      state.goal = state.goal ?? currentGoal(ctx) ?? event.prompt.trim();
      state.startedAt = state.startedAt ?? new Date().toISOString();
      ensureDir(ctx);
      persist(ctx);
      log(ctx, { event: "planning", goal: state.goal });
      return;
    }

    const prompt = event.prompt.trim();

    if (state.phase === "plan" || state.phase === "waiting") {
      if (startStopRequested(ctx)) {
        finish(ctx, "stop-file", `${LOOP_DIR}/${STOP_FILE} was created`);
        return;
      }
    }

    if (state.phase === "waiting") {
      // Any reply — an answer to the questions or "start" — resumes the loop.
      state.phase = "run";
      state.stallCount = 0;
      state.lastDiffHash = await diffHash(ctx);
      persist(ctx);
      log(ctx, { event: "resumed", iteration: state.iteration });
      return;
    }

    if (state.phase === "plan") {
      if (!state.goal) state.goal = currentGoal(ctx) ?? prompt;
      const approval = /^\s*start\s*(?::\s*([\s\S]*))?$/i.exec(prompt);
      if (approval) {
        await approvePlan(ctx, lastAssistantText(ctx), approval[1]);
        return;
      }
      persist(ctx);
      return;
    }

    if (state.phase === "run" && /^\s*(stop|halt|止めて|停止)\s*$/i.test(prompt)) {
      finish(ctx, "user-stop");
    }
  });

  // Keep only the newest [LOOP n] digest and the newest planning kickoff: the
  // plan and progress live on disk, so old digests are pure context bloat.
  // Inert when no loop messages exist, i.e. in every other mode.
  pi.on("context", async (event) => {
    const ours = (m: unknown): string | undefined => {
      const type = (m as { customType?: string }).customType;
      return type === ITERATION_TYPE || type === START_TYPE ? type : undefined;
    };
    const indices: Record<string, number[]> = {};
    event.messages.forEach((m, i) => {
      const type = ours(m);
      if (type) (indices[type] ??= []).push(i);
    });
    const drop = new Set<number>();
    for (const list of Object.values(indices)) {
      for (const i of list.slice(0, -1)) drop.add(i);
    }
    if (drop.size === 0) return;
    return { messages: event.messages.filter((_m, i) => !drop.has(i)) };
  });

  // --------------------------------------------------------------- commands --

  pi.registerFlag("loop-yes", {
    description: "Loop mode: approve the plan automatically and start running (headless)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("loop-status", {
    description: "Show the loop state",
    handler: async (_args, ctx) => {
      const percent = ctx.getContextUsage()?.percent;
      ctx.ui.notify(
        [
          `Mode: ${currentMode(ctx)}`,
          `Loop phase: ${state.phase}${state.stopReason ? ` (${state.stopReason})` : ""}`,
          `Iteration: ${state.iteration}`,
          `Goal: ${state.goal ?? "(unset)"}`,
          `Context: ${percent != null ? `${percent}%` : "?"}`,
          `Artifacts: ${LOOP_DIR}/`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("loop-stop", {
    description: "Stop the loop now (same as replying stop, or creating .pi/loop/STOP)",
    handler: async (_args, ctx) => {
      if (state.phase === "idle" || state.phase === "stopped") {
        ctx.ui.notify("No loop is active.", "info");
        return;
      }
      finish(ctx, "user-stop");
      ctx.ui.notify(`🔁 Loop stopped. Report: ${LOOP_DIR}/${REPORT_FILE}`, "info");
    },
  });

  pi.registerCommand("loop-resume", {
    description: "Resume a paused loop without typing an answer",
    handler: async (_args, ctx) => {
      if (!active(ctx)) {
        ctx.ui.notify("Not in loop mode.", "info");
        return;
      }
      if (state.phase !== "waiting") {
        ctx.ui.notify(`Loop is ${state.phase}; nothing to resume.`, "info");
        return;
      }
      state.phase = "run";
      state.stallCount = 0;
      state.lastDiffHash = await diffHash(ctx);
      persist(ctx);
      log(ctx, { event: "resumed", via: "command", iteration: state.iteration });
      await injectNextIteration(ctx);
    },
  });

  // ----------------------------------------------------------------- setup ---

  pi.on("session_start", async (_event, ctx) => {
    autoApprove = pi.getFlag("loop-yes") === true || process.env.PI_LOOP_YES === "1";
    compacting = false;
    driving = false;
    restore(ctx);

    if (state.phase === "run") {
      // A resumed session should not silently restart an unattended loop.
      state.phase = "waiting";
      state.stopReason = "session-resumed";
      persist(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `🔁 Loop paused (session resumed). Reply in text or /loop-resume to continue.`,
          "info",
        );
      }
    } else {
      updateWidget(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (state.phase !== "idle" && state.phase !== "stopped") persist(ctx);
    } catch {
      /* best effort */
    }
    if (ctx.hasUI) {
      try {
        ctx.ui.setWidget("loop", undefined);
      } catch {
        /* best effort */
      }
    }
  });
}
