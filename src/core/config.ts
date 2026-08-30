/**
 * Parses Betaflight `diff all` / `dump all` output into a structured model,
 * and turns a set of desired changes back into an ordered CLI command list.
 *
 * The text format is line based and context sensitive: `set` lines belong to
 * whichever `profile N` / `rateprofile N` section most recently appeared, so
 * the parser tracks that scope as it walks the file.
 */

export type Scope =
  | { kind: "master" }
  | { kind: "profile"; index: number }
  | { kind: "rateprofile"; index: number };

export interface Setting {
  key: string;
  value: string;
  scope: Scope;
}

/** Lines that are not `set` — feature, aux, serial, resource, and friends. */
export interface DirectiveLine {
  command: string;
  args: string;
  raw: string;
}

export interface BetaflightConfig {
  raw: string;
  /** e.g. "Betaflight / STM32F405 (S405) 4.5.1 Jun 20 2024 / 09:20:15 (77d01ba3b)" */
  firmwareLine: string;
  boardName: string;
  manufacturerId: string;
  craftName: string;
  mixer: string;
  features: Map<string, boolean>;
  master: Map<string, string>;
  profiles: Map<number, Map<string, string>>;
  rateProfiles: Map<number, Map<string, string>>;
  activeProfile: number;
  activeRateProfile: number;
  directives: DirectiveLine[];
  /** True when parsed from `dump all` rather than `diff all`. */
  isFullDump: boolean;
}

const SET_LINE = /^set\s+([a-z0-9_]+)\s*=\s*(.*)$/i;
const DIRECTIVE_LINE = /^([a-z_][a-z0-9_]*)\s*(.*)$/i;

export function emptyConfig(): BetaflightConfig {
  return {
    raw: "",
    firmwareLine: "",
    boardName: "",
    manufacturerId: "",
    craftName: "",
    mixer: "",
    features: new Map(),
    master: new Map(),
    profiles: new Map(),
    rateProfiles: new Map(),
    activeProfile: 0,
    activeRateProfile: 0,
    directives: [],
    isFullDump: false,
  };
}

export function parseConfig(text: string): BetaflightConfig {
  const config = emptyConfig();
  config.raw = text;
  config.isFullDump = /^#\s*dump\b/im.test(text) || /\bdefaults\s+nosave\b/i.test(text);

  let scope: Scope = { kind: "master" };
  // `dump all` ends with the profile/rateprofile the board was actually on;
  // those trailing lines are what we treat as active.
  let lastProfileLine = -1;
  let lastRateProfileLine = -1;

  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    if (line.startsWith("#")) {
      const comment = line.replace(/^#\s*/, "");
      if (/^Betaflight\s*\//i.test(comment)) config.firmwareLine = comment;
      const nameMatch = comment.match(/^name:\s*(.+)$/i);
      if (nameMatch) config.craftName = nameMatch[1].trim();
      const profileMatch = comment.match(/^profile\s+(\d+)$/i);
      if (profileMatch) scope = { kind: "profile", index: Number(profileMatch[1]) };
      const rateMatch = comment.match(/^rateprofile\s+(\d+)$/i);
      if (rateMatch) scope = { kind: "rateprofile", index: Number(rateMatch[1]) };
      if (/^master$/i.test(comment)) scope = { kind: "master" };
      return;
    }

    const setMatch = line.match(SET_LINE);
    if (setMatch) {
      const [, key, value] = setMatch;
      bucketFor(config, scope).set(key.toLowerCase(), value.trim());
      return;
    }

    const directiveMatch = line.match(DIRECTIVE_LINE);
    if (!directiveMatch) return;
    const command = directiveMatch[1].toLowerCase();
    const args = directiveMatch[2].trim();

    switch (command) {
      case "profile": {
        scope = { kind: "profile", index: Number(args) || 0 };
        lastProfileLine = index;
        config.activeProfile = Number(args) || 0;
        ensureBucket(config.profiles, config.activeProfile);
        return;
      }
      case "rateprofile": {
        scope = { kind: "rateprofile", index: Number(args) || 0 };
        lastRateProfileLine = index;
        config.activeRateProfile = Number(args) || 0;
        ensureBucket(config.rateProfiles, config.activeRateProfile);
        return;
      }
      case "board_name":
        config.boardName = args;
        return;
      case "manufacturer_id":
        config.manufacturerId = args;
        return;
      case "mixer":
        config.mixer = args;
        return;
      case "feature": {
        const negated = args.startsWith("-");
        config.features.set(args.replace(/^-/, "").toUpperCase(), !negated);
        config.directives.push({ command, args, raw: line });
        return;
      }
      default:
        config.directives.push({ command, args, raw: line });
    }
  });

  // Silence the "assigned but never read" lint while keeping the intent clear:
  // the last profile/rateprofile directive in the file is the active one.
  void lastProfileLine;
  void lastRateProfileLine;

  return config;
}

function ensureBucket(map: Map<number, Map<string, string>>, index: number): Map<string, string> {
  let bucket = map.get(index);
  if (!bucket) {
    bucket = new Map();
    map.set(index, bucket);
  }
  return bucket;
}

function bucketFor(config: BetaflightConfig, scope: Scope): Map<string, string> {
  if (scope.kind === "master") return config.master;
  if (scope.kind === "profile") return ensureBucket(config.profiles, scope.index);
  return ensureBucket(config.rateProfiles, scope.index);
}

export function scopeKey(scope: Scope): string {
  return scope.kind === "master" ? "master" : `${scope.kind} ${scope.index}`;
}

/** Reads a setting, honouring the currently active profile / rate profile. */
export function getSetting(config: BetaflightConfig, key: string, scope?: Scope): string | undefined {
  const lower = key.toLowerCase();
  if (scope) return bucketFor(config, scope).get(lower);
  return (
    config.master.get(lower) ??
    config.profiles.get(config.activeProfile)?.get(lower) ??
    config.rateProfiles.get(config.activeRateProfile)?.get(lower)
  );
}

/** Where a key lives, so a change can be emitted under the right section. */
export function findScope(config: BetaflightConfig, key: string): Scope | null {
  const lower = key.toLowerCase();
  if (config.master.has(lower)) return { kind: "master" };
  for (const [index, bucket] of config.profiles) {
    if (bucket.has(lower)) return { kind: "profile", index };
  }
  for (const [index, bucket] of config.rateProfiles) {
    if (bucket.has(lower)) return { kind: "rateprofile", index };
  }
  return null;
}

export function flattenSettings(config: BetaflightConfig): Setting[] {
  const out: Setting[] = [];
  for (const [key, value] of config.master) out.push({ key, value, scope: { kind: "master" } });
  for (const [index, bucket] of config.profiles) {
    for (const [key, value] of bucket) out.push({ key, value, scope: { kind: "profile", index } });
  }
  for (const [index, bucket] of config.rateProfiles) {
    for (const [key, value] of bucket) {
      out.push({ key, value, scope: { kind: "rateprofile", index } });
    }
  }
  return out;
}

/** A compact, token-cheap rendering of the config for the model's context. */
export function summarizeForModel(config: BetaflightConfig, maxSettings = 400): string {
  const lines: string[] = [];
  if (config.firmwareLine) lines.push(`firmware: ${config.firmwareLine}`);
  if (config.boardName) lines.push(`board: ${config.manufacturerId}/${config.boardName}`);
  if (config.craftName) lines.push(`craft: ${config.craftName}`);
  if (config.mixer) lines.push(`mixer: ${config.mixer}`);
  const enabled = [...config.features].filter(([, on]) => on).map(([name]) => name);
  if (enabled.length) lines.push(`features: ${enabled.join(", ")}`);
  lines.push(`active profile: ${config.activeProfile}, rateprofile: ${config.activeRateProfile}`);

  const settings = flattenSettings(config);
  lines.push(`\n# non-default settings (${settings.length})`);
  for (const setting of settings.slice(0, maxSettings)) {
    lines.push(`${scopeKey(setting.scope)}: ${setting.key} = ${setting.value}`);
  }
  if (settings.length > maxSettings) {
    lines.push(`... ${settings.length - maxSettings} more settings omitted`);
  }

  const interesting = config.directives.filter((d) =>
    ["aux", "serial", "mixer", "rxrange", "vtx", "beeper"].includes(d.command),
  );
  if (interesting.length) {
    lines.push("\n# directives");
    for (const directive of interesting.slice(0, 60)) lines.push(directive.raw);
  }
  return lines.join("\n");
}
