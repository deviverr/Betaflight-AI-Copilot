/**
 * Application state and orchestration. Owns the flight controller link, the
 * chat transcript, the AI provider selection, and the approval queue that sits
 * between the model and the board.
 */
import { reactive, computed, ref, shallowRef } from "vue";
import { FcLink, CliCommandError } from "../msp/connection";
import { SimulatedFlightController } from "../msp/simulator";
import { parseConfig, summarizeForModel, type BetaflightConfig } from "./config";
import { toCliCommands, renderDiff, type ChangeSet } from "./changeset";
import { decide, isArmed, type PermissionMode } from "./permissions";
import { saveBackup, loadBackups, restoreCommands, type Backup } from "./backup";
import { analyzeFile, type BlackboxAnalysis } from "../blackbox/analyze";
import { storage } from "./storage";
import { runAgent } from "../ai/agent";
import { buildSystemPrompt } from "../ai/prompts";
import type { ToolContext } from "../ai/tools";
import type { AiProvider, ChatMessage, ModelInfo } from "../ai/types";
import { OpenRouterProvider } from "../ai/providers/openrouter";
import { PuterProvider } from "../ai/providers/puter";
import { ByokProvider } from "../ai/providers/byok";
import { ChromeAiProvider } from "../ai/providers/chromeAi";

export type TranscriptEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming: boolean }
  | { id: string; kind: "tool"; label: string; detail: string; state: "running" | "done" | "error" }
  | { id: string; kind: "changeset"; changeSet: ChangeSet; status: ApprovalStatus; note: string }
  | { id: string; kind: "system"; text: string; level: "info" | "warn" | "error" };

export type ApprovalStatus = "pending" | "applied" | "rejected" | "failed" | "refused";

interface PendingApproval {
  changeSet: ChangeSet;
  entryId: string;
  resolve: (outcome: string) => void;
}

let idCounter = 0;
const nextId = () => `e${++idCounter}`;

export const link = new FcLink();

export const providers: Record<string, AiProvider> = {
  puter: new PuterProvider(),
  openrouter: new OpenRouterProvider(),
  byok: new ByokProvider(),
  "chrome-ai": new ChromeAiProvider(),
};

export const state = reactive({
  // Connection
  connected: false,
  connecting: false,
  linkMode: "closed" as "closed" | "msp" | "cli",
  identity: null as null | Record<string, string>,
  connectionError: "",
  /** True when the board on the other end is the built-in simulator. */
  demo: false,

  // Configuration
  config: null as BetaflightConfig | null,
  configLoading: false,

  // AI
  providerId: storage.get("bf-copilot.provider") ?? "puter",
  model: storage.get("bf-copilot.model") ?? "",
  models: [] as ModelInfo[],
  authenticated: false,
  providerError: "",

  // Agent
  busy: false,
  transcript: [] as TranscriptEntry[],
  history: [] as ChatMessage[],

  // Permissions
  mode: (storage.get("bf-copilot.mode") ?? "manual") as PermissionMode,

  // Extras
  backups: loadBackups() as Backup[],
  blackbox: null as BlackboxAnalysis | null,
  cliOutput: [] as string[],
});

export const pendingApproval = shallowRef<PendingApproval | null>(null);
export const abortController = ref<AbortController | null>(null);

export const activeProvider = computed(() => providers[state.providerId]);
export const currentModel = computed(() =>
  state.models.find((model) => model.id === state.model) ?? null,
);

link.onModeChange = (mode) => {
  state.linkMode = mode;
  state.connected = mode !== "closed";
};
link.onDisconnect = (reason) => {
  state.connected = false;
  state.config = null;
  pushSystem(`Flight controller disconnected: ${reason ?? "unknown reason"}`, "warn");
};
link.onCliStream = (chunk) => {
  state.cliOutput.push(chunk);
  if (state.cliOutput.length > 400) state.cliOutput.shift();
};

// -------------------------------------------------------------- transcript

function push(entry: TranscriptEntry): TranscriptEntry {
  state.transcript.push(entry);
  return entry;
}

export function pushSystem(text: string, level: "info" | "warn" | "error" = "info"): void {
  push({ id: nextId(), kind: "system", text, level });
}

export function clearTranscript(): void {
  state.transcript = [];
  state.history = [];
}

// -------------------------------------------------------------- connection

export async function connect(): Promise<void> {
  state.demo = false;
  await openLink();
}

/**
 * Connects to the built-in simulated flight controller. Everything downstream —
 * MSP framing, CLI parsing, change sets, approvals — runs exactly as it does
 * against hardware; only the serial port is simulated.
 */
export async function connectDemo(): Promise<void> {
  state.demo = true;
  simulator = new SimulatedFlightController();
  await openLink(simulator as unknown as SerialPort);
  if (state.connected) {
    pushSystem(
      "Demo mode: this is a simulated 5-inch 6S freestyle build, not a real aircraft. " +
        "Changes are applied to the simulation and nothing is written to hardware.",
    );
  }
}

let simulator: SimulatedFlightController | null = null;

async function openLink(port?: SerialPort): Promise<void> {
  state.connecting = true;
  state.connectionError = "";
  try {
    const identity = await link.connect(undefined, port);
    state.identity = { ...identity };
    state.connected = true;
    pushSystem(
      `Connected to ${identity.variant} ${identity.firmwareVersion} on ${identity.targetName}` +
        (identity.craftName ? ` ("${identity.craftName}")` : ""),
    );
    if (identity.variant !== "BTFL") {
      pushSystem(
        `This board reports firmware variant "${identity.variant}". The copilot's knowledge is ` +
          "Betaflight-specific; treat its advice with care on other firmware.",
        "warn",
      );
    }
    await refreshConfig(false);
  } catch (error) {
    state.connectionError = error instanceof Error ? error.message : String(error);
    pushSystem(state.connectionError, "error");
  } finally {
    state.connecting = false;
  }
}

export async function disconnect(): Promise<void> {
  await link.disconnect();
  state.connected = false;
  state.demo = false;
  simulator = null;
  state.identity = null;
  state.config = null;
}

/** Reads `diff all` (or `dump all`) and parses it. */
export async function refreshConfig(full = false): Promise<BetaflightConfig> {
  if (!link.isConnected) throw new Error("Not connected");
  state.configLoading = true;
  try {
    const entered = link.mode !== "cli";
    if (entered) await link.enterCli();
    const text = await link.cli(full ? "dump all" : "diff all");
    const config = parseConfig(text);
    state.config = config;
    return config;
  } finally {
    state.configLoading = false;
  }
}

async function ensureCli(): Promise<void> {
  if (link.mode !== "cli") await link.enterCli();
}

/**
 * Reconnects after the flight controller reboots. `save` and `exit` both reset
 * the board, which drops the USB device for a second or two.
 */
async function reconnectAfterReboot(): Promise<void> {
  if (state.demo) {
    // The simulator closes its stream on save, standing in for a board that
    // reboots and re-enumerates. A fresh instance is the reconnected device.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await link.disconnect().catch(() => {});
    simulator = new SimulatedFlightController();
    await link.connect(undefined, simulator as unknown as SerialPort);
    state.connected = true;
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const ports = await navigator.serial.getPorts();
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const port of ports) {
      try {
        await link.connect(undefined, port);
        state.connected = true;
        return;
      } catch {
        // Board still enumerating.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  pushSystem(
    "The flight controller rebooted but did not come back automatically. Press Connect again.",
    "warn",
  );
}

// -------------------------------------------------------------- approvals

/**
 * The single gate every write passes through. Returns a sentence describing the
 * outcome, which goes back to the model as the tool result.
 */
export async function submitChangeSet(changeSet: ChangeSet): Promise<string> {
  const decision = decide(state.mode, changeSet);

  const entry = push({
    id: nextId(),
    kind: "changeset",
    changeSet,
    status: "pending",
    note: decision.reason,
  }) as Extract<TranscriptEntry, { kind: "changeset" }>;

  if (decision.action === "refuse") {
    entry.status = "refused";
    return `Refused: ${decision.reason}`;
  }

  // Never write to an armed aircraft, regardless of mode.
  try {
    const telemetry = await withMsp(() => link.readTelemetry());
    if (isArmed(telemetry.flightModeFlags)) {
      entry.status = "refused";
      entry.note = "The aircraft reports itself as armed.";
      return "Refused: the flight controller is armed. Disarm and remove props before changing anything.";
    }
  } catch {
    // Telemetry is best-effort; a board in CLI mode cannot answer MSP.
  }

  if (decision.action === "apply") {
    return applyChangeSet(entry);
  }

  return new Promise<string>((resolve) => {
    pendingApproval.value = { changeSet, entryId: entry.id, resolve };
  });
}

export async function approvePending(): Promise<void> {
  const pending = pendingApproval.value;
  if (!pending) return;
  pendingApproval.value = null;
  const entry = state.transcript.find(
    (item) => item.id === pending.entryId,
  ) as Extract<TranscriptEntry, { kind: "changeset" }> | undefined;
  if (!entry) return;
  pending.resolve(await applyChangeSet(entry));
}

export function rejectPending(reason = "The user declined these changes."): void {
  const pending = pendingApproval.value;
  if (!pending) return;
  pendingApproval.value = null;
  const entry = state.transcript.find(
    (item) => item.id === pending.entryId,
  ) as Extract<TranscriptEntry, { kind: "changeset" }> | undefined;
  if (entry) {
    entry.status = "rejected";
    entry.note = reason;
  }
  pending.resolve(`Rejected: ${reason}`);
}

async function applyChangeSet(
  entry: Extract<TranscriptEntry, { kind: "changeset" }>,
): Promise<string> {
  const commands = toCliCommands(entry.changeSet);
  if (!commands.length) {
    entry.status = "applied";
    entry.note = "Every value was already set; nothing to write.";
    return "No changes needed: the board already holds these values.";
  }

  try {
    await ensureCli();

    // Snapshot first, so this is always undoable.
    const before = await link.cli("diff all");
    const backup = saveBackup({
      label: `before: ${entry.changeSet.title}`,
      craftName: state.config?.craftName ?? "",
      firmware: state.config?.firmwareLine ?? "",
      text: before,
    });
    state.backups = loadBackups();

    await link.cliBatch(commands.filter((command) => command !== "save"));
    await link.saveAndReboot();

    entry.status = "applied";
    entry.note = `Applied and saved. Backup ${backup.id} taken first.`;

    await reconnectAfterReboot();
    if (link.isConnected) await refreshConfig(false);

    return (
      `Applied ${commands.length - 1} change(s) and saved to EEPROM; the board rebooted and ` +
      `reconnected. A backup was taken first (${backup.id}). ` +
      "The configuration has been re-read."
    );
  } catch (error) {
    entry.status = "failed";
    const message = error instanceof Error ? error.message : String(error);
    entry.note = message;
    if (error instanceof CliCommandError) {
      return (
        `The flight controller rejected "${error.command}". ` +
        `Its response: ${error.output.slice(0, 300)}. ` +
        `${error.completed.length - 1} earlier command(s) were accepted but not saved. ` +
        "Check the setting name against this firmware version with run_cli `get <name>`."
      );
    }
    return `Failed to apply changes: ${message}`;
  }
}

export async function restoreBackup(backup: Backup): Promise<void> {
  await ensureCli();
  await link.cliBatch(restoreCommands(backup).filter((command) => command !== "save"));
  await link.saveAndReboot();
  pushSystem(`Restored backup from ${new Date(backup.createdAt).toLocaleString()}.`);
  await reconnectAfterReboot();
  if (link.isConnected) await refreshConfig(false);
}

/** Runs `fn` with the link in MSP mode, returning it to CLI afterwards if it was there. */
async function withMsp<T>(fn: () => Promise<T>): Promise<T> {
  if (link.mode === "msp") return fn();
  throw new Error("Link is in CLI mode");
}

// -------------------------------------------------------------- AI plumbing

export async function selectProvider(id: string): Promise<void> {
  state.providerId = id;
  storage.set("bf-copilot.provider", id);
  state.providerError = "";
  await refreshProviderState();
}

export async function refreshProviderState(): Promise<void> {
  const provider = activeProvider.value;
  if (!provider) return;
  state.authenticated = provider.isAuthenticated();
  if (!state.authenticated) {
    state.models = [];
    return;
  }
  try {
    state.models = await provider.listModels();
    if (!state.models.some((model) => model.id === state.model)) {
      state.model = state.models.find((model) => model.supportsTools)?.id ?? state.models[0]?.id ?? "";
      storage.set("bf-copilot.model", state.model);
    }
  } catch (error) {
    state.providerError = error instanceof Error ? error.message : String(error);
  }
}

export async function loginProvider(): Promise<void> {
  state.providerError = "";
  try {
    await activeProvider.value.login();
    await refreshProviderState();
  } catch (error) {
    state.providerError = error instanceof Error ? error.message : String(error);
  }
}

export function setModel(id: string): void {
  state.model = id;
  storage.set("bf-copilot.model", id);
}

export function setMode(mode: PermissionMode): void {
  state.mode = mode;
  storage.set("bf-copilot.mode", mode);
}

const toolContext: ToolContext = {
  isConnected: () => link.isConnected,
  getConfig: () => state.config,
  refreshConfig: (full) => refreshConfig(full),
  runReadOnlyCli: async (command) => {
    await ensureCli();
    return link.cli(command);
  },
  readTelemetry: () => withMsp(() => link.readTelemetry()),
  getBlackbox: () => state.blackbox,
  submitChangeSet,
  saveBackup: async (label) => {
    await ensureCli();
    const text = await link.cli("diff all");
    const backup = saveBackup({
      label,
      craftName: state.config?.craftName ?? "",
      firmware: state.config?.firmwareLine ?? "",
      text,
    });
    state.backups = loadBackups();
    return backup.id;
  },
};

export async function sendMessage(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || state.busy) return;

  const provider = activeProvider.value;
  if (!provider?.isAuthenticated()) {
    pushSystem("Connect an AI provider first — see the Provider panel.", "warn");
    return;
  }
  if (!state.model) {
    pushSystem("Pick a model first.", "warn");
    return;
  }

  push({ id: nextId(), kind: "user", text: trimmed });
  state.history.push({ role: "user", content: trimmed });
  state.busy = true;
  abortController.value = new AbortController();

  const assistantEntry = push({
    id: nextId(),
    kind: "assistant",
    text: "",
    streaming: true,
  }) as Extract<TranscriptEntry, { kind: "assistant" }>;

  const supportsTools = currentModel.value?.supportsTools ?? true;
  if (!supportsTools) {
    pushSystem(
      `${currentModel.value?.label} cannot call tools, so the copilot is in advisory mode: ` +
        "it will explain and suggest CLI lines, but cannot read or write the board itself.",
      "warn",
    );
  }

  const systemPrompt = buildSystemPrompt({
    mode: state.mode,
    connected: state.connected,
    hasTools: supportsTools,
    fcSummary: state.config
      ? `${JSON.stringify(state.identity)}\n\n${summarizeForModel(state.config)}`
      : state.identity
        ? JSON.stringify(state.identity)
        : undefined,
  });

  let toolEntry: Extract<TranscriptEntry, { kind: "tool" }> | null = null;

  try {
    const generator = runAgent(state.history, {
      provider,
      model: state.model,
      supportsTools,
      systemPrompt,
      context: toolContext,
      signal: abortController.value.signal,
    });

    let result = await generator.next();
    while (!result.done) {
      const event = result.value;
      if (event.type === "text" && event.text) {
        assistantEntry.text += event.text;
      } else if (event.type === "tool_start") {
        toolEntry = push({
          id: nextId(),
          kind: "tool",
          label: event.toolName ?? "tool",
          detail: truncate(event.toolArgs ?? "", 200),
          state: "running",
        }) as Extract<TranscriptEntry, { kind: "tool" }>;
      } else if (event.type === "tool_end") {
        if (toolEntry) {
          toolEntry.state = event.result?.content.startsWith("Error") ? "error" : "done";
          toolEntry.detail =
            event.result?.display?.kind === "text"
              ? event.result.display.text
              : truncate(event.result?.content ?? "", 200);
        }
      } else if (event.type === "error") {
        pushSystem(event.message ?? "Unknown error", "error");
      }
      result = await generator.next();
    }

    state.history = result.value.filter((message) => message.role !== "system");
  } catch (error) {
    pushSystem(error instanceof Error ? error.message : String(error), "error");
  } finally {
    assistantEntry.streaming = false;
    state.busy = false;
    abortController.value = null;
  }
}

export function cancel(): void {
  abortController.value?.abort();
  rejectPending("The user cancelled the turn.");
}

export async function loadBlackbox(file: File): Promise<void> {
  try {
    state.blackbox = await analyzeFile(file);
    pushSystem(
      `Loaded blackbox log "${file.name}"` +
        (state.blackbox.headerOnly
          ? " — header only; export a CSV for full analysis."
          : `: ${state.blackbox.frameCount} frames over ${state.blackbox.durationSeconds.toFixed(1)}s.`),
      state.blackbox.headerOnly ? "warn" : "info",
    );
  } catch (error) {
    pushSystem(error instanceof Error ? error.message : String(error), "error");
  }
}

export { renderDiff };

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
