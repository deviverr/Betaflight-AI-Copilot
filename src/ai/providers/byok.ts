/**
 * Bring-your-own-key: any OpenAI-compatible endpoint, plus Anthropic's native
 * API. The escape hatch for people who already have a key, run a local model,
 * or do not want a third party in the loop.
 */
import type { AiProvider, ChatMessage, ChatRequest, ModelInfo, StreamEvent, ToolCall } from "../types";
import { ProviderError } from "../types";
import { streamChatCompletions } from "../openaiCompat";
import { storage } from "../../core/storage";

export interface ByokSettings {
  flavour: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
}

const STORAGE = "bf-copilot.byok";

export const BYOK_PRESETS: { label: string; settings: Omit<ByokSettings, "apiKey"> }[] = [
  {
    label: "Anthropic",
    settings: { flavour: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
  },
  {
    label: "OpenAI",
    settings: { flavour: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
  },
  {
    label: "OpenRouter (key)",
    settings: { flavour: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" },
  },
  {
    label: "Groq",
    settings: { flavour: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  },
  {
    label: "Ollama (local)",
    settings: { flavour: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:14b" },
  },
];

export class ByokProvider implements AiProvider {
  readonly id = "byok";
  readonly label = "Your own API key";
  readonly description =
    "Point the copilot at Anthropic, OpenAI, Groq, OpenRouter or a local Ollama server. " +
    "The key stays in this browser and is sent only to the endpoint you name.";
  readonly requiresLogin = true;

  settings: ByokSettings = this.load();

  private load(): ByokSettings {
    try {
      const raw = storage.get(STORAGE);
      if (raw) return JSON.parse(raw) as ByokSettings;
    } catch {
      // Fall through to defaults.
    }
    return { ...BYOK_PRESETS[0].settings, apiKey: "" };
  }

  save(settings: ByokSettings): void {
    this.settings = settings;
    storage.set(STORAGE, JSON.stringify(settings));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  isAuthenticated(): boolean {
    // A local Ollama server needs no key.
    return Boolean(this.settings.apiKey) || this.settings.baseUrl.includes("localhost");
  }

  async login(): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new ProviderError("Enter an API key and endpoint in Settings", this.id, false);
    }
  }

  logout(): void {
    this.save({ ...this.settings, apiKey: "" });
    storage.remove(STORAGE);
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.settings.flavour === "anthropic") {
      return [
        { id: "claude-opus-4-5", label: "Claude Opus 4.5", supportsTools: true },
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", supportsTools: true },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", supportsTools: true },
      ];
    }
    try {
      const response = await fetch(`${this.settings.baseUrl.replace(/\/$/, "")}/models`, {
        headers: this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {},
      });
      if (!response.ok) throw new Error(String(response.status));
      const { data } = (await response.json()) as { data: { id: string }[] };
      return data.map((model) => ({ id: model.id, label: model.id, supportsTools: true }));
    } catch {
      // Many OpenAI-compatible servers do not expose /models; the configured
      // model id is still usable.
      return [{ id: this.settings.model, label: this.settings.model, supportsTools: true }];
    }
  }

  async *chat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (this.settings.flavour === "anthropic") {
      yield* this.streamAnthropic(request);
      return;
    }
    yield* streamChatCompletions(
      { baseUrl: this.settings.baseUrl, apiKey: this.settings.apiKey, providerId: this.id },
      request,
    );
  }

  private async *streamAnthropic(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const response = await fetch(`${this.settings.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.settings.apiKey,
        "anthropic-version": "2023-06-01",
        // Required for browser-originated calls to the Anthropic API.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: request.model,
        system: system || undefined,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.3,
        stream: true,
        tools: request.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
        messages: toAnthropicMessages(request.messages),
      }),
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(
        `Anthropic API error ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`,
        this.id,
        response.status !== 401,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    let buffer = "";
    let finishReason = "stop";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let event: any;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          blocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
        } else if (event.type === "content_block_delta") {
          if (event.delta?.type === "text_delta") yield { type: "text", delta: event.delta.text };
          if (event.delta?.type === "input_json_delta") {
            const block = blocks.get(event.index);
            if (block) block.json += event.delta.partial_json;
          }
        } else if (event.type === "message_delta" && event.delta?.stop_reason) {
          finishReason = event.delta.stop_reason;
        }
      }
    }

    for (const block of blocks.values()) {
      const call: ToolCall = { id: block.id, name: block.name, arguments: block.json || "{}" };
      yield { type: "tool_call", call };
    }
    yield { type: "done", finishReason };
  }
}

/** Anthropic uses content blocks rather than OpenAI's flat tool message role. */
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: safeParse(call.arguments),
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }

    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
