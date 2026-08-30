/**
 * A change set is the unit the AI proposes and the user approves: a list of
 * settings to write, each classified by how much damage getting it wrong can
 * do. Nothing reaches the flight controller except through one of these.
 */
import {
  findScope,
  getSetting,
  scopeKey,
  type BetaflightConfig,
  type Scope,
} from "./config";

export type Risk = "safe" | "moderate" | "dangerous" | "blocked";

export interface ProposedChange {
  /** `set` writes a setting; `feature` toggles one; `command` is a raw CLI line. */
  kind: "set" | "feature" | "command";
  key: string;
  newValue: string;
  scope: Scope;
  oldValue?: string;
  reason: string;
  risk: Risk;
  /** Set when the change is refused outright, explaining why. */
  blockedReason?: string;
}

export interface ChangeSet {
  id: string;
  title: string;
  summary: string;
  changes: ProposedChange[];
  createdAt: number;
}

/**
 * Tuning knobs: wrong values fly badly but cannot damage hardware on the bench
 * and are undone by restoring the backup.
 */
const SAFE_PREFIXES = [
  "p_", "i_", "d_", "f_",
  "gyro_lpf", "gyro_lowpass", "gyro_notch", "dyn_notch", "dterm_lpf", "dterm_lowpass",
  "dterm_notch", "rpm_filter", "simplified_",
  "roll_", "pitch_", "yaw_", "thr_", "rates_", "tpa_",
  "anti_gravity", "iterm_", "feedforward_", "d_max", "dmax_",
  "throttle_boost", "thrust_linear", "vbat_sag", "abs_control",
  "angle_", "horizon_", "acro_trainer", "level_",
];

/**
 * Changes that alter how the aircraft is wired, powered or controlled. Real
 * consequences if wrong, but a normal part of setting a quad up.
 */
const MODERATE_PREFIXES = [
  "motor_", "dshot_", "esc_", "min_throttle", "max_throttle", "motor_output",
  "vbat_", "ibata_", "battery_", "current_",
  "failsafe_", "rx_", "serialrx_", "rssi_", "sbus_", "crsf_",
  "gps_", "mag_", "baro_", "align_", "small_angle",
  "vtx_", "osd_", "blackbox_", "beeper_", "led_",
];

/**
 * Things that change hardware mapping or wipe state. Always require explicit
 * confirmation, in every permission mode.
 */
const DANGEROUS_COMMANDS = [
  "resource", "timer", "dma", "board_name", "manufacturer_id", "mixer",
  "defaults", "save_and_reboot", "servo", "smix", "mmix",
];

/**
 * Never issued by the AI under any mode: these spin motors, erase storage or
 * put the board into a bootloader where this app cannot reach it.
 */
const BLOCKED_COMMANDS = [
  "bl", "dfu", "msc", "mmc", "flash_erase", "flash_write", "erase",
  "motor", "escprog", "esc4way", "dshotprog", "beacon",
];

export function classifyKey(key: string): Risk {
  const lower = key.toLowerCase();
  if (BLOCKED_COMMANDS.includes(lower)) return "blocked";
  if (DANGEROUS_COMMANDS.includes(lower)) return "dangerous";
  if (SAFE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "safe";
  if (MODERATE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return "moderate";
  // Unknown keys are treated as moderate rather than safe: a setting we do not
  // recognise is exactly the one we should not auto-apply.
  return "moderate";
}

export function classifyCommand(line: string): Risk {
  const head = line.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (BLOCKED_COMMANDS.includes(head)) return "blocked";
  if (DANGEROUS_COMMANDS.includes(head)) return "dangerous";
  if (head === "set") return classifyKey(line.trim().split(/\s+/)[1]?.split("=")[0] ?? "");
  if (head === "feature") return "moderate";
  return "moderate";
}

export function riskOf(changes: ProposedChange[]): Risk {
  const order: Risk[] = ["safe", "moderate", "dangerous", "blocked"];
  return changes.reduce<Risk>(
    (worst, change) => (order.indexOf(change.risk) > order.indexOf(worst) ? change.risk : worst),
    "safe",
  );
}

/** Fills in `oldValue`, `scope` and `risk` from the live config. */
export function resolveChange(
  config: BetaflightConfig,
  input: { kind: ProposedChange["kind"]; key: string; value: string; reason?: string; scope?: Scope },
): ProposedChange {
  const key = input.key.toLowerCase();
  const risk = input.kind === "command" ? classifyCommand(`${key} ${input.value}`) : classifyKey(key);
  const scope = input.scope ?? findScope(config, key) ?? defaultScopeFor(config, key);
  const change: ProposedChange = {
    kind: input.kind,
    key,
    newValue: input.value.trim(),
    scope,
    oldValue: input.kind === "set" ? getSetting(config, key, scope) : undefined,
    reason: input.reason ?? "",
    risk,
  };
  if (risk === "blocked") {
    change.blockedReason =
      "This command spins motors, erases storage, or reboots into a bootloader. " +
      "The copilot never issues it — run it yourself in Betaflight Configurator if you need it.";
  }
  return change;
}

/**
 * A key we have never seen in this config still has to land somewhere. PID and
 * rate keys are per-profile; everything else defaults to master.
 */
function defaultScopeFor(config: BetaflightConfig, key: string): Scope {
  if (/^(p|i|d|f)_(roll|pitch|yaw)$/.test(key) || key.startsWith("d_max_") || key.startsWith("dterm_")) {
    return { kind: "profile", index: config.activeProfile };
  }
  if (/^(roll|pitch|yaw)_(rc_rate|srate|expo)$/.test(key) || key.startsWith("rates_") || key.startsWith("thr_")) {
    return { kind: "rateprofile", index: config.activeRateProfile };
  }
  return { kind: "master" };
}

/** True when the change would write the value the board already holds. */
export function isNoop(change: ProposedChange): boolean {
  return change.kind === "set" && change.oldValue !== undefined && change.oldValue === change.newValue;
}

/**
 * Renders a change set as the exact CLI lines that will be sent, including the
 * `profile` / `rateprofile` switches needed to put each `set` in the right
 * section, and a final `save`.
 */
export function toCliCommands(changeSet: ChangeSet, options: { save?: boolean } = {}): string[] {
  const applicable = changeSet.changes.filter((c) => c.risk !== "blocked" && !isNoop(c));
  const commands: string[] = [];
  let currentScope = "";

  // Group by scope so we switch profiles once, not once per setting.
  const ordered = [...applicable].sort(
    (a, b) => scopeKey(a.scope).localeCompare(scopeKey(b.scope)),
  );

  for (const change of ordered) {
    const key = scopeKey(change.scope);
    if (key !== currentScope) {
      if (change.scope.kind === "profile") commands.push(`profile ${change.scope.index}`);
      if (change.scope.kind === "rateprofile") commands.push(`rateprofile ${change.scope.index}`);
      currentScope = key;
    }
    if (change.kind === "set") commands.push(`set ${change.key} = ${change.newValue}`);
    else if (change.kind === "feature") {
      commands.push(`feature ${change.newValue === "off" ? "-" : ""}${change.key.toUpperCase()}`);
    } else commands.push(`${change.key} ${change.newValue}`.trim());
  }

  if (options.save !== false && commands.length) commands.push("save");
  return commands;
}

export interface DiffLine {
  scope: string;
  text: string;
  risk: Risk;
  /** True when the board already holds this value, so nothing will be written. */
  unchanged: boolean;
}

/** Human-readable diff lines for the approval panel. */
export function renderDiff(changeSet: ChangeSet): DiffLine[] {
  return changeSet.changes.map((change) => ({
    scope: scopeKey(change.scope),
    risk: change.risk,
    unchanged: isNoop(change),
    text: isNoop(change)
      ? `${change.key}: ${change.newValue}`
      : change.kind === "set"
        ? `${change.key}: ${change.oldValue ?? "(default)"} → ${change.newValue}`
        : change.kind === "feature"
          ? `feature ${change.key.toUpperCase()} → ${change.newValue}`
          : `${change.key} ${change.newValue}`,
  }));
}

export function newChangeSet(title: string, summary: string, changes: ProposedChange[]): ChangeSet {
  return {
    id: `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title,
    summary,
    changes,
    createdAt: Date.now(),
  };
}
