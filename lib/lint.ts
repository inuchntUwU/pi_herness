/**
 * Lint discovery and execution for the lint-on-edit extension.
 *
 * Resolution order:
 *   1. Explicit config in `.pi/herness.json` (or `~/.pi/agent/herness.json`)
 *   2. Project-local lint scripts inferred from the project files
 *   3. Nothing (extension stays out of the way)
 *
 * Config shape:
 *   { "lint": "npm run lint" }              // single command
 *   { "lint": ["npm run lint", "npm test"] } // multiple commands
 *   { "lint": false }                        // disable for this project
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface LintConfig {
  commands: string[];
}

const CONFIG_FILE = "herness.json";

function readConfigFile(file: string): LintConfig | "disabled" | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const lint = (parsed as { lint?: unknown }).lint;
  if (lint === false) return "disabled";
  if (typeof lint === "string" && lint.trim()) return { commands: [lint.trim()] };
  if (Array.isArray(lint)) {
    const commands = lint.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim());
    if (commands.length > 0) return { commands };
  }
  return undefined;
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function readPackageScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/** Infer lint/test commands from project files when no explicit config exists. */
function inferCommands(dir: string): string[] {
  const commands: string[] = [];
  const scripts = readPackageScripts(dir);

  if (scripts.lint) commands.push("npm run lint");
  if (scripts.test) commands.push("npm test");
  if (commands.length > 0) return commands;

  if (existAny(dir, ["ruff.toml", ".ruff.toml", "pyproject.toml"])) commands.push("ruff check .");
  if (existAny(dir, ["Cargo.toml"])) commands.push("cargo clippy --quiet");
  if (existAny(dir, ["go.mod"])) commands.push("go vet ./...");
  return commands;
}

function existAny(dir: string, names: string[]): boolean {
  return names.some((name) => exists(path.join(dir, name)));
}

/**
 * Resolve the lint commands for a working directory. Returns an empty list when
 * nothing is configured and nothing can be inferred.
 */
export function resolveLintConfig(cwd: string): LintConfig {
  const projectConfig = readConfigFile(path.join(cwd, ".pi", CONFIG_FILE));
  if (projectConfig === "disabled") return { commands: [] };
  if (projectConfig) return projectConfig;

  const userConfig = readConfigFile(path.join(os.homedir(), ".pi", "agent", CONFIG_FILE));
  if (userConfig === "disabled") return { commands: [] };
  if (userConfig) return userConfig;

  return { commands: inferCommands(cwd) };
}

export interface LintRun {
  command: string;
  exitCode: number;
  output: string;
}

export interface LintResult {
  ok: boolean;
  runs: LintRun[];
}

/** Run each command, returning trimmed output. Caller supplies the executor. */
export async function runLintCommands(
  commands: string[],
  exec: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<LintResult> {
  const runs: LintRun[] = [];
  for (const command of commands) {
    const { code, stdout, stderr } = await exec(command);
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    runs.push({ command, exitCode: code, output });
  }
  return { ok: runs.every((r) => r.exitCode === 0), runs };
}

/** Keep only failing runs and truncate each to keep the context small. */
export function formatFailures(result: LintResult, maxBytesPerRun = 4000): string {
  const failures = result.runs.filter((r) => r.exitCode !== 0);
  if (failures.length === 0) return "";

  return failures
    .map((run) => {
      let output = run.output;
      if (Buffer.byteLength(output, "utf8") > maxBytesPerRun) {
        output = output.slice(0, maxBytesPerRun) + "\n... (truncated)";
      }
      return `$ ${run.command}  (exit ${run.exitCode})\n${output || "(no output)"}`;
    })
    .join("\n\n");
}
