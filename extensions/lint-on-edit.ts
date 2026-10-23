/**
 * Lint on Edit Extension
 *
 * Runs the project's lint/test commands after the agent edits or writes files,
 * and feeds back only the failing output. This keeps the model honest without
 * dumping passing noise into the context.
 *
 * Commands come from `.pi/herness.json` (`"lint": "..."`), the user-level
 * `~/.pi/agent/herness.json`, or are inferred from the project (npm scripts,
 * ruff, cargo, go). With no config and nothing to infer, the extension is a
 * no-op.
 *
 * Runs are debounced: rapid edits in one turn trigger a single run after the
 * turn settles.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { formatFailures, resolveLintConfig, runLintCommands } from "../lib/lint.ts";

const DEBOUNCE_MS = 1500;

export default function lintOnEditExtension(pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  async function runLint(ctx: ExtensionContext): Promise<void> {
    if (running) {
      pending = true;
      return;
    }
    running = true;

    const { commands } = resolveLintConfig(ctx.cwd);
    if (commands.length === 0) {
      running = false;
      return;
    }

    ctx.ui.setWidget("lint", [ctx.ui.theme.fg("muted", "⟳ lint…")]);

    const result = await runLintCommands(commands, async (command) => {
      const r = await pi.exec("bash", ["-lc", command], { cwd: ctx.cwd });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    });

    running = false;

    if (result.ok) {
      ctx.ui.setWidget("lint", [ctx.ui.theme.fg("success", "✓ lint")]);
      setTimeout(() => ctx.ui.setWidget("lint", undefined), 2000);
    } else {
      ctx.ui.setWidget("lint", [ctx.ui.theme.fg("error", "✗ lint failed")]);
      const body = formatFailures(result);
      pi.sendMessage(
        {
          customType: "lint-failures",
          content: `Lint/test failed after your edit. Fix these before continuing:\n\n${body}`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }

    if (pending) {
      pending = false;
      void runLint(ctx);
    }
  }

  function schedule(ctx: ExtensionContext): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void runLint(ctx);
    }, DEBOUNCE_MS);
  }

  pi.on("tool_result", async (event, ctx) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return undefined;
    if (event.isError) return undefined;
    schedule(ctx);
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    clearTimer();
  });
}
