/**
 * Shared streaming client for OpenAI-compatible /chat/completions endpoints.
 * OpenRouter, OpenAI, Groq, Together, LM Studio and Ollama all speak it.
 */
import type { ChatMessage, ChatRequest, StreamEvent, ToolDefinition } from "./types";
import { ProviderError } from "./types";

export interface CompatConfig {
  baseUrl: string;
  apiKey: string;
  providerId: string;
  extraHeaders?: Record<string, string>;
}

export function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

export function toWireTools(tools: ToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export async function* streamChatCompletions(
  config: CompatConfig,
  request: ChatRequest,
): AsyncGenerator<StreamEvent> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...config.extraHeaders,
      },
      body: JSON.stringify({
        model: request.model,
        messages: toWireMessages(request.messages),
        tools: toWireTools(request.tools),
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 4096,
        stream: true,
      }),
    });
  } catch (error) {
    throw new ProviderError(
      `Could not reach ${config.baseUrl}: ${error instanceof Error ? error.message : error}`,
      config.providerId,
    );
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new ProviderError(
      `${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
      config.providerId,
      response.status !== 401 && response.status !== 403,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, StreamingToolCall>();
  let buffer = "";
  let finishReason = "stop";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;

      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // Keep-alive comments and partial frames.
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta ?? {};
      if (delta.content) yield { type: "text", delta: delta.content };

      for (const partial of delta.tool_calls ?? []) {
        const index = partial.index ?? 0;
        const existing = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (partial.id) existing.id = partial.id;
        if (partial.function?.name) existing.name += partial.function.name;
        if (partial.function?.arguments) existing.arguments += partial.function.arguments;
        toolCalls.set(index, existing);
      }
    }
  }

  for (const call of toolCalls.values()) {
    if (!call.name) continue;
    yield {
      type: "tool_call",
      call: { id: call.id || `call_${Math.random().toString(36).slice(2)}`, name: call.name, arguments: call.arguments || "{}" },
    };
  }

  yield { type: "done", finishReason };
}
