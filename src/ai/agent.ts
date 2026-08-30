/**
 * The agent loop: stream a completion, run any tools the model called, feed the
 * results back, repeat until the model answers without calling a tool.
 */
import type { AiProvider, ChatMessage, ToolCall } from "./types";
import { TOOL_DEFINITIONS, executeTool, type ToolContext, type ToolResult } from "./tools";

export interface AgentEvent {
  type: "text" | "tool_start" | "tool_end" | "turn_end" | "error";
  text?: string;
  toolName?: string;
  toolArgs?: string;
  result?: ToolResult;
  message?: string;
}

export interface AgentOptions {
  provider: AiProvider;
  model: string;
  supportsTools: boolean;
  systemPrompt: string;
  context: ToolContext;
  /** Guards against a model that keeps calling tools forever. */
  maxIterations?: number;
  signal?: AbortSignal;
}

export async function* runAgent(
  history: ChatMessage[],
  options: AgentOptions,
): AsyncGenerator<AgentEvent, ChatMessage[]> {
  const maxIterations = options.maxIterations ?? 12;
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    ...history.filter((message) => message.role !== "system"),
  ];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (options.signal?.aborted) {
      yield { type: "error", message: "Cancelled." };
      return messages;
    }

    let assistantText = "";
    const toolCalls: ToolCall[] = [];

    try {
      const stream = options.provider.chat({
        messages,
        model: options.model,
        tools: options.supportsTools ? TOOL_DEFINITIONS : undefined,
        signal: options.signal,
      });

      for await (const event of stream) {
        if (event.type === "text") {
          assistantText += event.delta;
          yield { type: "text", text: event.delta };
        } else if (event.type === "tool_call") {
          toolCalls.push(event.call);
        } else if (event.type === "error") {
          yield { type: "error", message: event.message };
          return messages;
        }
      }
    } catch (error) {
      yield { type: "error", message: error instanceof Error ? error.message : String(error) };
      return messages;
    }

    messages.push({
      role: "assistant",
      content: assistantText,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });

    if (!toolCalls.length) {
      yield { type: "turn_end" };
      return messages;
    }

    for (const call of toolCalls) {
      yield { type: "tool_start", toolName: call.name, toolArgs: call.arguments };
      let result: ToolResult;
      try {
        result = await executeTool(call.name, call.arguments, options.context);
      } catch (error) {
        result = {
          content: `Error running ${call.name}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      yield { type: "tool_end", toolName: call.name, result };
      messages.push({
        role: "tool",
        content: result.content,
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  yield {
    type: "error",
    message: `Stopped after ${maxIterations} tool rounds without a final answer.`,
  };
  return messages;
}
