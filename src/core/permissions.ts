/**
 * Permission modes, modelled on Claude Code's: manual approval by default, with
 * opt-in automation for the classes of change the user is comfortable handing
 * over. The `dangerous` tier always stops for a human, in every mode.
 */
import type { ChangeSet, Risk } from "./changeset";
import { riskOf } from "./changeset";

export type PermissionMode = "manual" | "autoTune" | "auto";

export interface ModeInfo {
  id: PermissionMode;
  label: string;
  description: string;
  /** Highest risk tier this mode will apply without asking. */
  autoUpTo: Risk | null;
}

export const MODES: ModeInfo[] = [
  {
    id: "manual",
    label: "Manual approve",
    description: "Every change is shown as a diff and waits for you. Default.",
    autoUpTo: null,
  },
  {
    id: "autoTune",
    label: "Auto-apply tuning",
    description:
      "PID, filter and rate changes apply on their own. Anything touching hardware, " +
      "receiver, power or modes still asks.",
    autoUpTo: "safe",
  },
  {
    id: "auto",
    label: "Full auto",
    description:
      "Tuning and setup changes apply on their own. Resource remaps, mixer changes and " +
      "`defaults` still ask, and motor/bootloader commands are never issued.",
    autoUpTo: "moderate",
  },
];

export type Decision =
  | { action: "apply"; reason: string }
  | { action: "ask"; reason: string }
  | { action: "refuse"; reason: string };

const ORDER: Risk[] = ["safe", "moderate", "dangerous", "blocked"];

export function decide(mode: PermissionMode, changeSet: ChangeSet): Decision {
  const risk = riskOf(changeSet.changes);

  if (risk === "blocked") {
    return {
      action: "refuse",
      reason:
        "This change set contains a command the copilot never issues " +
        "(motor spin, flash erase or bootloader entry).",
    };
  }

  const info = MODES.find((m) => m.id === mode)!;
  if (info.autoUpTo === null) {
    return { action: "ask", reason: "Manual approve mode: every change waits for you." };
  }

  if (risk === "dangerous") {
    return {
      action: "ask",
      reason: "Resource, mixer or defaults changes always require explicit approval.",
    };
  }

  if (ORDER.indexOf(risk) <= ORDER.indexOf(info.autoUpTo)) {
    return { action: "apply", reason: `${info.label}: ${risk} changes apply automatically.` };
  }

  return {
    action: "ask",
    reason: `${info.label} does not cover ${risk} changes.`,
  };
}

/** Extra gate: never write to a flight controller that reports itself armed. */
export function isArmed(flightModeFlags: number): boolean {
  return (flightModeFlags & 0x01) !== 0;
}
