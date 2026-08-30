/**
 * localStorage wrapper that degrades instead of throwing.
 *
 * Storage is absent or blocked in more situations than it looks: private
 * windows, embedded contexts, browsers set to block site data, and any
 * non-browser host. Nothing this app stores is essential to a session, so a
 * missing store simply means settings do not persist.
 */
function backing(kind: "local" | "session"): Storage | null {
  try {
    const store = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    if (!store) return null;
    // Safari throws on write rather than on access when storage is blocked.
    const probe = "__bf_copilot_probe__";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

function make(kind: "local" | "session") {
  const store = backing(kind);
  const fallback = new Map<string, string>();
  return {
    available: store !== null,
    get(key: string): string | null {
      try {
        return store ? store.getItem(key) : (fallback.get(key) ?? null);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        if (store) store.setItem(key, value);
        else fallback.set(key, value);
      } catch {
        fallback.set(key, value);
      }
    },
    remove(key: string): void {
      try {
        store?.removeItem(key);
      } catch {
        // Nothing to do.
      }
      fallback.delete(key);
    },
  };
}

export const storage = make("local");
export const sessionStore = make("session");
