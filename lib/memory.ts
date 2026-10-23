/**
 * Shared-memory (~/agentmemory) access for pi.
 *
 * This mirrors ~/agentmemory/bin/memorymap.py so the /agentmemory command works
 * without python3 (the sandbox only ships node). Keep the resolution rules in
 * sync with that script: read PROJECTS.md, then pick the deepest ancestor whose
 * cwd matches the current working directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MEMORY_ROOT = path.join(os.homedir(), "agentmemory");
export const PROJECTS_FILE = path.join(MEMORY_ROOT, "PROJECTS.md");

export interface ProjectMapping {
  cwd: string;
  memdir: string;
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function stripTrailingSlash(p: string): string {
  const stripped = p.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

function unquote(cell: string): string {
  return cell.replace(/^`|`$/g, "").trim();
}

/** Read the cwd -> memory-directory table from PROJECTS.md. */
export function loadMapping(): ProjectMapping[] {
  let text: string;
  try {
    text = fs.readFileSync(PROJECTS_FILE, "utf8");
  } catch {
    return [];
  }

  const mapping: ProjectMapping[] = [];
  for (const raw of text.split("\n")) {
    const cells = raw
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < 2) continue;

    const cwd = unquote(cells[0]);
    const memdir = unquote(cells[1]);
    if (!cwd.startsWith("/") && !cwd.startsWith("~")) continue;
    if (!memdir.includes("agentmemory")) continue;

    mapping.push({
      cwd: stripTrailingSlash(realOrSelf(expandTilde(cwd))),
      memdir: expandTilde(memdir),
    });
  }
  return mapping;
}

/** Deepest ancestor match for cwd, or undefined when PROJECTS.md has no entry. */
export function resolveMemory(cwd: string): string | undefined {
  const target = stripTrailingSlash(realOrSelf(expandTilde(cwd)));
  let best: ProjectMapping | undefined;
  for (const entry of loadMapping()) {
    if (target === entry.cwd || target.startsWith(entry.cwd + "/")) {
      if (!best || entry.cwd.length > best.cwd.length) best = entry;
    }
  }
  return best?.memdir;
}

/** Body of MEMORY.md (the index) for a memory directory. */
export function readIndex(memdir: string): string | undefined {
  try {
    const body = fs.readFileSync(path.join(memdir, "MEMORY.md"), "utf8").trim();
    return body || undefined;
  } catch {
    return undefined;
  }
}

/** Slugs (filenames without .md) of individual memory files. */
export function listMemories(memdir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memdir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")
    .map((e) => e.name.slice(0, -3))
    .sort();
}

/** Read one memory file. Accepts a slug, a filename, or a relative path. */
export function readMemory(memdir: string, ref: string): { file: string; body: string } | undefined {
  const candidates = ref.endsWith(".md") ? [ref] : [`${ref}.md`, ref];
  for (const candidate of candidates) {
    const file = path.resolve(memdir, candidate);
    if (file !== memdir && !file.startsWith(memdir + path.sep)) continue; // no traversal
    try {
      const body = fs.readFileSync(file, "utf8");
      return { file, body };
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export interface MemoryHit {
  memdir: string;
  file: string;
  line: number;
  text: string;
}

/** Case-insensitive substring search across every project's memory files. */
export function searchMemories(query: string, limit = 50): MemoryHit[] {
  const needle = query.toLowerCase();
  if (!needle) return [];

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(MEMORY_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const hits: MemoryHit[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const memdir = path.join(MEMORY_ROOT, dir.name);
    for (const slug of listMemories(memdir)) {
      const file = path.join(memdir, `${slug}.md`);
      let body: string;
      try {
        body = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ memdir, file, line: i + 1, text: lines[i].trim() });
          if (hits.length >= limit) return hits;
        }
      }
    }
  }
  return hits;
}
