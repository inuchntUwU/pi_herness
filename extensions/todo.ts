/**
 * Todo Extension
 *
 * - Registers a `todo` tool so the model can manage a todo list.
 * - Registers `/todos` for the user to view the list (text, no dialog).
 *
 * State lives in the tool results' `details`, not in a file, so branching a
 * session gives the correct todo state for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: "list" | "add" | "toggle" | "clear";
  todos: Todo[];
  nextId: number;
  error?: string;
}

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

function formatTodos(todos: Todo[]): string {
  if (todos.length === 0) return "No todos yet.";
  const done = todos.filter((t) => t.done).length;
  return [
    `${done}/${todos.length} completed`,
    ...todos.map((t) => `${t.done ? "✓" : "○"} #${t.id} ${t.text}`),
  ].join("\n");
}

export default function todoExtension(pi: ExtensionAPI): void {
  let todos: Todo[] = [];
  let nextId = 1;

  // Rebuild from the branch's tool results so branching stays correct.
  const reconstructState = (ctx: ExtensionContext) => {
    todos = [];
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
      const details = msg.details as TodoDetails | undefined;
      if (details) {
        todos = details.todos;
        nextId = details.nextId;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
    parameters: TodoParams,

    async execute(_toolCallId, params) {
      switch (params.action) {
        case "list":
          return {
            content: [
              {
                type: "text",
                text: todos.length
                  ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
                  : "No todos",
              },
            ],
            details: { action: "list", todos: [...todos], nextId } as TodoDetails,
          };

        case "add": {
          if (!params.text) {
            return {
              content: [{ type: "text", text: "Error: text required for add" }],
              details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
            };
          }
          const newTodo: Todo = { id: nextId++, text: params.text, done: false };
          todos.push(newTodo);
          return {
            content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
            details: { action: "add", todos: [...todos], nextId } as TodoDetails,
          };
        }

        case "toggle": {
          if (params.id === undefined) {
            return {
              content: [{ type: "text", text: "Error: id required for toggle" }],
              details: { action: "toggle", todos: [...todos], nextId, error: "id required" } as TodoDetails,
            };
          }
          const todo = todos.find((t) => t.id === params.id);
          if (!todo) {
            return {
              content: [{ type: "text", text: `Todo #${params.id} not found` }],
              details: {
                action: "toggle",
                todos: [...todos],
                nextId,
                error: `#${params.id} not found`,
              } as TodoDetails,
            };
          }
          todo.done = !todo.done;
          return {
            content: [
              { type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` },
            ],
            details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
          };
        }

        case "clear": {
          const count = todos.length;
          todos = [];
          nextId = 1;
          return {
            content: [{ type: "text", text: `Cleared ${count} todos` }],
            details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
          };
        }
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as TodoDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

      const todoList = details.todos;
      switch (details.action) {
        case "list": {
          if (todoList.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
          let out = theme.fg("muted", `${todoList.length} todo(s):`);
          const display = expanded ? todoList : todoList.slice(0, 5);
          for (const t of display) {
            const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
            const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
            out += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
          }
          if (!expanded && todoList.length > 5) {
            out += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
          }
          return new Text(out, 0, 0);
        }
        case "add": {
          const added = todoList[todoList.length - 1]!;
          return new Text(
            theme.fg("success", "✓ Added ") +
              theme.fg("accent", `#${added.id}`) +
              " " +
              theme.fg("muted", added.text),
            0,
            0,
          );
        }
        case "toggle": {
          const text = result.content[0];
          const msg = text?.type === "text" ? text.text : "";
          return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
        }
        case "clear":
          return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
      }
    },
  });

  pi.registerCommand("todos", {
    description: "Show all todos on the current branch",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatTodos(todos), "info");
    },
  });
}
