/**
 * /questions command
 *
 * Loads the questions the loop parked on (`.pi/loop/QUESTIONS.md`) into the
 * editor so answering is one keystroke instead of copy-paste. No dialog: the
 * editor is pre-filled and the user sends it as a normal prompt, from the
 * terminal or the phone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HEADER_PREFIXES = ["#", "Written:", "Iteration:", "Goal:", "Reply in plain text"];

/** Pull question lines out of the free-form QUESTIONS.md the loop wrote. */
export function extractQuestions(body: string): string[] {
  const lines = body.split("\n");
  const stripped = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    return !HEADER_PREFIXES.some((prefix) => t.startsWith(prefix));
  });

  const questions = stripped
    .map((line) => /^\s*(?:Q[:：]|[-*]|\d+[.)])\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((q): q is string => Boolean(q));

  if (questions.length > 0) return questions;
  // Fallback: the agent wrote prose — answer the whole block.
  return stripped.length > 0 ? [stripped.join("\n").trim()] : [];
}

export default function questionsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("questions", {
    description: "Load .pi/loop/QUESTIONS.md into the editor to answer",
    handler: async (_args, ctx) => {
      const file = path.join(ctx.cwd, ".pi/loop/QUESTIONS.md");
      let body: string;
      try {
        body = fs.readFileSync(file, "utf8");
      } catch {
        ctx.ui.notify("保留中の質問はありません。", "info");
        return;
      }

      const questions = extractQuestions(body);
      if (questions.length === 0) {
        ctx.ui.notify("QUESTIONS.md に質問が見つかりませんでした。", "info");
        return;
      }

      const template = questions.map((q) => `Q: ${q}\nA: `).join("\n\n");
      ctx.ui.setEditorText(template);
      ctx.ui.notify(
        "質問をエディタに入れました。A: を埋めて送信してください。",
        "info",
      );
    },
  });
}
