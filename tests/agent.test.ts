import { describe, it, expect } from "vitest";
import { runAgent } from "../src/ai/agent";
import { executeTool, type ToolContext } from "../src/ai/tools";
import { parseConfig } from "../src/core/config";
import { newChangeSet } from "../src/core/changeset";
import type { AiProvider, ChatRequest, StreamEvent } from "../src/ai/types";

const config = parseConfig("# master\nset p_pitch = 47\nset motor_poles = 14\n");

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    isConnected: () => true,
    getConfig: () => config,
    refreshConfig: async () => config,
    runReadOnlyCli: async (command) => `output of ${command}`,
    readTelemetry: async () => ({
      voltage: 16.4, amperage: 1.2, mahDrawn: 300, rssi: 99,
      cycleTime: 125, i2cErrors: 0, flightModeFlags: 0,
    }),
    getBlackbox: () => null,
    submitChangeSet: async () => "Applied.",
    saveBackup: async () => "bk_1",
    ...overrides,
  };
}

/** Replays a fixed script of stream events, one turn per script entry. */
class ScriptedProvider implements AiProvider {
  readonly id = "scripted";
  readonly label = "Scripted";
  readonly description = "";
  readonly requiresLogin = false;
  turn = 0;
  seen: ChatRequest[] = [];

  constructor(private script: StreamEvent[][]) {}

  async isAvailable() { return true; }
  isAuthenticated() { return true; }
  async login() {}
  logout() {}
  async listModels() { return [{ id: "test", label: "test", supportsTools: true }]; }

  async *chat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.seen.push(request);
    for (const event of this.script[this.turn++] ?? [{ type: "done", finishReason: "stop" }]) {
      yield event;
    }
  }
}

async function collect(generator: AsyncGenerator<any, any>) {
  const events: any[] = [];
  let result = await generator.next();
  while (!result.done) {
    events.push(result.value);
    result = await generator.next();
  }
  return { events, messages: result.value };
}

describe("runAgent", () => {
  it("streams text and stops when the model answers without a tool", async () => {
    const provider = new ScriptedProvider([
      [{ type: "text", delta: "Your " }, { type: "text", delta: "PIDs look fine." }, { type: "done", finishReason: "stop" }],
    ]);
    const { events, messages } = await collect(
      runAgent([{ role: "user", content: "how are my pids" }], {
        provider, model: "test", supportsTools: true, systemPrompt: "sys", context: makeContext(),
      }),
    );

    expect(events.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe(
      "Your PIDs look fine.",
    );
    expect(events.at(-1).type).toBe("turn_end");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "Your PIDs look fine." });
  });

  it("runs a tool, feeds the result back, and continues", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", call: { id: "c1", name: "read_config", arguments: "{}" } },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "text", delta: "Read it." }, { type: "done", finishReason: "stop" }],
    ]);
    const { events, messages } = await collect(
      runAgent([{ role: "user", content: "read my config" }], {
        provider, model: "test", supportsTools: true, systemPrompt: "sys", context: makeContext(),
      }),
    );

    expect(events.some((event) => event.type === "tool_start" && event.toolName === "read_config")).toBe(true);
    expect(messages.some((message: any) => message.role === "tool" && message.toolCallId === "c1")).toBe(true);
    // The second request must carry the tool result.
    expect(provider.seen[1].messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("stops after the iteration cap rather than looping forever", async () => {
    const script = Array.from({ length: 10 }, () => [
      { type: "tool_call", call: { id: "c", name: "read_config", arguments: "{}" } },
      { type: "done", finishReason: "tool_calls" },
    ] as StreamEvent[]);
    const { events } = await collect(
      runAgent([{ role: "user", content: "loop" }], {
        provider: new ScriptedProvider(script),
        model: "test", supportsTools: true, systemPrompt: "sys", context: makeContext(), maxIterations: 3,
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("3 tool rounds") });
  });

  it("omits tool definitions for a model that cannot call them", async () => {
    const provider = new ScriptedProvider([[{ type: "done", finishReason: "stop" }]]);
    await collect(
      runAgent([{ role: "user", content: "hi" }], {
        provider, model: "test", supportsTools: false, systemPrompt: "sys", context: makeContext(),
      }),
    );
    expect(provider.seen[0].tools).toBeUndefined();
  });
});

describe("executeTool", () => {
  it("refuses a CLI command that would write", async () => {
    const result = await executeTool("run_cli", JSON.stringify({ command: "set p_pitch = 60" }), makeContext());
    expect(result.content).toMatch(/not a read-only CLI command/);
  });

  it("refuses a resource assignment disguised as a read", async () => {
    const result = await executeTool("run_cli", JSON.stringify({ command: "resource MOTOR 1 B00" }), makeContext());
    expect(result.content).toMatch(/would write/);
  });

  it("allows read-only inspection", async () => {
    const result = await executeTool("run_cli", JSON.stringify({ command: "get p_pitch" }), makeContext());
    expect(result.content).toBe("output of get p_pitch");
  });

  it("refuses a change set containing a blocked command", async () => {
    const result = await executeTool(
      "propose_changes",
      JSON.stringify({
        title: "spin", summary: "",
        changes: [{ kind: "command", key: "motor", value: "1 1200", reason: "test" }],
      }),
      makeContext(),
    );
    expect(result.content).toMatch(/never-issue list/);
  });

  it("passes a valid change set to the approval gate", async () => {
    let received: any = null;
    const result = await executeTool(
      "propose_changes",
      JSON.stringify({
        title: "raise P", summary: "sharper roll",
        changes: [{ kind: "set", key: "p_pitch", value: "52", reason: "more authority" }],
      }),
      makeContext({
        submitChangeSet: async (changeSet) => {
          received = changeSet;
          return "Applied.";
        },
      }),
    );
    expect(received.changes[0]).toMatchObject({ key: "p_pitch", newValue: "52", oldValue: "47", risk: "safe" });
    expect(result.display).toMatchObject({ kind: "changeset" });
  });

  it("warns the model when the aircraft is armed", async () => {
    const result = await executeTool("read_telemetry", "{}", makeContext({
      readTelemetry: async () => ({
        voltage: 16.4, amperage: 0, mahDrawn: 0, rssi: 0, cycleTime: 125, i2cErrors: 0, flightModeFlags: 1,
      }),
    }));
    expect(result.content).toMatch(/armed: YES/);
  });

  it("reports a missing blackbox log instead of inventing numbers", async () => {
    const result = await executeTool("analyze_blackbox", "{}", makeContext());
    expect(result.content).toMatch(/no blackbox log is loaded/);
  });

  it("handles malformed tool arguments", async () => {
    const result = await executeTool("read_config", "{not json", makeContext());
    expect(result.content).toMatch(/not valid JSON/);
  });

  it("rejects an unknown tool name", async () => {
    const result = await executeTool("launch_missiles", "{}", makeContext());
    expect(result.content).toMatch(/unknown tool/);
  });
});

describe("newChangeSet", () => {
  it("gives every change set a unique id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newChangeSet("t", "", []).id));
    expect(ids.size).toBe(50);
  });
});
