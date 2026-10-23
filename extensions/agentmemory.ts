/**
 * /agentmemory command
 *
 * Browse the shared agentmemory for the current project.
 *
 * Usage:
 *   /agentmemory           → show MEMORY.md index + file list
 *   /agentmemory <slug>    → read a specific memory file
 *   /agentmemory search <q> → full-text search across all projects
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  resolveMemory,
  readIndex,
  listMemories,
  readMemory,
  searchMemories,
} from "../lib/memory.ts";
import * as path from "node:path";

export default function agentmemoryExtension(pi: ExtensionAPI): void {
  pi.registerCommand("agentmemory", {
    description: "Browse ~/agentmemory for the current project",
    handler: async (args, ctx) => {
      const memdir = resolveMemory(ctx.cwd);
      if (!memdir) {
        ctx.ui.notify("No agentmemory mapping found for this project.", "warning");
        return;
      }

      const trimmed = args.trim();

      // ── No args: show index (no dialog — you may be away from the terminal) ──
      if (trimmed === "") {
        const index = readIndex(memdir);
        const files = listMemories(memdir);
        const parts: string[] = [];
        if (index) parts.push(index.trim());
        if (files.length > 0) {
          parts.push(`Files:\n${files.map((f) => `  ${f}`).join("\n")}`);
        }

        if (parts.length === 0) {
          ctx.ui.notify("Memory directory is empty.", "info");
          return;
        }

        ctx.ui.notify(`${parts.join("\n\n")}\n\nRead one: /agentmemory <slug>`, "info");
        return;
      }

      // ── Search ──
      if (trimmed.startsWith("search ")) {
        const query = trimmed.slice("search ".length).trim();
        if (!query) {
          ctx.ui.notify("Usage: /agentmemory search <query>", "warning");
          return;
        }
        const hits = searchMemories(query, 30);
        if (hits.length === 0) {
          ctx.ui.notify(`No results for "${query}"`, "info");
          return;
        }
        const items = hits.map(
          (h) =>
            `${path.basename(h.memdir)}/${path.basename(h.file)}:${h.line} ${h.text.slice(0, 80)}`,
        );
        ctx.ui.notify(
          `${hits.length} hit(s) for "${query}":\n${items.join("\n")}\n\nRead one: /agentmemory <slug>`,
          "info",
        );
        return;
      }

      // ── Read specific file ──
      const mem = readMemory(memdir, trimmed);
      if (!mem) {
        ctx.ui.notify(`Memory not found: ${trimmed}`, "warning");
        return;
      }
      const body = mem.body;
      if (body.length < 800) {
        ctx.ui.notify(body, "info");
      } else {
        ctx.ui.notify(
          body.slice(0, 700) + "\n... (truncated — use read to view full)",
          "info",
        );
      }
    },
  });
}
