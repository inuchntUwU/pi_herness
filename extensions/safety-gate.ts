/**
 * Safety Gate Extension
 *
 * Guards dangerous bash commands. pi has no built-in permission prompt, and the
 * old version of this extension used `ctx.ui.select` — which is useless when the
 * user is away from the terminal (the remote-pi phone app does not surface
 * extension dialogs). So the gate is now fully text-based, like loop.ts:
 *
 *   1. A dangerous command is blocked immediately; the block reason tells the
 *      agent to relay a pending id to the user.
 *   2. The user answers in plain text ("yes" / "no") or with a command
 *      (`/safety allow <id>` / `/safety deny <id>`), from the terminal or the
 *      phone. A bare "yes" turns into a retry prompt for the agent.
 *   3. Once approved, the exact command is allowed through once (a one-shot
 *      token); a different command is evaluated again from scratch.
 *
 * Blocked-until-approved patterns:
 *   - rm -rf / rm -r / rm --recursive
 *   - git push --force / -f
 *   - chmod / chown with 777
 *   - shell redirection that overwrites a file (single `>`)
 *   - dd, mkfs
 *   - curl/wget piped into a shell (`curl ... | sh`)
 *
 * `sudo` is never run: the agent has no TTY, so it would fail and risk a
 * faillock. It is handed to the user instead and is NOT approvable here.
 *
 * The hard-goal / hard-auto modes (see modes.ts) bypass these confirmations
 * entirely. Loop mode does the same, but only while the loop is running: during
 * its planning phase the gate stays on. sudo stays blocked in every mode.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface DangerousRule {
  label: string;
  pattern: RegExp;
}

interface Pending {
  id: string;
  command: string;
  label: string;
  createdAt: number;
}

const SUDO_RULE: DangerousRule = {
  label: "sudo (no TTY — hand to the user)",
  pattern: /(^|[\s;&|(])sudo(\s|$)/i,
};

const DANGEROUS_RULES: DangerousRule[] = [
  { label: "recursive delete (rm -rf/-r)", pattern: /\brm\s+(-[a-z]*r[a-z]*|--recursive)\b/i },
  { label: "force push (git push --force/-f)", pattern: /\bgit\s+push\b[^\n|;&]*\s(--force(-with-lease)?(=|\s|$)|-[a-z]*f[a-z]*\b)/i },
  { label: "permissive mode (chmod/chown 777)", pattern: /\b(chmod|chown)\b[^\n|;&]*\b777\b/ },
  { label: "file overwrite redirect (>)", pattern: /(^|[^<])>(?!>)/ },
  { label: "raw disk write (dd/mkfs)", pattern: /\b(dd|mkfs(\.\w+)?)\b/i },
  { label: "pipe to shell (curl/wget | sh)", pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?)\b/i },
];

const APPROVE_RE = /^\s*(y|yes|ok|okay|allow|approve|はい)\s*$/i;
const DENY_RE = /^\s*(n|no|deny|reject|いいえ|だめ|ダメ)\s*$/i;
const PENDING_TTL_MS = 30 * 60 * 1000;

function findDangerousRule(command: string): DangerousRule | undefined {
  return DANGEROUS_RULES.find((rule) => rule.pattern.test(command));
}

function hasSudo(command: string): boolean {
  return SUDO_RULE.pattern.test(command);
}

/**
 * Current mode, read from the latest "modes" session entry (defaults to "auto").
 * pi loads each extension in a separate module instance, so session entries are
 * the shared state channel between extensions.
 */
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
 * Loop phase, from the latest "loop" session entry (written by loop.ts).
 * "idle" when no loop has started in this session.
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

/**
 * hard-goal / hard-auto bypass the confirmation gate. Loop mode bypasses it only
 * while the loop is running (phase "run"), never during planning. sudo is handled
 * before this check, so it stays blocked regardless.
 */
function isHardMode(mode: string, loopPhase: string): boolean {
  return (
    mode === "hard-goal" || mode === "hard-auto" || (mode === "loop" && loopPhase === "run")
  );
}

export default function safetyGateExtension(pi: ExtensionAPI): void {
  // Allow users to skip the gate for the rest of the session.
  let disabled = false;
  // The sudo policy is static; inject it once per session instead of every turn
  // so it does not accumulate in the context.
  let sudoPolicySent = false;
  // Dangerous commands waiting for a text answer, keyed by their short id.
  let pending = new Map<string, Pending>();
  // Exact commands approved once (consumed by the next matching tool_call).
  let approved = new Set<string>();

  function newId(): string {
    let id = "";
    do {
      id = Math.random().toString(36).slice(2, 6);
    } while (pending.has(id));
    return id;
  }

  function livePending(): Pending[] {
    const now = Date.now();
    for (const [id, p] of pending) {
      if (now - p.createdAt > PENDING_TTL_MS) pending.delete(id);
    }
    return [...pending.values()];
  }

  function retryPrompt(p: Pending): string {
    return (
      "危険コマンドの実行が承認されました。次のコマンドを変更せず、そのまま一度だけ実行してください:\n\n" +
      "```\n" +
      p.command +
      "\n```"
    );
  }

  function listPending(prompt: string): string {
    return (
      `保留中の危険コマンド:\n` +
      livePending()
        .map((p) => `  [${p.id}] (${p.label}) ${p.command}`)
        .join("\n") +
      `\n\n${prompt}`
    );
  }

  /** Resolve a pending entry from a command: approve (one-shot token) or deny. */
  function resolve(ctx: ExtensionContext, p: Pending, allow: boolean): void {
    pending.delete(p.id);
    if (allow) {
      approved.add(p.command);
      ctx.ui.notify(`Approved [${p.id}]: ${p.command}`, "info");
      if (ctx.isIdle()) pi.sendUserMessage(retryPrompt(p));
      else pi.sendUserMessage(retryPrompt(p), { deliverAs: "steer" });
    } else {
      ctx.ui.notify(`Denied [${p.id}]. The command will not run.`, "info");
    }
  }

  pi.registerCommand("safety", {
    description: "Dangerous-command gate: on|off, or allow/deny a pending command",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const [verb, id] = trimmed.split(/\s+/);

      if (!trimmed) {
        const pend = livePending();
        ctx.ui.notify(
          [
            `Safety gate is ${disabled ? "OFF" : "ON"}.`,
            pend.length
              ? `Pending:\n${pend.map((p) => `  [${p.id}] (${p.label}) ${p.command}`).join("\n")}`
              : "No pending commands.",
            "Usage: /safety on | /safety off | /safety allow <id> | /safety deny <id>",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (verb === "off") {
        disabled = true;
        ctx.ui.notify("Safety gate OFF: dangerous commands run without confirmation.", "warning");
        return;
      }
      if (verb === "on") {
        disabled = false;
        ctx.ui.notify("Safety gate ON: dangerous commands ask for confirmation.", "info");
        return;
      }

      if (verb === "allow" || verb === "deny") {
        const p = id
          ? pending.get(id)
          : livePending().length === 1
            ? livePending()[0]
            : undefined;
        if (!p) {
          ctx.ui.notify(
            id ? `No pending command with id ${id}.` : listPending("Specify an id."),
            "warning",
          );
          return;
        }
        resolve(ctx, p, verb === "allow");
        return;
      }

      ctx.ui.notify("Usage: /safety on | /safety off | /safety allow <id> | /safety deny <id>", "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    // sudo never runs here: no TTY, guaranteed failure, faillock risk.
    // Hand the exact command to the user instead. Not approvable, not disabled by
    // /safety off.
    if (hasSudo(command)) {
      ctx.ui.notify(
        `sudo が必要なコマンドです。実行せず実端末で実行してください:\n\n  ${command}`,
        "warning",
      );
      return {
        block: true,
        reason:
          "sudo cannot run inside pi (no TTY, would fail and risk a faillock). " +
          "Do not retry. Tell the user to run this command in a real terminal:\n" +
          command,
      };
    }

    if (disabled) return undefined;

    // Hard modes pre-approve every dangerous pattern; sudo is already handled above.
    if (isHardMode(currentMode(ctx), currentLoopPhase(ctx))) return undefined;

    const rule = findDangerousRule(command);
    if (!rule) return undefined;

    // A previously approved command is allowed exactly once.
    if (approved.has(command)) {
      approved.delete(command);
      return undefined;
    }

    const entry: Pending = {
      id: newId(),
      command,
      label: rule.label,
      createdAt: Date.now(),
    };
    pending.set(entry.id, entry);

    ctx.ui.notify(
      `⚠️  危険コマンドを保留しました [${entry.id}] (${rule.label})\n\n  ${command}\n\n` +
        `承認: /safety allow ${entry.id} か "yes" と返信\n拒否: /safety deny ${entry.id} か "no" と返信`,
      "warning",
    );

    return {
      block: true,
      reason:
        `Dangerous command held for user approval [id=${entry.id}] (${rule.label}). ` +
        "Do not retry it on your own. Tell the user, in your reply, the exact command and that they " +
        `can approve it with \`/safety allow ${entry.id}\` or by replying "yes", and deny it with ` +
        `\`/safety deny ${entry.id}\` or "no". Then stop.\nCommand: ${command}`,
    };
  });

  // Plain-text answers: "yes" approves (and becomes a retry prompt), "no" denies.
  // Works from the terminal and from the phone (source "extension" via remote-pi).
  pi.on("input", async (event, ctx) => {
    const pend = livePending();
    if (pend.length === 0) return { action: "continue" };

    const text = event.text ?? "";
    const tokens = text.trim().toLowerCase().split(/\s+/);
    const byId = pend.find((p) => tokens.includes(p.id));
    const approve = APPROVE_RE.test(text);
    const deny = DENY_RE.test(text);
    if (!approve && !deny && !byId) return { action: "continue" };

    const target = byId ?? (pend.length === 1 ? pend[0]! : undefined);
    if (!target) {
      ctx.ui.notify(listPending("複数保留中です。id を指定してください。"), "warning");
      return { action: "handled" };
    }

    const allow = approve || byId ? !deny : false;
    pending.delete(target.id);
    if (allow) {
      approved.add(target.command);
      // Turn the answer into a retry prompt: the agent then re-runs the command,
      // and the one-shot token lets it through.
      ctx.ui.notify(`Approved [${target.id}]: ${target.command}`, "info");
      return { action: "transform", text: retryPrompt(target), images: event.images };
    }
    ctx.ui.notify(`Denied [${target.id}]. The command will not run.`, "info");
    return { action: "handled" };
  });

  // Tell the agent up front not to reach for sudo. Inject once per session: the
  // policy does not change, so repeating it every turn only wastes context.
  pi.on("before_agent_start", async () => {
    if (sudoPolicySent) return;
    sudoPolicySent = true;
    return {
      message: {
        customType: "safety-gate-context",
        content:
          "[SUDO POLICY]\n" +
          "sudo cannot run inside pi (no TTY; it fails and can trigger a faillock lockout). " +
          "Do NOT run sudo. When a task needs elevated privileges, give the user the exact command " +
          "to run in a real terminal and continue with what you can do without it.",
        display: false,
      },
    };
  });

  pi.on("session_start", async () => {
    sudoPolicySent = false;
    pending = new Map();
    approved = new Set();
  });
}
