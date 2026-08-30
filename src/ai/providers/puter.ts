/**
 * Puter.js — the zero-setup path.
 *
 * Puter runs on a user-pays model: the visitor signs in with their own Puter
 * account and their usage is billed to them, so this app ships no API key and
 * has no backend. Good default for someone who just wants to start talking to
 * their quad.
 */
import type { AiProvider, ChatRequest, ModelInfo, StreamEvent, ToolCall } from "../types";
import { ProviderError } from "../types";
import { toWireMessages, toWireTools } from "../openaiCompat";

const SCRIPT_URL = "https://js.puter.com/v2/";

declare global {
  interface Window {
    puter?: any;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadPuter(): Promise<void> {
  if (window.puter) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load js.puter.com"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

const MODELS: ModelInfo[] = [
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", supportsTools: true },
  { id: "claude-opus-4-1", label: "Claude Opus 4.1", supportsTools: true },
  { id: "gpt-5", label: "GPT-5", supportsTools: true },
  { id: "gpt-5-mini", label: "GPT-5 mini", supportsTools: true },
  { id: "gpt-4.1", label: "GPT-4.1", supportsTools: true },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", supportsTools: true },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", supportsTools: true },
  { id: "deepseek-chat", label: "DeepSeek V3", supportsTools: true },
];

export class PuterProvider implements AiProvider {
  readonly id = "puter";
  readonly label = "Puter (no API key)";
  readonly description =
    "Sign in with a Puter account and use Claude, GPT or Gemini with no API key. " +
    "Usage is billed to your Puter account, not to this app.";
  readonly requiresLogin = true;

  async isAvailable(): Promise<boolean> {
    try {
      await loadPuter();
      return Boolean(window.puter?.ai?.chat);
    } catch {
      return false;
    }
  }

  isAuthenticated(): boolean {
    return Boolean(window.puter?.auth?.isSignedIn?.());
  }

  async login(): Promise<void> {
    await loadPuter();
    if (!window.puter?.auth) throw new ProviderError("Puter.js did not load", this.id);
    await window.puter.auth.signIn();
  }

  logout(): void {
    window.puter?.auth?.signOut?.();
  }

  async listModels(): Promise<ModelInfo[]> {
    return MODELS;
  }

  async *chat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    await loadPuter();
    if (!window.puter?.ai?.chat) throw new ProviderError("Puter.js is unavailable", this.id);

    let response: any;
    try {
      response = await window.puter.ai.chat(toWireMessages(request.messages), {
        model: request.model,
        stream: true,
        tools: toWireTools(request.tools),
        temperature: request.temperature ?? 0.3,
      });
    } catch (error) {
      throw new ProviderError(
        `Puter refused the request: ${error instanceof Error ? error.message : String(error)}`,
        this.id,
      );
    }

    const pendingCalls = new Map<number, ToolCall>();

    // Puter streams async-iterable parts shaped like OpenAI deltas.
    for await (const part of response) {
      if (request.signal?.aborted) break;

      const text = typeof part === "string" ? part : (part?.text ?? part?.delta?.content ?? "");
      if (text) yield { type: "text", delta: text };

      const calls = part?.tool_calls ?? part?.delta?.tool_calls ?? [];
      for (const partial of calls) {
        const index = partial.index ?? pendingCalls.size;
        const existing = pendingCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (partial.id) existing.id = partial.id;
        if (partial.function?.name) existing.name += partial.function.name;
        if (partial.function?.arguments) existing.arguments += partial.function.arguments;
        pendingCalls.set(index, existing);
      }
    }

    for (const call of pendingCalls.values()) {
      if (!call.name) continue;
      yield {
        type: "tool_call",
        call: { ...call, id: call.id || `call_${Math.random().toString(36).slice(2)}`, arguments: call.arguments || "{}" },
      };
    }
    yield { type: "done", finishReason: pendingCalls.size ? "tool_calls" : "stop" };
  }
}
