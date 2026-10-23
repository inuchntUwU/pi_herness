/**
 * Shared configuration for the pi_herness extensions.
 *
 * Resolution order (highest priority first):
 *   1. `.pi/herness.json` in the project (cwd)
 *   2. `~/.pi/agent/herness.json` (user-wide — works in every project)
 *   3. built-in defaults
 *
 * The file also holds the `lint` key used by lint-on-edit (see lib/lint.ts), so
 * writes here merge and preserve unknown keys. `/tools` writes to the user-wide
 * file by default so the same settings apply in every project; `local` scope
 * writes to the project file instead.
 *
 * The loop git options default to OFF. They are only enabled when the user turns
 * them on explicitly (`/tools loop.commit on` etc), keeping the cross-agent rule
 * that commit/push/PR are the human's job by default.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LoopConfig {
  compactPercent: number;
  commit: boolean;
  push: boolean;
  pr: boolean;
}

export interface HernessConfig {
  loop: LoopConfig;
  hiddenTools: string[];
}

export const DEFAULT_LOOP: LoopConfig = {
  compactPercent: 80,
  commit: false,
  push: false,
  pr: false,
};

export const DEFAULT_HIDDEN_TOOLS = ["agent_send", "list_peers", "agent_request"];

export const MIN_COMPACT_PERCENT = 50;
export const MAX_COMPACT_PERCENT = 98;

export type ConfigScope = "global" | "project";

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "herness.json");
}

export function userConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "herness.json");
}

export function configPath(scope: ConfigScope, cwd: string): string {
  return scope === "project" ? projectConfigPath(cwd) : userConfigPath();
}

/** Parse a herness.json file, returning {} for a missing or invalid file. */
export function readRawConfig(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* missing or invalid — treated as empty */
  }
  return {};
}

function clampPercent(value: number): number {
  return Math.min(MAX_COMPACT_PERCENT, Math.max(MIN_COMPACT_PERCENT, Math.round(value)));
}

function applyRaw(target: HernessConfig, raw: Record<string, unknown>): void {
  const loop = raw.loop;
  if (loop && typeof loop === "object" && !Array.isArray(loop)) {
    const l = loop as Record<string, unknown>;
    if (typeof l.compactPercent === "number" && Number.isFinite(l.compactPercent)) {
      target.loop.compactPercent = clampPercent(l.compactPercent);
    }
    if (typeof l.commit === "boolean") target.loop.commit = l.commit;
    if (typeof l.push === "boolean") target.loop.push = l.push;
    if (typeof l.pr === "boolean") target.loop.pr = l.pr;
  }
  if (Array.isArray(raw.hiddenTools)) {
    target.hiddenTools = [
      ...new Set(
        raw.hiddenTools
          .filter((t): t is string => typeof t === "string" && t.trim() !== "")
          .map((t) => t.trim()),
      ),
    ];
  }
}

/** pr implies push implies commit; hand-edited files are normalized the same way. */
export function enforceDependencies(cfg: HernessConfig): void {
  if (cfg.loop.pr) cfg.loop.push = true;
  if (cfg.loop.push) cfg.loop.commit = true;
}

/** Effective config: project overrides user overrides defaults. */
export function resolveConfig(cwd: string): HernessConfig {
  const cfg: HernessConfig = {
    loop: { ...DEFAULT_LOOP },
    hiddenTools: [...DEFAULT_HIDDEN_TOOLS],
  };
  applyRaw(cfg, readRawConfig(userConfigPath()));
  applyRaw(cfg, readRawConfig(projectConfigPath(cwd)));
  enforceDependencies(cfg);
  return cfg;
}

function writeRawConfig(file: string, raw: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Merge a partial loop config into one file, preserving every other key. */
export function writeLoopConfig(
  scope: ConfigScope,
  cwd: string,
  patch: Partial<LoopConfig>,
): string {
  const file = configPath(scope, cwd);
  const raw = readRawConfig(file);
  const loop = (
    raw.loop && typeof raw.loop === "object" && !Array.isArray(raw.loop)
      ? raw.loop
      : {}
  ) as Record<string, unknown>;
  Object.assign(loop, patch);
  raw.loop = loop;
  writeRawConfig(file, raw);
  return file;
}

/** Add/remove a tool from the hidden list in one file. */
export function writeHiddenTool(
  scope: ConfigScope,
  cwd: string,
  tool: string,
  hidden: boolean,
): string {
  const file = configPath(scope, cwd);
  const raw = readRawConfig(file);
  const list = new Set<string>(
    Array.isArray(raw.hiddenTools)
      ? raw.hiddenTools.filter((t): t is string => typeof t === "string")
      : DEFAULT_HIDDEN_TOOLS,
  );
  if (hidden) list.add(tool);
  else list.delete(tool);
  raw.hiddenTools = [...list].sort();
  writeRawConfig(file, raw);
  return file;
}

/**
 * The loop options the user may set. `enable`/`disable` cascade so the
 * pr -> push -> commit dependency holds in the file itself, not only on read.
 */
export const LOOP_TOGGLE_IDS = ["loop.commit", "loop.push", "loop.pr"] as const;
export type LoopToggleId = (typeof LOOP_TOGGLE_IDS)[number];

export function loopTogglePatch(id: LoopToggleId, on: boolean): Partial<LoopConfig> {
  const key = id.slice("loop.".length) as "commit" | "push" | "pr";
  if (on) {
    // Enabling pr also enables push and commit, etc.
    const order = { commit: ["commit"], push: ["commit", "push"], pr: ["commit", "push", "pr"] }[key];
    return Object.fromEntries(order.map((k) => [k, true])) as Partial<LoopConfig>;
  }
  // Disabling commit also disables push and pr, etc.
  const order = { commit: ["commit", "push", "pr"], push: ["push", "pr"], pr: ["pr"] }[key];
  return Object.fromEntries(order.map((k) => [k, false])) as Partial<LoopConfig>;
}
