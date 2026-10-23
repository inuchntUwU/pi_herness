/**
 * Tools & options extension
 *
 * A single, argument-only command for the things we want to turn on/off
 * explicitly. It never opens a dialog: you may be away from the terminal and
 * only able to send text, so every action is expressible as `/tools ...`.
 *
 *   /tools                                  list the current settings
 *   /tools <id> on|off                      set an option (user-wide)
 *   /tools local <id> on|off                set it for this project only
 *   /tools loop.compactPercent <50-98>      numeric options take a value
 *
 * Loop git options (loop.commit / loop.push / loop.pr) default to OFF and are
 * only enabled when turned on explicitly. `pr` implies `push` implies `commit`.
 *
 * Anything that is not a `loop.*` id is treated as a tool name: `on` makes the
 * tool visible again, `off` hides it (adds it to `hiddenTools`). `tool-filter`
 * enforces hidden tools every turn, so a hidden tool stays hidden.
 *
 * Settings live in herness.json, resolved project -> user -> defaults. Writes go
 * to the user-wide file (`~/.pi/agent/herness.json`) by default, so the setting
 * works in every project; `local` writes to `.pi/herness.json` instead.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  LOOP_TOGGLE_IDS,
  type ConfigScope,
  type HernessConfig,
  type LoopToggleId,
  MIN_COMPACT_PERCENT,
  MAX_COMPACT_PERCENT,
  loopTogglePatch,
  resolveConfig,
  writeHiddenTool,
  writeLoopConfig,
} from "../lib/config.ts";

const BOOL_TOGGLE_IDS = new Set<string>(LOOP_TOGGLE_IDS);
const PERCENT_ID = "loop.compactPercent";

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function parseBool(value: string): boolean | undefined {
  const v = value.toLowerCase();
  if (["on", "true", "enable", "enabled", "yes", "1"].includes(v)) return true;
  if (["off", "false", "disable", "disabled", "no", "0"].includes(v)) return false;
  return undefined;
}

function render(pi: ExtensionAPI, cfg: HernessConfig, scope: ConfigScope): string {
  const hidden = new Set(cfg.hiddenTools);
  const active = new Set(pi.getActiveTools());
  const tools = pi
    .getAllTools()
    .map((t) => `  ${t.name.padEnd(16)} ${hidden.has(t.name) ? "off" : "on "}${active.has(t.name) ? "" : " (inactive)"}`)
    .join("\n");

  return [
    `herness config (write scope: ${scope})`,
    "",
    `  loop.compactPercent  ${cfg.loop.compactPercent}`,
    `  loop.commit          ${onOff(cfg.loop.commit)}`,
    `  loop.push            ${onOff(cfg.loop.push)}   (requires commit)`,
    `  loop.pr              ${onOff(cfg.loop.pr)}   (requires push)`,
    "",
    "Tools (on = enabled, off = hidden):",
    tools,
    "",
    "Usage:",
    "  /tools <id> on|off              e.g. /tools loop.pr on",
    `  /tools ${PERCENT_ID} <${MIN_COMPACT_PERCENT}-${MAX_COMPACT_PERCENT}>`,
    "  /tools local <id> on|off        this project only",
  ].join("\n");
}

export default function toolsExtension(pi: ExtensionAPI): void {
  /** Reflect a config change in the live tool set (delta only — never a reset). */
  function applyToolDelta(tool: string, hidden: boolean): void {
    const active = pi.getActiveTools();
    if (hidden) {
      const next = active.filter((name) => name !== tool);
      if (next.length !== active.length) pi.setActiveTools(next);
      return;
    }
    if (!active.includes(tool) && pi.getAllTools().some((t) => t.name === tool)) {
      pi.setActiveTools([...active, tool]);
    }
  }

  pi.registerCommand("tools", {
    description: "Show/set herness options and tool visibility (argument form, no dialog)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      let scope: ConfigScope = "global";
      if (parts[0] === "local" || parts[0] === "project") {
        scope = "project";
        parts.shift();
      }

      if (parts.length === 0) {
        ctx.ui.notify(render(pi, resolveConfig(ctx.cwd), scope), "info");
        return;
      }

      const id = parts[0]!;
      const valueText = parts.slice(1).join(" ");
      const usage = `Usage: /tools ${id} on|off   (or /tools ${PERCENT_ID} <${MIN_COMPACT_PERCENT}-${MAX_COMPACT_PERCENT}>)`;

      // ── loop boolean toggles ──
      if (BOOL_TOGGLE_IDS.has(id)) {
        const on = parseBool(valueText);
        if (on === undefined) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        const file = writeLoopConfig(scope, ctx.cwd, loopTogglePatch(id as LoopToggleId, on));
        const cfg = resolveConfig(ctx.cwd);
        ctx.ui.notify(
          [
            `${id} = ${onOff(on)}`,
            `  loop.commit = ${onOff(cfg.loop.commit)}`,
            `  loop.push   = ${onOff(cfg.loop.push)}`,
            `  loop.pr     = ${onOff(cfg.loop.pr)}`,
            `Saved to ${file}`,
          ].join("\n"),
          on ? "warning" : "info",
        );
        return;
      }

      // ── loop.compactPercent ──
      if (id === PERCENT_ID) {
        const value = Number(valueText);
        if (!Number.isFinite(value)) {
          ctx.ui.notify(usage, "warning");
          return;
        }
        const file = writeLoopConfig(scope, ctx.cwd, { compactPercent: value });
        const cfg = resolveConfig(ctx.cwd);
        ctx.ui.notify(
          `${PERCENT_ID} = ${cfg.loop.compactPercent}\nSaved to ${file}`,
          "info",
        );
        return;
      }

      // ── anything else is a tool name ──
      const on = parseBool(valueText);
      if (on === undefined) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      if (!pi.getAllTools().some((t) => t.name === id)) {
        ctx.ui.notify(`Unknown id or tool: ${id}`, "warning");
        return;
      }
      const file = writeHiddenTool(scope, ctx.cwd, id, !on);
      applyToolDelta(id, !on);
      ctx.ui.notify(`${id} = ${onOff(on)}\nSaved to ${file}`, "info");
    },
  });
}
