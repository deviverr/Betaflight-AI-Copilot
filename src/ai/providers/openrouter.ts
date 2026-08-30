/**
 * OpenRouter via OAuth PKCE.
 *
 * The user clicks Connect, authorises on openrouter.ai, and comes back with a
 * code that this page exchanges for a scoped API key. No client registration,
 * no backend, no key for the user to copy and paste. The user pays OpenRouter
 * directly for their own usage.
 */
import type { AiProvider, ChatRequest, ModelInfo, StreamEvent } from "../types";
import { ProviderError } from "../types";
import { streamChatCompletions } from "../openaiCompat";
import { storage, sessionStore } from "../../core/storage";

const KEY_STORAGE = "bf-copilot.openrouter.key";
const VERIFIER_STORAGE = "bf-copilot.openrouter.verifier";
const BASE_URL = "https://openrouter.ai/api/v1";

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(random.buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(digest) };
}

/** Callback URL is this page itself, with the OAuth params stripped afterwards. */
function callbackUrl(): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class OpenRouterProvider implements AiProvider {
  readonly id = "openrouter";
  readonly label = "OpenRouter";
  readonly description =
    "One-click sign-in with PKCE. Pick from 400+ models. You pay OpenRouter for your own usage.";
  readonly requiresLogin = true;

  private key: string | null = storage.get(KEY_STORAGE);
  private models: ModelInfo[] | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  isAuthenticated(): boolean {
    return Boolean(this.key);
  }

  /** Starts the PKCE redirect. Returns only if the redirect is blocked. */
  async login(): Promise<void> {
    const { verifier, challenge } = await createPkcePair();
    sessionStore.set(VERIFIER_STORAGE, verifier);
    const url = new URL("https://openrouter.ai/auth");
    url.searchParams.set("callback_url", callbackUrl());
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    window.location.href = url.toString();
  }

  logout(): void {
    this.key = null;
    this.models = null;
    storage.remove(KEY_STORAGE);
  }

  /**
   * Called on page load. If we came back from openrouter.ai with a `code`,
   * exchanges it for an API key and cleans the URL.
   */
  async completeLoginFromRedirect(): Promise<boolean> {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return false;

    const verifier = sessionStore.get(VERIFIER_STORAGE);
    sessionStore.remove(VERIFIER_STORAGE);
    history.replaceState({}, "", callbackUrl());
    if (!verifier) {
      throw new ProviderError("OpenRouter sign-in expired. Try connecting again.", this.id);
    }

    const response = await fetch(`${BASE_URL}/auth/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    if (!response.ok) {
      throw new ProviderError(
        `OpenRouter rejected the sign-in: ${response.status} ${await response.text().catch(() => "")}`,
        this.id,
      );
    }
    const { key } = (await response.json()) as { key: string };
    this.key = key;
    storage.set(KEY_STORAGE, key);
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.models) return this.models;
    const response = await fetch(`${BASE_URL}/models`);
    if (!response.ok) throw new ProviderError("Could not load the OpenRouter model list", this.id);
    const { data } = (await response.json()) as {
      data: { id: string; name: string; context_length?: number; supported_parameters?: string[] }[];
    };
    this.models = data
      .map((model) => ({
        id: model.id,
        label: model.name || model.id,
        contextWindow: model.context_length,
        supportsTools: (model.supported_parameters ?? []).includes("tools"),
      }))
      // Tool support is what makes the copilot able to act rather than just talk.
      .sort((a, b) => Number(b.supportsTools) - Number(a.supportsTools) || a.label.localeCompare(b.label));
    return this.models;
  }

  async *chat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (!this.key) throw new ProviderError("Connect to OpenRouter first", this.id, false);
    yield* streamChatCompletions(
      {
        baseUrl: BASE_URL,
        apiKey: this.key,
        providerId: this.id,
        extraHeaders: {
          "HTTP-Referer": window.location.origin,
          "X-Title": "Betaflight AI Copilot",
        },
      },
      request,
    );
  }
}
