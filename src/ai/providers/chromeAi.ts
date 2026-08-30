/**
 * Chrome's built-in Gemini Nano, via the Prompt API.
 *
 * No login, no key, no network — but the model is small and has no tool
 * calling, so the copilot falls back to advisory mode: it can read and explain
 * a config, and it can suggest CLI lines, but it cannot drive the tool loop.
 */
import type { AiProvider, ChatRequest, ModelInfo, StreamEvent } from "../types";
import { ProviderError } from "../types";

declare global {
  // eslint-disable-next-line no-var
  var LanguageModel: any | undefined;
}

export class ChromeAiProvider implements AiProvider {
  readonly id = "chrome-ai";
  readonly label = "Chrome built-in (offline)";
  readonly description =
    "Gemini Nano running inside Chrome. No account, no key, works offline. " +
    "Small model with no tool calling, so it advises rather than acts.";
  readonly requiresLogin = false;

  private session: any = null;

  async isAvailable(): Promise<boolean> {
    if (typeof LanguageModel === "undefined") return false;
    try {
      const availability = await LanguageModel.availability();
      return availability !== "unavailable";
    } catch {
      return false;
    }
  }

  isAuthenticated(): boolean {
    return typeof LanguageModel !== "undefined";
  }

  async login(): Promise<void> {
    if (typeof LanguageModel === "undefined") {
      throw new ProviderError(
        "This Chrome build has no Prompt API. Enable chrome://flags/#prompt-api-for-gemini-nano.",
        this.id,
        false,
      );
    }
    // Triggers the on-device model download if it has not happened yet.
    await LanguageModel.create();
  }

  logout(): void {
    this.session?.destroy?.();
    this.session = null;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "gemini-nano", label: "Gemini Nano (on-device)", supportsTools: false }];
  }

  async *chat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (typeof LanguageModel === "undefined") {
      throw new ProviderError("Chrome's Prompt API is not available here", this.id, false);
    }

    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const session = await LanguageModel.create({
      initialPrompts: system ? [{ role: "system", content: system }] : undefined,
    });

    // Nano has a small context window, so only the tail of the conversation fits.
    const prompt = request.messages
      .filter((message) => message.role !== "system")
      .slice(-8)
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n\n");

    try {
      const stream = session.promptStreaming(prompt, { signal: request.signal });
      let previous = "";
      for await (const chunk of stream) {
        // Older Chrome builds stream cumulative text rather than deltas.
        const delta = chunk.startsWith(previous) ? chunk.slice(previous.length) : chunk;
        previous = chunk.startsWith(previous) ? chunk : previous + chunk;
        if (delta) yield { type: "text", delta };
      }
      yield { type: "done", finishReason: "stop" };
    } finally {
      session.destroy?.();
    }
  }
}
