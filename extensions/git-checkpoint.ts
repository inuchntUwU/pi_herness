/**
 * Git Checkpoint Extension
 *
 * Takes a lightweight git checkpoint before each turn in the modes that can
 * change files (goal / auto), so the user can rewind later. Nothing here is sent
 * to the model, so it costs no context.
 *
 * At turn_start we record a tree-ish for the current tracked-file state:
 *   - `git stash create` when the tree is dirty (it builds a commit object and
 *     returns its hash without touching the stash list or the working tree)
 *   - `HEAD` when the tree is clean (nothing to stash, and HEAD is the state)
 * On fork we do NOT ask with a dialog (the user may be away). Instead we write a
 * short id to `.pi/herness-checkpoints.json` and tell the user to run
 * `/restore <id>`; the file survives the fork, so the command works in the new
 * session. Restore uses `git restore --source=<ref> --staged --worktree -- :/`
 * so it rewinds the whole repo. (`git stash apply` was tried first but fails
 * when the working tree already contains the checkpoint's changes.)
 *
 * Minimal by design:
 *   - only tracked changes are captured; untracked files are left alone
 *   - nothing is committed or pushed; commit/push stay with the user
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHANGING_MODES = new Set(["goal", "auto"]);
const STORE_FILE = ".pi/herness-checkpoints.json";
const MAX_PENDING = 20;

interface PendingRestore {
  ref: string;
  createdAt: string;
}

type PendingStore = Record<string, PendingRestore>;

/** Mode recorded by the modes extension, or "auto" when none was written yet. */
function currentMode(ctx: ExtensionContext): string {
  const saved = ctx.sessionManager
    .getEntries()
    .filter(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "modes",
    )
    .pop() as { data?: { mode?: string } } | undefined;
  return saved?.data?.mode ?? "auto";
}

export default function gitCheckpointExtension(pi: ExtensionAPI): void {
  // entryId -> tree-ish (stash commit or HEAD) at the turn that started from it.
  const checkpoints = new Map<string, string>();

  const storePath = (ctx: ExtensionContext): string => path.join(ctx.cwd, STORE_FILE);

  function readStore(ctx: ExtensionContext): PendingStore {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(storePath(ctx), "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as PendingStore;
      }
    } catch {
      /* missing or invalid */
    }
    return {};
  }

  function writeStore(ctx: ExtensionContext, store: PendingStore): void {
    try {
      fs.mkdirSync(path.dirname(storePath(ctx)), { recursive: true });
      fs.writeFileSync(storePath(ctx), `${JSON.stringify(store, null, 2)}\n`);
    } catch {
      /* best effort */
    }
  }

  function newId(store: PendingStore): string {
    let id = "";
    do {
      id = Math.random().toString(36).slice(2, 6);
    } while (store[id]);
    return id;
  }

  function prune(store: PendingStore): PendingStore {
    const ids = Object.keys(store);
    if (ids.length <= MAX_PENDING) return store;
    const drop = ids
      .sort((a, b) => (store[a]!.createdAt < store[b]!.createdAt ? -1 : 1))
      .slice(0, ids.length - MAX_PENDING);
    for (const id of drop) delete store[id];
    return store;
  }

  pi.on("session_start", async () => {
    checkpoints.clear();
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!CHANGING_MODES.has(currentMode(ctx))) return;

    const anchor = ctx.sessionManager.getLeafId();
    if (!anchor) return;

    const opts = { cwd: ctx.cwd, signal: ctx.signal };
    const stash = await pi.exec("git", ["stash", "create"], opts);
    if (stash.code !== 0) return; // not a git repo

    let ref = stash.stdout.trim();
    if (!ref) {
      const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], opts);
      if (head.code !== 0) return; // no commits yet
      ref = head.stdout.trim();
    }
    if (ref) checkpoints.set(anchor, ref);
  });

  // No dialog: record the checkpoint and hand the user a /restore command. This
  // works from the phone and survives the fork (the id lives in a file).
  pi.on("session_before_fork", async (event, ctx) => {
    const ref = checkpoints.get(event.entryId);
    if (!ref) return;

    const store = readStore(ctx);
    const id = newId(store);
    store[id] = { ref, createdAt: new Date().toISOString() };
    writeStore(ctx, prune(store));

    ctx.ui.notify(
      `コードをこの時点に戻すには /restore ${id}（戻さないなら無視してください）`,
      "info",
    );
    try {
      pi.appendEntry("checkpoint-pending", { id, ref });
    } catch {
      /* best effort */
    }
  });

  pi.registerCommand("restore", {
    description: "Restore code to a checkpoint (list with no args)",
    handler: async (args, ctx) => {
      const id = (args ?? "").trim();
      const store = readStore(ctx);

      if (!id) {
        const entries = Object.entries(store);
        ctx.ui.notify(
          entries.length === 0
            ? "チェックポイントはありません。"
            : `チェックポイント:\n${entries
                .map(([key, value]) => `  [${key}] ${value.createdAt} (${value.ref.slice(0, 12)})`)
                .join("\n")}\n\n戻す: /restore <id>`,
          "info",
        );
        return;
      }

      const entry = store[id];
      if (!entry) {
        ctx.ui.notify(
          `チェックポイント ${id} はありません。一覧: /restore`,
          "warning",
        );
        return;
      }

      const result = await pi.exec(
        "git",
        ["restore", `--source=${entry.ref}`, "--staged", "--worktree", "--", ":/"],
        { cwd: ctx.cwd, signal: ctx.signal },
      );
      if (result.code === 0) {
        delete store[id];
        writeStore(ctx, store);
        ctx.ui.notify(`コードを ${id} の時点に戻しました。`, "info");
      } else {
        ctx.ui.notify(
          `戻せませんでした (git restore exit ${result.code}):\n${result.stderr.trim()}`,
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    checkpoints.clear();
  });
}
