/**
 * Memory Extension
 *
 * `/memory [focus]` — このセッションでやっていることを共有メモリ
 * (~/agentmemory) に保存させる。
 *
 * コマンド自体はファイルを書かない。「何をどう保存するか」は規約
 * (~/agentmemory/README.md / 各リポジトリの AGENTS.md) に沿ってエージェントが
 * 判断する必要があるため、非表示のカスタムメッセージで指示を注入して
 * ターンを 1 回起こす。保存先ディレクトリはここで解決して渡す。
 *
 * Usage:
 *   /memory                 → このセッションの作業を保存
 *   /memory <focus>         → 保存内容の焦点を指定して保存
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveMemory } from "../lib/memory.ts";

export default function memoryExtension(pi: ExtensionAPI): void {
  pi.registerCommand("memory", {
    description: "Save what we're doing into ~/agentmemory (optional focus hint)",
    handler: async (args, ctx) => {
      const memdir = resolveMemory(ctx.cwd);
      const focus = args.trim() || "the work done in this session";

      const target = memdir
        ? `Target memory directory (already resolved for this cwd): ${memdir}`
        : [
            `No ~/agentmemory/PROJECTS.md entry matches this cwd: ${ctx.cwd}`,
            "Per ~/agentmemory/AGENTS.md, create a directory under ~/agentmemory/ (e.g. a kebab-case slug)",
            "and add one row to ~/agentmemory/PROJECTS.md for it before writing.",
          ].join("\n");

      const content = [
        "[SAVE MEMORY]",
        "The user invoked /memory. Record what we've been doing in this session into the shared agentmemory (~/agentmemory).",
        "",
        target,
        "",
        "Follow the conventions in ~/agentmemory/README.md and this repo's AGENTS.md:",
        "- Read <memdir>/MEMORY.md first, and open any existing file that looks related before writing.",
        "- One topic per file, YAML frontmatter: name (must match the filename slug), description (one line),",
        "  metadata.type one of user | feedback | project | reference.",
        "- Update an existing file instead of creating a duplicate topic.",
        "- Add or update exactly one line in <memdir>/MEMORY.md: `- [Title](file.md) — short hook`.",
        "- Do NOT record what the repo already records (code structure, past fixes, git history, AGENTS.md/CLAUDE.md contents).",
        "- Use absolute dates, and write in normal prose. No relative dates.",
        "- When finished, run: ~/agentmemory/bin/snapshot.sh pi",
        "",
        `Focus: ${focus}`,
      ].join("\n");

      pi.sendMessage(
        { customType: "save-memory", content, display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      ctx.ui.notify(
        `Saving to agentmemory${memdir ? ` (${memdir})` : ""}…`,
        "info",
      );
    },
  });
}
