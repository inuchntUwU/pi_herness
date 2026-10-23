import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import modes from "./extensions/modes.ts";
import agentmemory from "./extensions/agentmemory.ts";
import safetyGate from "./extensions/safety-gate.ts";
import lintOnEdit from "./extensions/lint-on-edit.ts";
import scout from "./extensions/scout.ts";
import gitCheckpoint from "./extensions/git-checkpoint.ts";
import clear from "./extensions/clear.ts";
import memory from "./extensions/memory.ts";
import loop from "./extensions/loop.ts";
import toolFilter from "./extensions/tool-filter.ts";
import tools from "./extensions/tools.ts";
import questions from "./extensions/questions.ts";
import handoff from "./extensions/handoff.ts";
import todo from "./extensions/todo.ts";
import preset from "./extensions/preset.ts";
import bookmark from "./extensions/bookmark.ts";
import sessionName from "./extensions/session-name.ts";

export default function piHernessExtension(pi: ExtensionAPI): void {
  modes(pi);
  agentmemory(pi);
  safetyGate(pi);
  lintOnEdit(pi);
  scout(pi);
  gitCheckpoint(pi);
  clear(pi);
  memory(pi);
  loop(pi);
  toolFilter(pi);
  tools(pi);
  questions(pi);
  handoff(pi);
  todo(pi);
  preset(pi);
  bookmark(pi);
  sessionName(pi);
}
