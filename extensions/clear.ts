/**
 * Clear Extension
 *
 * `/clear` — Claude Code 風に会話を消して新しいセッションを開始する。
 *
 * pi の組み込み `/new` は内部的に新セッションの作成（interactive-mode の
 * handleClearCommand → runtimeHost.newSession）を行い、これが Claude Code の
 * `/clear` とほぼ同じ挙動になる。違いは名前だけなので、ここで `/clear` を
 * 登録して同じ操作を提供する。
 *
 * 挙動:
 * - 現在のセッションはそのまま保存され、`/resume` から復帰できる（履歴は消えない）。
 * - 新しいセッションは同じ cwd / モデル / プロジェクト設定で始まる。
 * - セッションが切り替わるため、modes のモードと /goal はリセットされる（auto に戻る）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clearExtension(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Clear the conversation and start a new session (like Claude Code's /clear)",
    handler: async (_args, ctx) => {
      await ctx.newSession({
        withSession: async (ctx) => {
          ctx.ui.notify("✓ Cleared — started a new session.", "info");
        },
      });
    },
  });
}
