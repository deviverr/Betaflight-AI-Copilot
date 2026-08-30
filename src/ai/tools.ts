/**
 * Tool definitions the model can call, and the executor that runs them against
 * the live flight controller. Every write funnels through `propose_changes`,
 * which hands a change set to the permission layer.
 */
import type { ToolDefinition } from "./types";
import type { BetaflightConfig } from "../core/config";
import { summarizeForModel } from "../core/config";
import { newChangeSet, resolveChange, type ChangeSet } from "../core/changeset";
import type { BlackboxAnalysis } from "../blackbox/analyze";

/** CLI commands the model may run directly: all of them read-only. */
const READ_ONLY_CLI = [
  "get", "status", "version", "dump", "diff", "resource", "timer", "dma",
  "tasks", "rc", "adjrange", "aux", "serial", "feature", "map", "mixer",
  "vtx", "led", "beeper", "sd_info", "gpspassthrough", "battery", "profile",
  "rateprofile", "help",
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_config",
    description:
      "Read the flight controller's current configuration as `diff all` — every setting that " +
      "differs from firmware defaults, plus board, firmware version and features. Call this " +
      "before proposing changes and again after applying any.",
    parameters: {
      type: "object",
      properties: {
        full: {
          type: "boolean",
          description: "Use `dump all` instead of `diff all` to include default values too. Much larger.",
        },
      },
      required: [],
    },
  },
  {
    name: "run_cli",
    description:
      "Run one read-only Betaflight CLI command and return its output. Use this to check whether " +
      "a setting exists on this firmware (`get dyn_notch_count`), to read `status`, or to inspect " +
      "resource and timer allocation. Write commands are refused — use propose_changes instead.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The CLI command, e.g. \"get gyro_lpf1_static_hz\"" },
      },
      required: ["command"],
    },
  },
  {
    name: "propose_changes",
    description:
      "Propose a set of configuration changes. The app shows them to the user as a diff, applies " +
      "them according to the current permission mode, saves to EEPROM and reboots the flight " +
      "controller. This is the only way to write anything.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title, e.g. \"Reduce propwash on descents\"" },
        summary: {
          type: "string",
          description: "One or two sentences on what this achieves and what to feel for on the next flight.",
        },
        changes: {
          type: "array",
          description: "The individual settings to write.",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["set", "feature", "command"],
                description: "\"set\" for a setting, \"feature\" to toggle a feature, \"command\" for another CLI line.",
              },
              key: { type: "string", description: "Setting name, feature name, or CLI command word." },
              value: { type: "string", description: "New value. For a feature use \"on\" or \"off\"." },
              scope: {
                type: "string",
                description: "\"master\", \"profile\" or \"rateprofile\". Omit to let the app place it automatically.",
                enum: ["master", "profile", "rateprofile"],
              },
              scopeIndex: { type: "number", description: "Profile or rate profile index. Defaults to the active one." },
              reason: { type: "string", description: "Why this specific value, in one line." },
            },
            required: ["kind", "key", "value", "reason"],
          },
        },
      },
      required: ["title", "summary", "changes"],
    },
  },
  {
    name: "read_telemetry",
    description:
      "Read live values from the flight controller: pack voltage, current draw, mAh consumed, " +
      "RSSI, gyro loop cycle time, I2C error count and arming flags.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "analyze_blackbox",
    description:
      "Return statistics from the blackbox log the user has loaded: gyro noise spectrum peaks, " +
      "PID error distribution, motor output saturation and throttle correlation. Call this before " +
      "diagnosing a tuning complaint if a log is available.",
    parameters: {
      type: "object",
      properties: {
        axis: { type: "string", enum: ["roll", "pitch", "yaw", "all"], description: "Which axis to report on." },
      },
      required: [],
    },
  },
  {
    name: "save_backup",
    description:
      "Save a snapshot of the current configuration so it can be restored later. The app also does " +
      "this automatically before every write; call it explicitly before a long or risky sequence.",
    parameters: {
      type: "object",
      properties: { label: { type: "string", description: "Short name for the snapshot." } },
      required: ["label"],
    },
  },
];

export interface ToolContext {
  isConnected(): boolean;
  getConfig(): BetaflightConfig | null;
  refreshConfig(full: boolean): Promise<BetaflightConfig>;
  runReadOnlyCli(command: string): Promise<string>;
  readTelemetry(): Promise<Record<string, number>>;
  getBlackbox(): BlackboxAnalysis | null;
  submitChangeSet(changeSet: ChangeSet): Promise<string>;
  saveBackup(label: string): Promise<string>;
}

export interface ToolResult {
  content: string;
  /** Surfaced in the transcript so the user sees what the model did. */
  display?: { kind: "changeset"; changeSet: ChangeSet } | { kind: "text"; text: string };
}

export async function executeTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<ToolResult> {
  let args: any;
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
  } catch {
    return { content: `Error: arguments for ${name} were not valid JSON: ${rawArguments.slice(0, 200)}` };
  }

  switch (name) {
    case "read_config": {
      if (!context.isConnected()) return { content: "Error: no flight controller is connected." };
      const config = await context.refreshConfig(Boolean(args.full));
      return {
        content: summarizeForModel(config),
        display: { kind: "text", text: `Read configuration (${config.master.size} master settings)` },
      };
    }

    case "run_cli": {
      if (!context.isConnected()) return { content: "Error: no flight controller is connected." };
      const command = String(args.command ?? "").trim();
      const head = command.split(/\s+/)[0]?.toLowerCase() ?? "";
      if (!READ_ONLY_CLI.includes(head)) {
        return {
          content:
            `Error: "${head}" is not a read-only CLI command. ` +
            `Use propose_changes to write anything. Allowed here: ${READ_ONLY_CLI.join(", ")}.`,
        };
      }
      // `resource`, `profile` and `rateprofile` are read-only only without arguments.
      if (["resource", "profile", "rateprofile", "timer", "dma"].includes(head) && /\s\S/.test(command) && !/\bshow\b/.test(command)) {
        return { content: `Error: "${command}" would write. Use propose_changes.` };
      }
      const output = await context.runReadOnlyCli(command);
      return { content: output || "(no output)", display: { kind: "text", text: `$ ${command}` } };
    }

    case "propose_changes": {
      const config = context.getConfig();
      if (!config) return { content: "Error: read the configuration before proposing changes." };
      const inputs: any[] = Array.isArray(args.changes) ? args.changes : [];
      if (!inputs.length) return { content: "Error: propose_changes needs at least one change." };

      const changes = inputs.map((input) =>
        resolveChange(config, {
          kind: input.kind === "feature" || input.kind === "command" ? input.kind : "set",
          key: String(input.key ?? ""),
          value: String(input.value ?? ""),
          reason: String(input.reason ?? ""),
          scope: input.scope
            ? input.scope === "master"
              ? { kind: "master" }
              : { kind: input.scope, index: Number(input.scopeIndex ?? (input.scope === "profile" ? config.activeProfile : config.activeRateProfile)) }
            : undefined,
        }),
      );

      const blocked = changes.filter((change) => change.risk === "blocked");
      if (blocked.length) {
        return {
          content:
            `Refused: ${blocked.map((c) => c.key).join(", ")} ` +
            `${blocked.length === 1 ? "is" : "are"} on the never-issue list ` +
            "(motor spin, flash erase or bootloader). Propose something else.",
        };
      }

      const changeSet = newChangeSet(String(args.title ?? "Configuration change"), String(args.summary ?? ""), changes);
      const outcome = await context.submitChangeSet(changeSet);
      return { content: outcome, display: { kind: "changeset", changeSet } };
    }

    case "read_telemetry": {
      if (!context.isConnected()) return { content: "Error: no flight controller is connected." };
      const telemetry = await context.readTelemetry();
      const armed = (telemetry.flightModeFlags & 0x01) !== 0;
      return {
        content:
          `voltage: ${telemetry.voltage.toFixed(2)} V\n` +
          `current: ${telemetry.amperage.toFixed(2)} A\n` +
          `consumed: ${telemetry.mahDrawn} mAh\n` +
          `rssi: ${telemetry.rssi}\n` +
          `gyro cycle time: ${telemetry.cycleTime} us\n` +
          `i2c errors: ${telemetry.i2cErrors}\n` +
          `armed: ${armed ? "YES — do not change anything" : "no"}`,
        display: { kind: "text", text: "Read live telemetry" },
      };
    }

    case "analyze_blackbox": {
      const analysis = context.getBlackbox();
      if (!analysis) {
        return { content: "Error: no blackbox log is loaded. Ask the user to drop a .bbl or .csv log onto the app." };
      }
      return { content: formatBlackbox(analysis, String(args.axis ?? "all")), display: { kind: "text", text: "Analysed blackbox log" } };
    }

    case "save_backup": {
      if (!context.isConnected()) return { content: "Error: no flight controller is connected." };
      const id = await context.saveBackup(String(args.label ?? "manual snapshot"));
      return { content: `Saved backup ${id}.`, display: { kind: "text", text: `Saved backup "${args.label}"` } };
    }

    default:
      return { content: `Error: unknown tool "${name}".` };
  }
}

function formatBlackbox(analysis: BlackboxAnalysis, axis: string): string {
  const lines: string[] = [
    `log: ${analysis.fileName}`,
    `duration: ${analysis.durationSeconds.toFixed(1)} s, ${analysis.frameCount} frames at ~${analysis.sampleRateHz.toFixed(0)} Hz`,
  ];
  if (analysis.firmware) lines.push(`firmware: ${analysis.firmware}`);
  if (analysis.craftName) lines.push(`craft: ${analysis.craftName}`);

  const axes = axis === "all" ? analysis.axes : analysis.axes.filter((a) => a.name === axis);
  for (const entry of axes) {
    lines.push(`\n[${entry.name}]`);
    lines.push(`  gyro RMS: ${entry.gyroRms.toFixed(1)} deg/s, peak ${entry.gyroPeak.toFixed(0)} deg/s`);
    lines.push(`  PID error RMS: ${entry.errorRms.toFixed(1)}, peak ${entry.errorPeak.toFixed(0)}`);
    if (entry.noisePeaks.length) {
      lines.push(
        `  gyro noise peaks: ${entry.noisePeaks
          .map((peak) => `${peak.frequencyHz.toFixed(0)} Hz (${peak.relativeAmplitude.toFixed(2)})`)
          .join(", ")}`,
      );
    }
  }

  if (analysis.motors) {
    lines.push(
      `\n[motors]`,
      `  mean output: ${(analysis.motors.meanOutput * 100).toFixed(1)}%`,
      `  time saturated (>95%): ${(analysis.motors.saturationRatio * 100).toFixed(1)}%`,
      `  max spread between motors: ${(analysis.motors.maxImbalance * 100).toFixed(1)}%`,
    );
  }
  if (analysis.notes.length) lines.push(`\n[notes]`, ...analysis.notes.map((note) => `  - ${note}`));
  return lines.join("\n");
}
