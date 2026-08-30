/**
 * Automatic configuration backups.
 *
 * Every write is preceded by a full `diff all` snapshot stored in localStorage,
 * so any change the copilot makes can be reverted by replaying the snapshot.
 */
import { storage } from "./storage";

export interface Backup {
  id: string;
  createdAt: number;
  label: string;
  craftName: string;
  firmware: string;
  /** Raw `diff all` text. */
  text: string;
}

const KEY = "bf-copilot.backups";
const MAX_BACKUPS = 25;

export function loadBackups(): Backup[] {
  try {
    const raw = storage.get(KEY);
    return raw ? (JSON.parse(raw) as Backup[]) : [];
  } catch {
    return [];
  }
}

function persist(backups: Backup[]): void {
  try {
    storage.set(KEY, JSON.stringify(backups.slice(0, MAX_BACKUPS)));
  } catch {
    // Storage full or blocked; the in-memory download path still works.
  }
}

export function saveBackup(input: Omit<Backup, "id" | "createdAt">): Backup {
  const backup: Backup = {
    ...input,
    id: `bk_${Date.now().toString(36)}`,
    createdAt: Date.now(),
  };
  persist([backup, ...loadBackups()]);
  return backup;
}

export function deleteBackup(id: string): void {
  persist(loadBackups().filter((backup) => backup.id !== id));
}

/**
 * Turns a backup into the CLI commands that restore it. `defaults nosave`
 * first, so settings the backup does not mention return to stock rather than
 * keeping whatever the board drifted to.
 */
export function restoreCommands(backup: Backup): string[] {
  const lines = backup.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return ["defaults nosave", ...lines, "save"];
}

export function downloadBackup(backup: Backup): void {
  const blob = new Blob([backup.text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${backup.craftName || "betaflight"}-${new Date(backup.createdAt)
    .toISOString()
    .replace(/[:.]/g, "-")}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}
