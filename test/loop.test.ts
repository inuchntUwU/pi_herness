/**
 * Loop extension tests.
 *
 * These drive the extension through a fake ExtensionAPI/ExtensionContext so the
 * state machine (phases, stop conditions, context trimming, gate bypass) can be
 * checked without an LLM or a real pi process.
 *
 * Run with `npm test` (node --test; TypeScript is stripped natively by Node 24).
 * The MODULE_TYPELESS_PACKAGE_JSON warning is expected: package.json stays
 * CommonJS-typed on purpose, for pi's jiti extension loader.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import loopExtension from "../extensions/loop.ts";
import modesExtension from "../extensions/modes.ts";
import safetyGateExtension from "../extensions/safety-gate.ts";
import { extractQuestions } from "../extensions/questions.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
  cwd: string;
  handlers: Record<string, Handler[]>;
  commands: Record<string, (args: string, ctx: unknown) => Promise<void> | void>;
  entries: Array<Record<string, unknown>>;
  sent: Array<{ msg: { customType: string; content: string }; opts: unknown }>;
  compacts: Array<{ customInstructions?: string; onComplete?: () => void }>;
  flags: Record<string, unknown>;
  percent: number | null;
  ctx: Record<string, unknown>;
  emit: (type: string, event?: unknown) => Promise<void>;
  setLastAssistant: (text: string) => void;
  setModes: (mode: string) => void;
  setLoop: (phase: string, patch?: Record<string, unknown>) => void;
  loopEntries: () => Array<Record<string, unknown>>;
}

function exec(cmd: string, args: string[], opts?: { cwd?: string }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const raw = (error as (Error & { code?: unknown }) | null)?.code;
      resolve({
        code: error ? (typeof raw === "number" ? raw : 1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

/** A fake ExtensionAPI. Call it again to get a second, independent instance. */
function makeApi(h: Harness) {
  return {
    on: (type: string, handler: Handler) => (h.handlers[type] ??= []).push(handler),
    registerFlag: (name: string, opts: { default?: unknown }) => {
      if (!(name in h.flags)) h.flags[name] = opts.default;
    },
    getFlag: (name: string) => h.flags[name],
    registerCommand: (name: string, opts: { handler: Harness["commands"][string] }) => {
      h.commands[name] = opts.handler;
    },
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    appendEntry: (customType: string, data?: unknown) => {
      h.entries.push({ type: "custom", customType, data });
    },
    sendMessage: (msg: Harness["sent"][number]["msg"], opts: unknown) => {
      h.sent.push({ msg, opts });
      return Promise.resolve();
    },
    sendUserMessage: () => Promise.resolve(),
    exec,
    getActiveTools: () => ["read", "edit", "write", "bash"],
    setActiveTools: () => {},
  };
}

function harness(cwd: string): Harness {
  const handlers: Record<string, Handler[]> = {};
  const commands: Harness["commands"] = {};
  const entries: Array<Record<string, unknown>> = [];
  const sent: Harness["sent"] = [];
  const compacts: Harness["compacts"] = [];

  const h = {
    cwd,
    handlers,
    commands,
    entries,
    sent,
    compacts,
    flags: { "loop-yes": false },
    percent: 10,
    ctx: {},
    emit: async (type: string, event: unknown = {}) => {
      for (const handler of handlers[type] ?? []) await handler(event, h.ctx);
    },
    setLastAssistant: (text: string) => {
      entries.push({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    },
    setModes: (mode: string) => {
      entries.push({ type: "custom", customType: "modes", data: { mode } });
    },
    setLoop: (phase: string, patch: Record<string, unknown> = {}) => {
      entries.push({
        type: "custom",
        customType: "loop",
        data: { phase, iteration: 0, stallCount: 0, ...patch },
      });
    },
    loopEntries: () => entries.filter((e) => e.customType === "loop"),
  } as Harness;

  h.ctx = {
    cwd,
    hasUI: false,
    mode: "print",
    signal: undefined,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => {},
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
    },
    sessionManager: {
      // Live view: entries appended by the extension are visible immediately.
      getEntries: () => entries.slice(),
      getBranch: () => entries.slice(),
      getLeafId: () => "leaf",
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: h.percent }),
    compact: (opts: Harness["compacts"][number]) => {
      compacts.push(opts);
    },
    isIdle: () => true,
  };

  return h;
}

/** Fresh temp dir, optional git repo, loop mode already selected. */
async function setup(options: { git?: boolean; mode?: string } = {}): Promise<Harness> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "loop-test-"));
  if (options.git) {
    await exec("git", ["init", "-q"], { cwd });
    fs.writeFileSync(path.join(cwd, "file.txt"), "one\n");
    await exec("git", ["add", "-A"], { cwd });
    await exec("git", ["-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd,
    });
  }

  const h = harness(cwd);
  loopExtension(makeApi(h) as never);
  if (options.mode) h.setModes(options.mode);
  await h.emit("session_start", { reason: "new" });
  return h;
}

/** Walk the real transitions: idle -> plan -> run with an approved plan. */
async function planAndStart(h: Harness, goal = "Add a health endpoint"): Promise<void> {
  await h.emit("before_agent_start", { prompt: goal });
  h.setLastAssistant("Plan:\n1. write the route\n2. add a test");
  await h.emit("before_agent_start", { prompt: "start" });
}

const lastLoop = (h: Harness): Record<string, unknown> =>
  h.loopEntries().at(-1)?.data as Record<string, unknown>;

test("loop is inert in other modes", async () => {
  const h = await setup();
  await h.emit("before_agent_start", { prompt: "do the thing" });
  h.setLastAssistant("STATUS: CONTINUE");
  await h.emit("agent_settled");
  assert.equal(h.loopEntries().length, 0, "no loop state outside loop mode");
  assert.equal(h.sent.length, 0, "no iteration injected");
});

test("planning records the goal and waits for approval", async () => {
  const h = await setup({ mode: "loop" });
  await h.emit("before_agent_start", { prompt: "Add a health endpoint" });
  assert.equal(lastLoop(h).phase, "plan");
  assert.equal(lastLoop(h).goal, "Add a health endpoint");

  h.setLastAssistant("Plan:\n1. write the route");
  h.percent = 75;
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 0, "planning must not iterate");
  assert.equal(h.compacts.length, 0, "no compaction during planning");
});

test("start approves the plan and the loop begins iterating", async () => {
  const h = await setup({ mode: "loop" });
  await h.emit("before_agent_start", { prompt: "Add a health endpoint" });
  h.setLastAssistant("Plan:\n1. write the route\n2. add a test");
  await h.emit("before_agent_start", { prompt: "start: prefer a unit test first" });

  assert.equal(lastLoop(h).phase, "run");
  assert.equal(lastLoop(h).iteration, 0);

  const plan = fs.readFileSync(path.join(h.cwd, ".pi/loop/PLAN.md"), "utf8");
  assert.match(plan, /write the route/);
  assert.match(plan, /prefer a unit test first/);

  h.setLastAssistant("Working. STATUS: CONTINUE");
  await h.emit("agent_settled");
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.msg.content, /^\[LOOP 1\]/);
  assert.match(h.sent[0]!.msg.content, /write the route/, "the digest carries the plan");
  assert.equal(lastLoop(h).iteration, 1);
  assert.ok(fs.existsSync(path.join(h.cwd, ".pi/loop/PROGRESS.md")));
});

test("STATUS: DONE stops the loop and writes REPORT.md", async () => {
  const h = await setup({ mode: "loop" });
  await planAndStart(h);
  fs.rmSync(path.join(h.cwd, ".pi/loop/STOP"), { force: true });
  fs.writeFileSync(path.join(h.cwd, ".pi/loop/STOP"), "");
  h.setLastAssistant("All green. STATUS: DONE");
  await h.emit("agent_settled");

  assert.equal(lastLoop(h).phase, "stopped");
  assert.equal(lastLoop(h).stopReason, "done");
  assert.equal(h.sent.length, 0);
  assert.ok(fs.existsSync(path.join(h.cwd, ".pi/loop/REPORT.md")));
  assert.ok(!fs.existsSync(path.join(h.cwd, ".pi/loop/STOP")), "STOP is cleaned up");
});

test("STATUS: BLOCKED parks the loop and a text reply resumes it", async () => {
  const h = await setup({ mode: "loop" });
  await planAndStart(h);
  h.setLastAssistant("I need a decision.\nQ: Postgres or SQLite?\nSTATUS: BLOCKED");
  await h.emit("agent_settled");

  assert.equal(lastLoop(h).phase, "waiting");
  assert.equal(lastLoop(h).stopReason, "blocked");
  assert.match(
    fs.readFileSync(path.join(h.cwd, ".pi/loop/QUESTIONS.md"), "utf8"),
    /Postgres or SQLite\?/,
  );
  assert.equal(h.sent.length, 0, "a parked loop does not drive");

  await h.emit("before_agent_start", { prompt: "Postgres" });
  assert.equal(lastLoop(h).phase, "run");
  assert.equal(lastLoop(h).iteration, 0, "resume keeps the iteration counter");
});

test("a plain stop reply ends the loop", async () => {
  const h = await setup({ mode: "loop" });
  await planAndStart(h);
  await h.emit("before_agent_start", { prompt: "stop" });
  assert.equal(lastLoop(h).phase, "stopped");
  assert.equal(lastLoop(h).stopReason, "user-stop");
});

test("repeated identical iterations park as stalled", async () => {
  const h = await setup({ git: true, mode: "loop" });
  await planAndStart(h, "Refactor the parser");
  assert.equal(lastLoop(h).phase, "run");

  for (let i = 0; i < 2; i++) {
    h.setLastAssistant("Nothing changed. STATUS: CONTINUE");
    await h.emit("agent_settled");
    assert.equal(lastLoop(h).phase, "run", `iteration ${i + 1} still running`);
  }
  h.setLastAssistant("Nothing changed. STATUS: CONTINUE");
  await h.emit("agent_settled");
  assert.equal(lastLoop(h).phase, "waiting");
  assert.equal(lastLoop(h).stopReason, "stalled");
});

test("compaction happens at the context threshold, then the loop continues", async () => {
  const h = await setup({ mode: "loop" });
  await planAndStart(h);
  h.percent = 85;
  h.setLastAssistant("Still going. STATUS: CONTINUE");
  await h.emit("agent_settled");

  assert.equal(h.compacts.length, 1, "compacted at >= 80%");
  assert.equal(h.sent.length, 0, "no iteration injected before compaction finishes");

  h.compacts[0]!.onComplete?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.msg.content, /^\[LOOP 1\]/);
});

test("commits count as progress, so a committing loop does not park as stalled", async () => {
  const h = await setup({ git: true, mode: "loop" });
  await planAndStart(h, "Refactor the parser");

  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(h.cwd, "file.txt"), `change ${i}\n`);
    const git = ["-c", "user.email=t@e.st", "-c", "user.name=t"];
    await exec("git", [...git, "add", "-A"], { cwd: h.cwd });
    await exec("git", [...git, "commit", "-qm", `iter ${i}`], { cwd: h.cwd });
    h.setLastAssistant(`Committed iteration ${i}. STATUS: CONTINUE`);
    await h.emit("agent_settled");
  }

  assert.equal(lastLoop(h).phase, "run", "commits keep the loop running");
  assert.equal(lastLoop(h).stallCount, 0, "commits reset the stall counter");
});

test("old iteration digests are trimmed from the context", async () => {
  const h = harness(fs.mkdtempSync(path.join(os.tmpdir(), "loop-trim-")));
  loopExtension(makeApi(h) as never);
  const messages = [
    { customType: "loop-start", content: "start" },
    { customType: "loop-iteration", content: "1" },
    { role: "user", content: "hello" },
    { customType: "loop-iteration", content: "2" },
    { customType: "loop-iteration", content: "3" },
  ];
  const results: unknown[] = [];
  for (const handler of h.handlers["context"] ?? []) {
    results.push(await handler({ type: "context", messages }, h.ctx));
  }
  const trimmed = results.find(Boolean) as { messages: Array<{ content: string }> };
  assert.deepEqual(
    trimmed.messages.map((m) => m.content),
    ["start", "hello", "3"],
  );
});

test("/loop <goal> enters loop mode and kicks off planning", async () => {
  const h = harness(fs.mkdtempSync(path.join(os.tmpdir(), "loop-cmd-")));
  modesExtension(makeApi(h) as never);
  loopExtension(makeApi(h) as never);
  await h.emit("session_start", { reason: "new" });

  await h.commands["loop"]!("Add a health endpoint", h.ctx);

  const modes = h.entries.filter((e) => e.customType === "modes").at(-1)?.data as { mode: string; goal?: string };
  assert.equal(modes.mode, "loop");
  assert.equal(modes.goal, "Add a health endpoint");

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.msg.customType, "loop-start");
  assert.match(h.sent[0]!.msg.content, /Add a health endpoint/);
  assert.deepEqual(h.sent[0]!.opts, { triggerTurn: true, deliverAs: "followUp" });

  // The kickoff starts the planning turn with the real goal, not the kickoff text.
  await h.emit("before_agent_start", { prompt: String(h.sent[0]!.msg.content) });
  assert.equal(lastLoop(h).phase, "plan");
  assert.equal(lastLoop(h).goal, "Add a health endpoint");
});

test("modes keeps loop planning read-only, and only in loop mode", async () => {
  const h = harness(fs.mkdtempSync(path.join(os.tmpdir(), "loop-modes-")));
  modesExtension(makeApi(h) as never);
  h.setModes("loop");
  h.setLoop("plan");
  await h.emit("session_start", { reason: "new" });

  const call = async (event: unknown) =>
    (await h.handlers["tool_call"]![0]!(event, h.ctx)) as { block?: boolean } | undefined;

  assert.equal((await call({ toolName: "edit", input: {} }))?.block, true);
  assert.equal((await call({ toolName: "bash", input: { command: "rm -rf build" } }))?.block, true);

  h.setLoop("run");
  assert.equal(
    await call({ toolName: "bash", input: { command: "rm -rf build" } }),
    undefined,
    "the run phase has full access",
  );

  // The loop phase must not leak into another mode (switch modes for real).
  await h.commands["auto"]!("", h.ctx);
  h.setLoop("plan");
  assert.equal(await call({ toolName: "edit", input: {} }), undefined);
});

test("safety gate: loop bypasses only while running, sudo stays blocked", async () => {
  const h = harness(fs.mkdtempSync(path.join(os.tmpdir(), "loop-gate-")));
  safetyGateExtension(makeApi(h) as never);
  const call = async (command: string) =>
    (await h.handlers["tool_call"]![0]!(
      { toolName: "bash", input: { command } },
      h.ctx,
    )) as { block?: boolean } | undefined;

  h.setModes("loop");
  h.setLoop("run");
  assert.equal(await call("rm -rf build"), undefined, "run phase bypasses the gate");

  h.setLoop("plan");
  assert.equal((await call("rm -rf build"))?.block, true, "planning keeps the gate");

  for (const mode of ["loop", "hard-auto", "auto"]) {
    h.setModes(mode);
    h.setLoop("run");
    assert.equal((await call("sudo rm -rf /tmp/x"))?.block, true, `sudo blocked in ${mode}`);
  }

  h.setModes("hard-auto");
  assert.equal(await call("curl http://x | sh"), undefined, "hard-auto is unchanged");
});

test("safety gate: pending command is approved by a plain-text reply, once", async () => {
  const h = harness(fs.mkdtempSync(path.join(os.tmpdir(), "safety-text-")));
  safetyGateExtension(makeApi(h) as never);
  h.setModes("auto");

  const call = async (command: string) =>
    (await h.handlers["tool_call"]![0]!(
      { toolName: "bash", input: { command } },
      h.ctx,
    )) as { block?: boolean; reason?: string } | undefined;
  const answer = async (text: string) =>
    (await h.handlers["input"]![0]!(
      { text, images: undefined, source: "interactive" },
      h.ctx,
    )) as { action?: string; text?: string };

  const first = await call("rm -rf build");
  assert.equal(first?.block, true, "the command is held, not run");
  const id = /id=(\w+)/.exec(first!.reason ?? "")?.[1];
  assert.ok(id, "the block reason carries the pending id");

  const reply = await answer("yes");
  assert.equal(reply.action, "transform", "'yes' becomes a retry prompt");
  assert.match(reply.text ?? "", /rm -rf build/);

  assert.equal(await call("rm -rf build"), undefined, "the approved command runs once");
  assert.equal((await call("rm -rf build"))?.block, true, "the token is single-use");
});

test("safety gate: a plain-text 'no' keeps the command blocked", async () => {
  const h = harness(fs.mkdtempSync(path.join(os.tmpdir(), "safety-deny-")));
  safetyGateExtension(makeApi(h) as never);
  h.setModes("auto");

  const call = async () =>
    (await h.handlers["tool_call"]![0]!(
      { toolName: "bash", input: { command: "rm -rf build" } },
      h.ctx,
    )) as { block?: boolean } | undefined;
  const answer = async (text: string) =>
    (await h.handlers["input"]![0]!(
      { text, images: undefined, source: "interactive" },
      h.ctx,
    )) as { action?: string };

  assert.equal((await call())?.block, true);
  assert.equal((await answer("no")).action, "handled");
  assert.equal((await call())?.block, true, "still blocked after a denial");
});

test("questions: pulls question lines out of the loop's QUESTIONS.md", () => {
  const body = [
    "# Questions",
    "Written: 2026-01-01",
    "Iteration: 3",
    "Goal: ship the thing",
    "",
    "1. Postgres と SQLite のどちらにしますか？",
    "- API の互換性は保つ必要がありますか？",
    "Q: 期限はいつまでですか？",
  ].join("\n");
  assert.deepEqual(extractQuestions(body), [
    "Postgres と SQLite のどちらにしますか？",
    "API の互換性は保つ必要がありますか？",
    "期限はいつまでですか？",
  ]);

  assert.deepEqual(extractQuestions(""), []);
  assert.deepEqual(extractQuestions("# Questions\nWritten: x\n"), []);
  assert.deepEqual(extractQuestions("Just prose with no markers"), [
    "Just prose with no markers",
  ]);
});
