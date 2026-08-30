import { createApp } from "vue";
import App from "./App.vue";
import "./styles/app.css";
import { providers, refreshProviderState, selectProvider, pushSystem } from "./core/store";
import type { OpenRouterProvider } from "./ai/providers/openrouter";

/**
 * OpenRouter's PKCE flow returns the user to this page with a `?code=`. Handle
 * that before the app mounts so the URL is clean by the time anything renders.
 */
async function completeOAuth(): Promise<void> {
  const openrouter = providers.openrouter as OpenRouterProvider;
  try {
    if (await openrouter.completeLoginFromRedirect()) {
      await selectProvider("openrouter");
      pushSystem("Connected to OpenRouter.");
    }
  } catch (error) {
    pushSystem(error instanceof Error ? error.message : String(error), "error");
  }
}

completeOAuth()
  .then(refreshProviderState)
  .finally(() => {
    createApp(App).mount("#app");
  });

if (import.meta.env.DEV) {
  // Development affordance: lets the screenshot tooling and manual debugging
  // drive the app without a flight controller or an AI account. Stripped from
  // production builds by the `import.meta.env.DEV` guard.
  void import("./core/store").then((store) => {
    (window as unknown as Record<string, unknown>).copilot = store;
  });
}
