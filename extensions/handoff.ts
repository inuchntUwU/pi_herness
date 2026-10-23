/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters for the
 * next task and opens a new session seeded with a generated prompt.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *
 * Dialog-free by design: there is no loader overlay and no editor dialog. The
 * prompt is generated in the background and, once the new session exists, dropped
 * into its editor with `setEditorText` so the user can review and submit — from
 * the terminal or the phone.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }
  if (compactionIndex < 0) {
    return branch.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
  }

  const compaction = branch[compactionIndex]!;
  const firstKeptIndex =
    compaction.type === "compaction"
      ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
      : -1;
  const compactedBranch = [
    compaction,
    ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
    ...branch.slice(compactionIndex + 1),
  ];
  return compactedBranch.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
}

export default function handoffExtension(pi: ExtensionAPI): void {
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session (usage: /handoff <goal>)",
    handler: async (args, ctx) => {
      const goal = (args ?? "").trim();
      if (!goal) {
        ctx.ui.notify("使い方: /handoff <新しいスレッドでやりたいこと>", "warning");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("モデルが選択されていません。", "error");
        return;
      }

      const messages = getHandoffMessages(ctx.sessionManager.getBranch());
      if (messages.length === 0) {
        ctx.ui.notify("引き継ぐ会話がありません。", "warning");
        return;
      }

      const conversationText = serializeConversation(convertToLlm(messages));
      const prompt = await buildPrompt(pi, ctx, conversationText, goal);
      if (!prompt) {
        ctx.ui.notify("handoff プロンプトを生成できませんでした。", "error");
        return;
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const result = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (replacementCtx) => {
          replacementCtx.ui.setEditorText(prompt);
          replacementCtx.ui.notify("Handoff ready. 内容を確認して送信してください。", "info");
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("新セッションの作成はキャンセルされました。", "info");
      }
    },
  });
}

/** One-shot model completion that produces the handoff prompt (no UI overlay). */
async function buildPrompt(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  conversationText: string,
  goal: string,
): Promise<string | undefined> {
  ctx.ui.notify("handoff プロンプトを生成中…", "info");
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
      },
    ],
    timestamp: Date.now(),
  };
  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model!,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      { cacheRetention: "none", sessionId: uuidv7() },
    );
    if (response.stopReason === "aborted") return undefined;
    return response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  } catch {
    return undefined;
  }
}
