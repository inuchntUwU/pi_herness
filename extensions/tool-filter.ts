/**
 * Tool Filter Extension
 *
 * Keeps tools we never use out of the active set. pi builds the system prompt's
 * `<tools>` section and the provider's tool list from the active tools, so a
 * hidden tool stops costing context on every request.
 *
 * The hidden set comes from herness.json (`hiddenTools`), so it works in every
 * project and can be changed at runtime with `/tools <name> on|off`. The default
 * hides the remote-pi mesh tools (`agent_send`, `list_peers`, `agent_request`):
 * remote-pi stays installed for its phone remote control, but the mesh is unused
 * here and these three descriptions are pure fixed cost. Hiding them does not
 * affect the remote-control path (the phone app drives the session through the
 * extension, not through these tools).
 *
 * `pi.setActiveTools()` inside `before_agent_start` has the same effect as
 * editing `selectedTools`. The filter is re-checked every turn so another
 * extension restoring a saved tool set cannot bring the tools back.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../lib/config.ts";

export default function toolFilterExtension(pi: ExtensionAPI): void {
  function apply(cwd: string): void {
    const hidden = new Set(resolveConfig(cwd).hiddenTools);
    const current = pi.getActiveTools();
    const next = current.filter((name) => !hidden.has(name));
    if (next.length !== current.length) pi.setActiveTools(next);
  }

  pi.on("session_start", async (_event, ctx: ExtensionContext) => apply(ctx.cwd));
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => apply(ctx.cwd));
}
