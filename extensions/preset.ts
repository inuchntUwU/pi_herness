/**
 * Preset Extension (model / thinking only)
 *
 * Named presets that switch the model and thinking level in one command. Tools
 * and system-prompt instructions are intentionally NOT part of a preset here:
 * modes.ts and tool-filter.ts already own those, and overlapping owners caused
 * confusing state. Dialog-free: `/preset` lists, `/preset <name>` applies.
 *
 * Config files (project overrides global):
 * - ~/.pi/agent/presets.json
 * - <cwd>/.pi/presets.json
 *
 * ```json
 * {
 *   "fast":  { "provider": "openrouter", "model": "anthropic/claude-haiku-4.5", "thinkingLevel": "low" },
 *   "deep":  { "provider": "openrouter", "model": "moonshotai/kimi-k2.6",        "thinkingLevel": "high" }
 * }
 * ```
 *
 * Usage:
 *   /preset              # list presets and the active one
 *   /preset fast         # apply
 *   /preset none         # clear and restore the pre-preset state
 *   pi --preset deep     # start with a preset
 *   Ctrl+Shift+U         # cycle (includes none)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface Preset {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

type PresetsConfig = Record<string, Preset>;

interface OriginalState {
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
}

function loadPresets(cwd: string): PresetsConfig {
  const paths = [join(getAgentDir(), "presets.json"), join(cwd, CONFIG_DIR_NAME, "presets.json")];
  let merged: PresetsConfig = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      merged = { ...merged, ...(JSON.parse(readFileSync(p, "utf-8")) as PresetsConfig) };
    } catch (err) {
      console.error(`Failed to load presets from ${p}: ${err}`);
    }
  }
  return merged;
}

function describe(preset: Preset): string {
  const parts: string[] = [];
  if (preset.provider && preset.model) parts.push(`${preset.provider}/${preset.model}`);
  if (preset.thinkingLevel) parts.push(`thinking:${preset.thinkingLevel}`);
  return parts.join(" | ") || "(empty)";
}

export default function presetExtension(pi: ExtensionAPI): void {
  let presets: PresetsConfig = {};
  let activePresetName: string | undefined;
  let originalState: OriginalState | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "preset",
      activePresetName ? ctx.ui.theme.fg("accent", `preset:${activePresetName}`) : undefined,
    );
  }

  async function applyPreset(name: string, preset: Preset, ctx: ExtensionContext): Promise<void> {
    if (activePresetName === undefined) {
      originalState = { model: ctx.model, thinkingLevel: pi.getThinkingLevel() };
    }
    if (preset.provider && preset.model) {
      const model = ctx.modelRegistry.find(preset.provider, preset.model);
      if (model) {
        const ok = await pi.setModel(model);
        if (!ok) ctx.ui.notify(`preset "${name}": ${preset.provider}/${preset.model} の API キーがありません`, "warning");
      } else {
        ctx.ui.notify(`preset "${name}": モデル ${preset.provider}/${preset.model} が見つかりません`, "warning");
      }
    }
    if (preset.thinkingLevel) pi.setThinkingLevel(preset.thinkingLevel);
    activePresetName = name;
    updateStatus(ctx);
  }

  async function clearPreset(ctx: ExtensionContext): Promise<void> {
    activePresetName = undefined;
    if (originalState) {
      if (originalState.model) await pi.setModel(originalState.model);
      pi.setThinkingLevel(originalState.thinkingLevel);
    }
    updateStatus(ctx);
    ctx.ui.notify("preset を解除しました。", "info");
  }

  function listPresets(ctx: ExtensionContext): void {
    const names = Object.keys(presets);
    if (names.length === 0) {
      ctx.ui.notify(
        `preset が未定義です。${join(getAgentDir(), "presets.json")} を作ってください。`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      [
        "presets:",
        ...names.map((n) => `  ${n === activePresetName ? "*" : " "} ${n} — ${describe(presets[n]!)}`),
        "",
        "適用: /preset <name>   解除: /preset none",
      ].join("\n"),
      "info",
    );
  }

  async function cyclePreset(ctx: ExtensionContext): Promise<void> {
    const names = Object.keys(presets).sort();
    if (names.length === 0) {
      listPresets(ctx);
      return;
    }
    const cycle = ["(none)", ...names];
    const current = activePresetName ?? "(none)";
    const next = cycle[(cycle.indexOf(current) + 1 + cycle.length) % cycle.length]!;
    if (next === "(none)") await clearPreset(ctx);
    else await applyPreset(next, presets[next]!, ctx);
  }

  pi.registerFlag("preset", { description: "Preset configuration to use", type: "string" });

  pi.registerShortcut(Key.ctrlShift("u"), {
    description: "Cycle presets",
    handler: async (ctx) => {
      await cyclePreset(ctx);
    },
  });

  pi.registerCommand("preset", {
    description: "List or apply a model/thinking preset",
    handler: async (args, ctx) => {
      const name = (args ?? "").trim();
      if (!name) {
        listPresets(ctx);
        return;
      }
      if (name === "none") {
        await clearPreset(ctx);
        return;
      }
      const preset = presets[name];
      if (!preset) {
        ctx.ui.notify(`preset "${name}" はありません。一覧: /preset`, "warning");
        return;
      }
      await applyPreset(name, preset, ctx);
      ctx.ui.notify(`preset "${name}" を適用しました。`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    presets = loadPresets(ctx.cwd);

    const flag = pi.getFlag("preset");
    if (typeof flag === "string" && flag) {
      const preset = presets[flag];
      if (preset) await applyPreset(flag, preset, ctx);
      else ctx.ui.notify(`preset "${flag}" はありません。`, "warning");
      updateStatus(ctx);
      return;
    }

    const entry = ctx.sessionManager
      .getEntries()
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "preset-state",
      )
      .pop() as { data?: { name?: string } } | undefined;
    if (entry?.data?.name) activePresetName = entry.data.name;
    updateStatus(ctx);
  });

  pi.on("turn_start", async () => {
    if (activePresetName) pi.appendEntry("preset-state", { name: activePresetName });
  });
}
